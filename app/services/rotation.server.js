/**
 * Core rotation logic.
 *
 * Two entry points:
 *   • processOrderWebhook(shop, order, admin)   — orders/create webhook.
 *       First order → create SubscriptionInstance. Renewal → DEFER (the order has no
 *       contract id, so it can't be routed to the right subscription here).
 *   • processRenewalForContract(shop, order, admin, contractId) — called by the Loop
 *       Flow endpoint (/api/subscription-contract-activated) on every renewal WITH the
 *       contract id. Routes strictly by contract id: same contract → same instance,
 *       new contract → fresh instance. This is where renewals actually rotate.
 */

import db from "../db.server.js";
import { performOrderEdit, autoFulfillRotationItems } from "./order-edit.server.js";

const STATUS_ACTIVE = "ACTIVE";
const STATUS_MANUAL = "NEEDS_MANUAL_REVIEW";
const MANUAL_REVIEW_MESSAGE = "Unable to uniquely identify old subscription instance. Manual review needed.";

// ─── Utilities ────────────────────────────────────────────────────────────────

function toNumericId(gid) {
  return String(gid).split("/").pop();
}

// purchasedProductIds is stored as a JSON array of numeric productId strings.
function parsePurchased(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function serializePurchased(ids) {
  return JSON.stringify([...new Set((ids ?? []).map(String))]);
}

// The "skip key" for a product, per the group's skipMatchBy setting:
//   PRODUCT_TITLE → lowercased, trimmed product title (matches across different product IDs
//                   that share a title — useful for old/duplicate products).
//   PRODUCT_ID    → numeric product id (default, exact).
function rotationKey(productIdOrGid, productTitle, mode) {
  if (mode === "PRODUCT_TITLE") return String(productTitle ?? "").toLowerCase().trim();
  return toNumericId(productIdOrGid);
}

function buildUniqueKey(shop, customerId, targetProductId, orderId) {
  return `${shop}:${customerId}:${toNumericId(targetProductId)}:${orderId}`;
}

// Fingerprint = sorted "variantId:qty,..." for the target product line items.
// Loop preserves the same variants + quantities in renewal orders as in the original purchase,
// so this reliably identifies which subscription a renewal belongs to.
function buildLineItemFingerprint(lineItems) {
  return lineItems
    .map((li) => `${li.variant_id}:${li.quantity}`)
    .sort()
    .join(",");
}

function extractContractId(order) {
  const pattern = /gid:\/\/shopify\/SubscriptionContract\/\d+/;
  for (const attr of order.note_attributes ?? []) {
    if (attr.value && pattern.test(String(attr.value))) return attr.value;
  }
  for (const li of order.line_items ?? []) {
    for (const prop of li.properties ?? []) {
      if (prop.value && pattern.test(String(prop.value))) return prop.value;
    }
  }
  return null;
}

// ─── Instance helpers ─────────────────────────────────────────────────────────

async function createSubscriptionInstance(
  shop, orderId, customerId, contractId, group, targetLineItems,
  { currentIndex = 0, purchasedProductIds = null, purchasedProductTitles = null, status = STATUS_ACTIVE } = {}
) {
  const uniqueKey = buildUniqueKey(shop, customerId, group.targetProductId, orderId);
  const fingerprint = buildLineItemFingerprint(targetLineItems);

  // upsert is not truly atomic in Prisma under concurrent writes — two simultaneous
  // runs can both miss the existing record and both attempt create, causing P2002.
  // Catch that and fall back to a plain findUnique.
  try {
    return await db.subscriptionInstance.upsert({
      where: { uniqueKey },
      update: {},
      create: {
        shop,
        customerId,
        originalOrderId: orderId,
        subscriptionContractId: contractId ?? null,
        targetProductId: group.targetProductId,
        currentIndex,
        uniqueKey,
        lineItemFingerprint: fingerprint,
        purchasedProductIds,
        purchasedProductTitles,
        status,
        rotationGroupId: group.id,
      },
    });
  } catch (err) {
    if (err.code === "P2002") {
      // Another concurrent run already created this instance — return it
      const existing = await db.subscriptionInstance.findUnique({ where: { uniqueKey } });
      if (existing) return existing;
    }
    throw err;
  }
}

// ─── Log helpers ──────────────────────────────────────────────────────────────

async function writeLog(shop, orderId, instance, rotationItem, group, status, message = null) {
  await db.rotationLog.create({
    data: {
      shop,
      orderId,
      customerId: instance.customerId,
      targetProductTitle: group.targetProductTitle,
      rotationProductTitle: rotationItem?.productTitle ?? "",
      status,
      message,
    },
  });
}

/**
 * Keep logs lean: delete rows older than 7 days AND keep at most 50 per shop.
 * Called once per webhook after all processing completes.
 */
async function pruneOldLogs(shop) {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  await db.rotationLog.deleteMany({
    where: { shop, createdAt: { lt: cutoff } },
  });

  const overflow = await db.rotationLog.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    skip: 50,
    select: { id: true },
  });

  if (overflow.length > 0) {
    await db.rotationLog.deleteMany({
      where: { id: { in: overflow.map((r) => r.id) } },
    });
  }
}

// ─── Batches (renewal steps) ────────────────────────────────────────────────────
//
// A "renewal step" (batch) is a set of rotation products sent together in ONE renewal.
// Items sharing the same step are added to the same renewal order.
//
// stepOf(item) = item.stepIndex ?? item.sortOrder. New/edited groups store an explicit
// stepIndex; legacy items (stepIndex null) fall back to sortOrder, so each legacy item
// becomes its own singleton batch — preserving the original one-product-per-renewal
// behaviour with no data migration.
function stepOf(item) {
  return item.stepIndex != null ? item.stepIndex : item.sortOrder;
}

// Group active rotation items into ordered batches.
//   - batches ordered by stepOf ascending
//   - items within a batch ordered by sortOrder ascending
// Returns Batch[] where each Batch = { items: RotationItem[] }.
function buildBatches(items) {
  const byStep = new Map();
  for (const item of items) {
    const key = stepOf(item);
    if (!byStep.has(key)) byStep.set(key, []);
    byStep.get(key).push(item);
  }
  return [...byStep.keys()]
    .sort((a, b) => a - b)
    .map((k) => ({ items: byStep.get(k).slice().sort((a, b) => a.sortOrder - b.sortOrder) }));
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

async function rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin) {
  const activeItems = group.rotationItems;

  if (activeItems.length === 0) {
    await writeLog(shop, orderGid, instance, null, group, "SKIPPED", "No active rotation items");
    return;
  }

  // currentIndex now indexes BATCHES (renewal steps), not individual items. A batch with
  // a single product behaves exactly like the old single-product rotation.
  const batches = buildBatches(activeItems);
  const n = batches.length;

  // ── Select the next batch, skipping ones already received by this subscription ──
  // purchasedProductIds/Titles (persisted on the instance) = products this subscription has
  // already received. skipMatchBy controls how "already received" is matched (by product id
  // or by lowercased title). A BATCH counts as received only when ALL of its products are in
  // the purchased set. Walk forward from currentIndex to the first batch NOT fully received.
  // If every batch has already been received (full cycle complete), stop skipping and rotate
  // normally — the cycle starts over.
  const mode = group.skipMatchBy ?? "PRODUCT_ID";
  const idOf = (item) => toNumericId(item.productId);
  const titleOf = (item) => String(item.productTitle ?? "").toLowerCase().trim();
  const keyOf = (item) => (mode === "PRODUCT_TITLE" ? titleOf(item) : idOf(item));

  const purchasedIds = new Set(parsePurchased(instance.purchasedProductIds));
  const purchasedTitles = new Set(parsePurchased(instance.purchasedProductTitles));
  const purchasedActive = mode === "PRODUCT_TITLE" ? purchasedTitles : purchasedIds;

  const batchReceived = (batch) => batch.items.every((it) => purchasedActive.has(keyOf(it)));

  // skipEnabled OFF → don't check already-received; rotate strictly by currentIndex (sequential).
  // skipEnabled ON  → skip fully-received batches and send the next not-yet-received one.
  const skipEnabled = group.skipEnabled ?? true;
  let selectedIndex = instance.currentIndex % n;
  if (skipEnabled && purchasedActive.size > 0) {
    let found = null;
    for (let step = 0; step < n; step++) {
      const idx = (instance.currentIndex + step) % n;
      if (batchReceived(batches[idx])) {
        console.log(`[rotation] order=${orderGid} skipping batch index=${idx} — all products already received by this subscription`);
        continue;
      }
      found = idx;
      break;
    }
    if (found === null) {
      console.log(`[rotation] order=${orderGid} all rotation batches already received by this subscription — rotating from scratch at index=${selectedIndex}`);
    } else {
      selectedIndex = found;
    }
  }

  const selectedBatch = batches[selectedIndex];
  const newIndex = (selectedIndex + 1) % n;
  const targetNumericId = toNumericId(group.targetProductId);

  // Self-rotation guard: drop any item that IS the target product (a product accidentally
  // added to its own rotation). Only the remaining products are actually sent.
  const batchItems = selectedBatch.items.filter((it) => idOf(it) !== targetNumericId);
  const sentTitleStr = batchItems.map((it) => it.productTitle).join(", ");
  const batchLog = { productTitle: sentTitleStr };

  console.log(`[rotation] order=${orderGid} selected batch index=${selectedIndex} products=[${selectedBatch.items.map((it) => `${idOf(it)}:"${it.productTitle}"`).join(", ")}] skipMatchBy=${mode}`);

  // Whole batch was just the target product → nothing to send. Advance index + log SKIPPED.
  if (batchItems.length === 0) {
    const claimed = await db.subscriptionInstance.updateMany({
      where: {
        id: instance.id,
        currentIndex: instance.currentIndex,
        OR: [{ lastProcessedOrderId: null }, { lastProcessedOrderId: { not: orderGid } }],
      },
      data: { currentIndex: newIndex, lastProcessedOrderId: orderGid },
    });
    if (claimed.count === 0) {
      console.log(`[rotation] order=${orderGid} self-rotation slot already claimed by concurrent or sequential run`);
      return;
    }
    console.log(`[rotation] order=${orderGid} batch at index=${selectedIndex} contains only the target product — skipping self-rotation, advancing index`);
    await writeLog(shop, orderGid, instance, { productTitle: selectedBatch.items[0]?.productTitle ?? "" }, group, "SKIPPED", "Rotation batch is the target product — self-rotation skipped");
    return;
  }

  // On a successful rotation, append every sent product to BOTH lists. Once the full set of
  // all sendable rotation products has been received, reset both to [] so the next cycle
  // rotates from scratch (per spec). Target-product items never get sent, so they're excluded
  // from the "covers all" check (otherwise it could never complete).
  const allSendableItems = activeItems.filter((it) => idOf(it) !== targetNumericId);
  const sentIds = batchItems.map(idOf);
  const sentTitles = batchItems.map(titleOf);
  const updatedIds = [...purchasedIds, ...sentIds];
  const updatedTitles = [...purchasedTitles, ...sentTitles];
  const coversAll = allSendableItems.every((it) =>
    mode === "PRODUCT_TITLE" ? updatedTitles.includes(titleOf(it)) : updatedIds.includes(idOf(it))
  );
  const newIdsJson    = coversAll ? serializePurchased([]) : serializePurchased(updatedIds);
  const newTitlesJson = coversAll ? serializePurchased([]) : serializePurchased(updatedTitles);
  if (coversAll) console.log(`[rotation] order=${orderGid} rotation cycle complete — purchased history reset`);

  // ── Optimistic lock ────────────────────────────────────────────────────────
  // Atomically advance currentIndex, persist the purchased lists, AND record which order
  // we're processing. Two conditions must both be true for a run to win:
  //   1. currentIndex still matches what we read (prevents concurrent runs from
  //      claiming the same slot from different webhook deliveries at the same time)
  //   2. lastProcessedOrderId is different from this order (prevents sequential
  //      webhook retries from claiming a DIFFERENT slot — Run 1 advances 0→1,
  //      Run 2 arrives 7s later and would see index=1 and win slot 1→2 for the
  //      same order. With lastProcessedOrderId, Run 2 loses because Run 1 already
  //      stamped this order, even before writing the SUCCESS log.)
  // The purchased lists are written here and rolled back on failure.
  const claimed = await db.subscriptionInstance.updateMany({
    where: {
      id: instance.id,
      currentIndex: instance.currentIndex,
      OR: [{ lastProcessedOrderId: null }, { lastProcessedOrderId: { not: orderGid } }],
    },
    data: { currentIndex: newIndex, lastProcessedOrderId: orderGid, purchasedProductIds: newIdsJson, purchasedProductTitles: newTitlesJson },
  });

  if (claimed.count === 0) {
    console.log(`[rotation] order=${orderGid} rotation slot already claimed by concurrent run — skipping`);
    return;
  }

  console.log(`[rotation] order=${orderGid} claimed slot index=${selectedIndex}→${newIndex} (${batchItems.length} product${batchItems.length !== 1 ? "s" : ""})`);

  // Roll currentIndex AND both purchased lists back to their pre-claim values.
  const rollback = () =>
    db.subscriptionInstance.update({
      where: { id: instance.id },
      data: {
        currentIndex: instance.currentIndex,
        purchasedProductIds: instance.purchasedProductIds ?? null,
        purchasedProductTitles: instance.purchasedProductTitles ?? null,
      },
    });

  // Manual-review subscriptions STILL rotate (so the customer gets the products) but are
  // left UNFULFILLED and logged as MANUAL so a human can verify before fulfilling (spec #6).
  const isManual = instance.status === STATUS_MANUAL;
  const successStatus = isManual ? "MANUAL" : "SUCCESS";

  // Auto-fulfill the sent products whose effective auto-fulfill (item override, else group
  // default) is on — all in ONE call (see autoFulfillRotationItems for why per-product calls
  // break multi-product batches). Never auto-fulfill a manual-review order.
  const fulfillBatch = async () => {
    if (isManual) {
      console.log(`[rotation] order=${orderGid} NEEDS_MANUAL_REVIEW — rotation products added but left UNFULFILLED`);
      return;
    }
    // Pass product id AND title: real-product lines fulfill by product id, custom
    // price-override lines (cheaper products) fulfill by title (they have no product).
    const fulfillTargets = batchItems
      .filter((item) => (item.autoFulfill ?? group.autoFulfill ?? false))
      .map((item) => ({ productId: item.productId, title: item.productTitle }));
    if (fulfillTargets.length === 0) return;
    try {
      await autoFulfillRotationItems(admin, orderGid, fulfillTargets);
    } catch (fulfillErr) {
      console.warn(`[rotation] order=${orderGid} autoFulfill error (non-fatal): ${fulfillErr.message}`);
    }
  };

  try {
    await performOrderEdit({
      admin, orderGid, targetLineItems, batch: batchItems, currency,
      freeRotation: group.freeRotation ?? false,
      keepTargetProduct: group.keepTargetProduct ?? false,
    });
    await fulfillBatch();
    await writeLog(shop, orderGid, instance, batchLog, group, successStatus, isManual ? MANUAL_REVIEW_MESSAGE : null);
  } catch (err) {
    if (err.concurrent) {
      if (err.message.includes("Order already processed by concurrent webhook run")) {
        // Zero-out saw a conflicting change (rare with the DB lock). Roll back so
        // the next renewal retries at this slot.
        console.log(`[rotation] order=${orderGid} zero-out conflict (unexpected with lock) — rolling back index`);
        await rollback();
      } else {
        // Commit failed — order is likely already fulfilled (Shopify rejects removing
        // fulfilled line items). Retry as additive: add rotation products without
        // removing the original. Customer gets both; Digital Downloads fulfills the new items.
        console.warn(`[rotation] order=${orderGid} commit failed, retrying as additive edit`);
        try {
          await performOrderEdit({
            admin, orderGid, targetLineItems, batch: batchItems, currency,
            freeRotation: group.freeRotation ?? false,
            keepTargetProduct: false,
            skipZeroOut: true,
          });
          await fulfillBatch();
          await writeLog(shop, orderGid, instance, batchLog, group, successStatus,
            isManual ? MANUAL_REVIEW_MESSAGE : "Additive rotation — products added alongside fulfilled original");
          console.log(`[rotation] order=${orderGid} additive edit succeeded`);
        } catch (retryErr) {
          // Both attempts failed — roll back index so next renewal retries this slot
          console.warn(`[rotation] order=${orderGid} additive retry also failed: ${retryErr.message}`);
          await rollback();
          await writeLog(shop, orderGid, instance, batchLog, group, "FAILED",
            `Both edit attempts failed: ${retryErr.message}`);
        }
      }
      return;
    }
    // Unexpected error — roll back index and re-throw
    await rollback();
    await writeLog(shop, orderGid, instance, batchLog, group, "FAILED", err.message);
    throw err;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processOrderWebhook(shop, order, admin) {
  await db.shopSetting.upsert({ where: { shop }, create: { shop }, update: {} });

  const customerId = String(order.customer?.id ?? "anonymous");
  const orderId    = String(order.id);
  const contractId = extractContractId(order);

  const sourceIsLoopRenewal = order.source_name === "subscription_contract_checkout_one";

  console.log(`[rotation] order=${orderId} source_name=${order.source_name} customer=${customerId} contractId=${contractId ?? "none"}`);

  const groups = await db.rotationGroup.findMany({
    where: { shop, isActive: true },
    include: {
      rotationItems: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
    },
  });

  if (groups.length === 0) {
    console.log(`[rotation] no active groups for shop=${shop}, skipping`);
    return;
  }

  for (const group of groups) {
    const targetNumericId = toNumericId(group.targetProductId);
    const targetLineItems = (order.line_items ?? []).filter(
      (li) => String(li.product_id) === targetNumericId
    );

    if (targetLineItems.length === 0) continue;

    console.log(`[rotation] order=${orderId} matched group=${group.id} product=${group.targetProductId} lineItems=${targetLineItems.length}`);

    if (!sourceIsLoopRenewal) {
      // New subscription purchase — create a fresh independent instance with fingerprint.
      // Do NOT edit first online orders. Do NOT cancel other active instances.
      // Real cancellations are handled by the subscription-contracts/cancel webhook.
      //
      // Seed the purchased lists with any rotation-group products already present in this
      // FIRST order, so the first renewal skips them instead of re-sending (spec #1).
      // Match in the group's skipMatchBy form, but record both id + title.
      const seedMode = group.skipMatchBy ?? "PRODUCT_ID";
      const seedItemByKey = new Map(group.rotationItems.map((it) => [rotationKey(it.productId, it.productTitle, seedMode), it]));
      const seededItems = new Map();
      for (const li of order.line_items ?? []) {
        const item = seedItemByKey.get(rotationKey(li.product_id, li.title, seedMode));
        if (item) seededItems.set(toNumericId(item.productId), item);
      }
      const seeds = [...seededItems.values()];
      const seededIds = seeds.map((it) => toNumericId(it.productId));
      const seededTitles = seeds.map((it) => String(it.productTitle ?? "").toLowerCase().trim());

      await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems, {
        purchasedProductIds: serializePurchased(seededIds),
        purchasedProductTitles: serializePurchased(seededTitles),
      });
      console.log(
        `[rotation] order=${orderId} → NEW subscription purchase, fresh SubscriptionInstance created` +
        (seeds.length ? ` (seeded already-received ids=[${seededIds.join(", ")}] titles=[${seededTitles.join(", ")}])` : "")
      );
      continue;
    }

    // ── Loop renewal order ────────────────────────────────────────────────────
    // Renewals are NOT rotated here. The renewal order payload does NOT contain the
    // subscription contract id, so this webhook cannot tell two same-product
    // subscriptions of the same customer apart. Rotation is driven instead by
    // /api/subscription-contract-activated (Loop Flow), which fires on every renewal
    // WITH the contract id (+ order id) → see processRenewalForContract(). That is the
    // only place a renewal can be routed to the correct subscription instance.
    console.log(`[rotation] order=${orderId} renewal — deferring to flow/activate (contract-authoritative rotation)`);
    continue;
  }

  pruneOldLogs(shop).catch((err) =>
    console.error(`[rotation] pruneOldLogs error for ${shop}:`, err.message)
  );
}

// ─── Flow-driven renewal rotation (contract-authoritative) ──────────────────────
//
// Loop renewal orders do NOT carry the subscription contract id, so the orders/create
// webhook cannot route a renewal to the right subscription. Instead, the Loop Flow
// calls /api/subscription-contract-activated on EVERY renewal with the contract id AND
// the order id. That endpoint fetches the order and calls processRenewalForContract(),
// which finds the instance strictly by contract id (or creates a fresh one), so two
// subscriptions of the same customer + product stay completely separate.

// Fetch a renewal order from the Admin API and shape it like the orders/create webhook
// payload (snake_case) so the existing rotation + order-edit code can consume it.
export async function fetchOrderForRotation(admin, orderNumericId) {
  const orderGid = `gid://shopify/Order/${orderNumericId}`;
  const res = await admin.graphql(`
    query OrderForRotation($id: ID!) {
      order(id: $id) {
        id
        sourceName
        currencyCode
        presentmentCurrencyCode
        customer { id }
        lineItems(first: 100) {
          nodes {
            quantity
            variantTitle
            variant { id }
            product { id }
            originalUnitPriceSet { presentmentMoney { amount currencyCode } }
            discountAllocations { allocatedAmountSet { presentmentMoney { amount } } }
          }
        }
      }
    }
  `, { variables: { id: orderGid } });

  const data = await res.json();
  const o = data?.data?.order;
  if (!o) return null;

  const numeric = (gid) => String(gid ?? "").split("/").pop();

  return {
    id: numeric(o.id),
    source_name: o.sourceName,
    currency: o.presentmentCurrencyCode ?? o.currencyCode ?? "USD",
    customer: { id: o.customer?.id ? numeric(o.customer.id) : null },
    note_attributes: [],
    line_items: (o.lineItems?.nodes ?? []).map((li) => {
      const unit = li.originalUnitPriceSet?.presentmentMoney?.amount ?? "0";
      return {
        product_id: li.product?.id ? numeric(li.product.id) : null,
        variant_id: li.variant?.id ? numeric(li.variant.id) : null,
        quantity: li.quantity,
        variant_title: li.variantTitle,
        properties: [],
        price: unit,
        price_set: { presentment_money: { amount: unit } },
        discount_allocations: (li.discountAllocations ?? []).map((d) => ({
          amount_set: { presentment_money: { amount: d.allocatedAmountSet?.presentmentMoney?.amount ?? "0" } },
        })),
      };
    }),
  };
}

// Fetch the customer's recent orders (light) for the "already received" skip check.
// We use read_orders here instead of reading the Loop-owned SubscriptionContract — our
// `read_own_subscription_contracts` scope can't read contracts another app created, so
// subscriptionContract(id) returns null. Orders are always readable.
async function fetchCustomerOrdersLight(admin, customerNumericId, max = 100) {
  const orders = [];
  let cursor = null;
  while (orders.length < max) {
    const res = await admin.graphql(`
      query CustomerOrders($q: String!, $cursor: String) {
        orders(first: 50, after: $cursor, query: $q, sortKey: CREATED_AT, reverse: true) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            sourceName
            lineItems(first: 100) { nodes { quantity title product { id } } }
          }
        }
      }
    `, { variables: { q: `customer_id:${customerNumericId}`, cursor } });

    const data = await res.json();
    const conn = data?.data?.orders;
    if (!conn) break;
    orders.push(...(conn.nodes ?? []));
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return orders;
}

// From the customer's orders, collect which rotation-group products were already received
// and return BOTH their numeric ids and their lowercased titles (so both columns stay
// populated regardless of match mode). Matching is done in the group's skipMatchBy mode,
// then resolved back to the canonical rotation item's id + title. Scoped to
// subscription-related orders only — an order counts if it is a Loop renewal OR it
// contains the target subscription product — so unrelated standalone purchases don't count.
function receivedRotationProducts(customerOrders, group, excludeOrderNumericId) {
  const mode = group.skipMatchBy ?? "PRODUCT_ID";
  const targetNumericId = toNumericId(group.targetProductId);
  const itemByKey = new Map(group.rotationItems.map((it) => [rotationKey(it.productId, it.productTitle, mode), it]));
  const receivedItems = new Map(); // numeric id → rotation item (dedup)

  for (const o of customerOrders) {
    if (excludeOrderNumericId && toNumericId(o.id) === toNumericId(excludeOrderNumericId)) continue;

    const items = o.lineItems?.nodes ?? [];
    const containsTarget = items.some(
      (li) => li.product?.id && toNumericId(li.product.id) === targetNumericId
    );
    const isRenewal = o.sourceName === "subscription_contract_checkout_one";
    if (!containsTarget && !isRenewal) continue; // not subscription-related

    for (const li of items) {
      if ((li.quantity ?? 0) <= 0) continue;
      const item = itemByKey.get(rotationKey(li.product?.id, li.title, mode));
      if (item) receivedItems.set(toNumericId(item.productId), item);
    }
  }

  const items = [...receivedItems.values()];
  return {
    ids: items.map((it) => toNumericId(it.productId)),
    titles: items.map((it) => String(it.productTitle ?? "").toLowerCase().trim()),
  };
}

// Rotate a renewal order, routing strictly by subscription contract id.
//   - An ACTIVE instance with this contract id → continue its rotation.
//   - No instance for this contract id → create a fresh one (new subscription).
// This is what guarantees: same contract → same instance; different contract → new
// instance, even for two identical same-product subscriptions of one customer.
export async function processRenewalForContract(shop, order, admin, contractId) {
  await db.shopSetting.upsert({ where: { shop }, create: { shop }, update: {} });

  const customerId = String(order.customer?.id ?? "anonymous");
  const orderId    = String(order.id);
  const orderGid   = `gid://shopify/Order/${orderId}`;
  const currency   = order.currency ?? "USD";

  console.log(`[rotation/flow] order=${orderId} contractId=${contractId} customer=${customerId} source=${order.source_name}`);

  const groups = await db.rotationGroup.findMany({
    where: { shop, isActive: true },
    include: { rotationItems: { where: { isActive: true }, orderBy: { sortOrder: "asc" } } },
  });

  if (groups.length === 0) {
    console.log(`[rotation/flow] no active groups for shop=${shop}, skipping`);
    return;
  }

  // The customer's orders, fetched lazily once and reused, for backfill of old subscriptions.
  let customerOrders = null;
  const loadCustomerOrders = async () => {
    if (customerOrders === null) {
      customerOrders = await fetchCustomerOrdersLight(admin, customerId);
      console.log(`[rotation/flow] order=${orderId} fetched ${customerOrders.length} customer orders for backfill`);
    }
    return customerOrders;
  };

  for (const group of groups) {
    const targetNumericId = toNumericId(group.targetProductId);
    const targetLineItems = (order.line_items ?? []).filter(
      (li) => String(li.product_id) === targetNumericId
    );

    if (targetLineItems.length === 0) continue;

    console.log(`[rotation/flow] order=${orderId} matched group=${group.id} product=${group.targetProductId} lineItems=${targetLineItems.length}`);

    // ── Resolve the SubscriptionInstance (matching priority) ───────────────────
    // 1) Exact subscription contract id → same subscription, continue its rotation.
    let instance = await db.subscriptionInstance.findFirst({
      where: { shop, subscriptionContractId: contractId, targetProductId: group.targetProductId, status: { in: [STATUS_ACTIVE, STATUS_MANUAL] } },
    });

    if (instance) {
      console.log(`[rotation/flow] order=${orderId} EXISTING SubscriptionInstance matched id=${instance.id} by contractId=${contractId} index=${instance.currentIndex} status=${instance.status}`);
    } else {
      // 2) Adopt a single UNLINKED instance — a first-order instance created by
      //    orders/create whose contract id isn't bound yet (matched by fingerprint).
      const fp = buildLineItemFingerprint(targetLineItems);
      const unlinked = await db.subscriptionInstance.findMany({
        where: { shop, customerId, targetProductId: group.targetProductId, subscriptionContractId: null, status: STATUS_ACTIVE },
        orderBy: { createdAt: "desc" },
      });
      const fpMatches = unlinked.filter((i) => !i.lineItemFingerprint || i.lineItemFingerprint === fp);

      if (fpMatches.length === 1) {
        instance = await db.subscriptionInstance.update({
          where: { id: fpMatches[0].id },
          data: { subscriptionContractId: contractId },
        });
        console.log(`[rotation/flow] order=${orderId} linked contractId=${contractId} to first-order instance=${instance.id} index=${instance.currentIndex}`);
      } else {
        // 3) No instance for this subscription → an OLD subscription that existed before
        //    the app was installed. Backfill from history, with the multi-subscription
        //    safety rule (spec #6).
        console.log(`[rotation/flow] order=${orderId} MISSING SubscriptionInstance for old renewal contractId=${contractId} — backfill started`);

        // Ambiguous when we cannot uniquely identify this old subscription: another
        // subscription (different already-linked contract) exists for this customer+product,
        // OR more than one unlinked candidate matches the fingerprint.
        const otherSubscriptions = await db.subscriptionInstance.count({
          where: {
            shop, customerId, targetProductId: group.targetProductId,
            subscriptionContractId: { not: null },
            NOT: { subscriptionContractId: contractId },
            status: { in: [STATUS_ACTIVE, STATUS_MANUAL] },
          },
        });
        const ambiguous = otherSubscriptions > 0 || fpMatches.length > 1;

        // Backfill the already-received products from history either way, so the skip
        // logic works for the manual-review case too.
        const orders = await loadCustomerOrders();
        const received = receivedRotationProducts(orders, group, orderId);
        console.log(`[rotation/flow] order=${orderId} backfill — products found in old order history: ids=[${received.ids.join(", ") || "none"}] titles=[${received.titles.join(", ") || "none"}]`);

        instance = await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems, {
          currentIndex: 0,
          status: ambiguous ? STATUS_MANUAL : STATUS_ACTIVE,
          purchasedProductIds: serializePurchased(received.ids),
          purchasedProductTitles: serializePurchased(received.titles),
        });

        if (ambiguous) {
          // Spec #6: we cannot uniquely identify which old subscription this is, so flag it
          // for manual review — but STILL rotate the order (with the skip logic). rotateOrderItems
          // logs it as MANUAL and leaves the rotation product UNFULFILLED for a human to verify.
          console.warn(`[rotation/flow] order=${orderId} MANUAL REVIEW needed — ${otherSubscriptions} other subscription(s), ${fpMatches.length} unlinked candidate(s) — rotating but leaving UNFULFILLED — instance=${instance.id}`);
        } else {
          console.log(`[rotation/flow] order=${orderId} backfill completed — created NEW instance=${instance.id}`);
        }
      }
    }

    // NOTE: a NEEDS_MANUAL_REVIEW instance is NOT skipped — it still rotates (unfulfilled),
    // and rotateOrderItems writes the MANUAL RotationLog. See spec #6.

    // Duplicate protection — flow/activate may be re-delivered for the same order.
    const alreadyLogged = await db.rotationLog.findFirst({
      where: { shop, orderId: orderGid, customerId: instance.customerId },
    });
    if (alreadyLogged) {
      console.log(`[rotation/flow] order=${orderId} already processed, skipping duplicate`);
      continue;
    }

    // Lazy backfill: instances created before these columns existed (either null) get
    // seeded from history once so the skip check has data — this also migrates legacy rows
    // that stored a title in purchasedProductIds, by recomputing both columns cleanly.
    if (instance.purchasedProductIds == null || instance.purchasedProductTitles == null) {
      const orders = await loadCustomerOrders();
      const received = receivedRotationProducts(orders, group, orderId);
      instance.purchasedProductIds = serializePurchased(received.ids);
      instance.purchasedProductTitles = serializePurchased(received.titles);
      await db.subscriptionInstance.update({
        where: { id: instance.id },
        data: { purchasedProductIds: instance.purchasedProductIds, purchasedProductTitles: instance.purchasedProductTitles },
      });
      console.log(`[rotation/flow] order=${orderId} backfilled existing instance=${instance.id} ids=[${received.ids.join(", ") || "none"}] titles=[${received.titles.join(", ") || "none"}]`);
    }

    console.log(`[rotation/flow] order=${orderId} → rotating instance=${instance.id} index=${instance.currentIndex} ids=${instance.purchasedProductIds} titles=${instance.purchasedProductTitles}`);
    await rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin);
  }

  pruneOldLogs(shop).catch((err) =>
    console.error(`[rotation/flow] pruneOldLogs error for ${shop}:`, err.message)
  );
}
