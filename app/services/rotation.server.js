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
const MANUAL_REVIEW_MESSAGE = "Unable to uniquely identify old subscription instance. Manual review required.";

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
  { currentIndex = 0, purchasedProductIds = null, status = STATUS_ACTIVE } = {}
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

// ─── Rotation ─────────────────────────────────────────────────────────────────

async function rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin) {
  const activeItems = group.rotationItems;

  if (activeItems.length === 0) {
    await writeLog(shop, orderGid, instance, null, group, "SKIPPED", "No active rotation items");
    return;
  }

  const n = activeItems.length;

  // ── Select the next product, skipping ones already received by this subscription ──
  // purchasedProductIds (persisted on the instance) = numeric productIds this subscription
  // has already received (seeded from the first order / backfilled from history, then
  // appended to after each rotation). Walk forward from currentIndex to the first item NOT
  // yet received. If every rotation product has already been received (full cycle complete),
  // stop skipping and rotate normally — the cycle starts over and we stop checking.
  const purchased = new Set(parsePurchased(instance.purchasedProductIds));
  let selectedIndex = instance.currentIndex % n;
  if (purchased.size > 0) {
    let found = null;
    for (let step = 0; step < n; step++) {
      const idx = (instance.currentIndex + step) % n;
      const pid = toNumericId(activeItems[idx].productId);
      if (purchased.has(pid)) {
        console.log(`[rotation] order=${orderGid} skipping index=${idx} product=${pid} ("${activeItems[idx].productTitle}") — already received by this subscription`);
        continue;
      }
      found = idx;
      break;
    }
    if (found === null) {
      console.log(`[rotation] order=${orderGid} all rotation products already received by this subscription — rotating from scratch at index=${selectedIndex}`);
    } else {
      selectedIndex = found;
    }
  }

  const nextItem = activeItems[selectedIndex];
  const newIndex = (selectedIndex + 1) % n;
  const nextItemPid = toNumericId(nextItem.productId);
  console.log(`[rotation] order=${orderGid} selected rotation product index=${selectedIndex} productId=${nextItemPid} title="${nextItem.productTitle}"`);

  // Compute purchasedProductIds to persist on a successful rotation: append the selected
  // product; once the full set has been received, reset to [] so the next cycle rotates
  // from scratch and the skip check stops (per spec).
  const updatedPurchased = [...purchased, nextItemPid];
  const coversAll = activeItems.every((it) => updatedPurchased.includes(toNumericId(it.productId)));
  const newPurchasedJson = coversAll ? serializePurchased([]) : serializePurchased(updatedPurchased);
  if (coversAll) console.log(`[rotation] order=${orderGid} rotation cycle complete — purchased history reset`);

  if (nextItemPid === toNumericId(group.targetProductId)) {
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
    console.log(`[rotation] order=${orderGid} rotation item at index=${selectedIndex} is the target product — skipping self-rotation, advancing index`);
    await writeLog(shop, orderGid, instance, nextItem, group, "SKIPPED", "Rotation item is the target product — self-rotation skipped");
    return;
  }

  // ── Optimistic lock ────────────────────────────────────────────────────────
  // Atomically advance currentIndex, persist purchasedProductIds, AND record which order
  // we're processing. Two conditions must both be true for a run to win:
  //   1. currentIndex still matches what we read (prevents concurrent runs from
  //      claiming the same slot from different webhook deliveries at the same time)
  //   2. lastProcessedOrderId is different from this order (prevents sequential
  //      webhook retries from claiming a DIFFERENT slot — Run 1 advances 0→1,
  //      Run 2 arrives 7s later and would see index=1 and win slot 1→2 for the
  //      same order. With lastProcessedOrderId, Run 2 loses because Run 1 already
  //      stamped this order, even before writing the SUCCESS log.)
  // purchasedProductIds is written here and rolled back on failure — this gives the
  // required "append the selected productId after a successful rotation" behaviour.
  const claimed = await db.subscriptionInstance.updateMany({
    where: {
      id: instance.id,
      currentIndex: instance.currentIndex,
      OR: [{ lastProcessedOrderId: null }, { lastProcessedOrderId: { not: orderGid } }],
    },
    data: { currentIndex: newIndex, lastProcessedOrderId: orderGid, purchasedProductIds: newPurchasedJson },
  });

  if (claimed.count === 0) {
    console.log(`[rotation] order=${orderGid} rotation slot already claimed by concurrent run — skipping`);
    return;
  }

  console.log(`[rotation] order=${orderGid} claimed slot index=${selectedIndex}→${newIndex}`);

  // Roll currentIndex AND purchasedProductIds back to their pre-claim values.
  const rollback = () =>
    db.subscriptionInstance.update({
      where: { id: instance.id },
      data: { currentIndex: instance.currentIndex, purchasedProductIds: instance.purchasedProductIds ?? null },
    });

  try {
    await performOrderEdit({
      admin, orderGid, targetLineItems, nextItem, currency,
      freeRotation: group.freeRotation ?? false,
      keepTargetProduct: group.keepTargetProduct ?? false,
    });
    if (group.autoFulfill) {
      try {
        await autoFulfillRotationItems(admin, orderGid, nextItem.productId);
      } catch (fulfillErr) {
        console.warn(`[rotation] order=${orderGid} autoFulfill error (non-fatal): ${fulfillErr.message}`);
      }
    }
    await writeLog(shop, orderGid, instance, nextItem, group, "SUCCESS");
  } catch (err) {
    if (err.concurrent) {
      if (err.message.includes("Order already processed by concurrent webhook run")) {
        // Zero-out saw a conflicting change (rare with the DB lock). Roll back so
        // the next renewal retries at this slot.
        console.log(`[rotation] order=${orderGid} zero-out conflict (unexpected with lock) — rolling back index`);
        await rollback();
      } else {
        // Commit failed — order is likely already fulfilled (Shopify rejects removing
        // fulfilled line items). Retry as additive: add rotation product without
        // removing the original. Customer gets both; Digital Downloads fulfills the new item.
        console.warn(`[rotation] order=${orderGid} commit failed, retrying as additive edit`);
        try {
          await performOrderEdit({
            admin, orderGid, targetLineItems, nextItem, currency,
            freeRotation: group.freeRotation ?? false,
            keepTargetProduct: false,
            skipZeroOut: true,
          });
          if (group.autoFulfill) {
            try {
              await autoFulfillRotationItems(admin, orderGid, nextItem.productId);
            } catch (fulfillErr) {
              console.warn(`[rotation] order=${orderGid} autoFulfill error (non-fatal): ${fulfillErr.message}`);
            }
          }
          await writeLog(shop, orderGid, instance, nextItem, group, "SUCCESS",
            "Additive rotation — product added alongside fulfilled original");
          console.log(`[rotation] order=${orderGid} additive edit succeeded`);
        } catch (retryErr) {
          // Both attempts failed — roll back index so next renewal retries this slot
          console.warn(`[rotation] order=${orderGid} additive retry also failed: ${retryErr.message}`);
          await rollback();
          await writeLog(shop, orderGid, instance, nextItem, group, "FAILED",
            `Both edit attempts failed: ${retryErr.message}`);
        }
      }
      return;
    }
    // Unexpected error — roll back index and re-throw
    await rollback();
    await writeLog(shop, orderGid, instance, nextItem, group, "FAILED", err.message);
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
      // Seed purchasedProductIds with any rotation-group products already present in this
      // FIRST order, so the first renewal skips them instead of re-sending (spec #1).
      const seeded = (order.line_items ?? [])
        .map((li) => String(li.product_id))
        .filter((pid) => group.rotationItems.some((it) => toNumericId(it.productId) === pid));

      await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems, {
        purchasedProductIds: serializePurchased(seeded),
      });
      console.log(
        `[rotation] order=${orderId} → NEW subscription purchase, fresh SubscriptionInstance created` +
        (seeded.length ? ` (seeded already-received=[${seeded.join(", ")}])` : "")
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
            lineItems(first: 100) { nodes { quantity product { id } } }
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

// From the customer's orders, collect the rotation-group products already received.
// Scoped to subscription-related orders only — an order is counted if it is a Loop
// renewal OR it contains the target subscription product — so unrelated standalone
// purchases never suppress a rotation product. Returns numeric productIds.
function receivedRotationProductIds(customerOrders, group, excludeOrderNumericId) {
  const targetNumericId = toNumericId(group.targetProductId);
  const rotationIds = new Set(group.rotationItems.map((it) => toNumericId(it.productId)));
  const received = new Set();

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
      const pid = li.product?.id ? toNumericId(li.product.id) : null;
      if (pid && rotationIds.has(pid)) received.add(pid);
    }
  }
  return received;
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

        if (ambiguous) {
          instance = await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems, {
            status: STATUS_MANUAL,
            purchasedProductIds: serializePurchased([]),
          });
          console.warn(`[rotation/flow] order=${orderId} MANUAL REVIEW required — ${otherSubscriptions} other subscription(s), ${fpMatches.length} unlinked candidate(s) — instance=${instance.id}`);
          await writeLog(shop, orderGid, instance, null, group, "SKIPPED", MANUAL_REVIEW_MESSAGE);
          continue;
        }

        const orders = await loadCustomerOrders();
        const received = [...receivedRotationProductIds(orders, group, orderId)];
        console.log(`[rotation/flow] order=${orderId} backfill — products found in old order history=[${received.join(", ") || "none"}]`);

        instance = await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems, {
          currentIndex: 0,
          purchasedProductIds: serializePurchased(received),
        });
        console.log(`[rotation/flow] order=${orderId} backfill completed — created NEW instance=${instance.id} purchased=[${received.join(", ") || "none"}]`);
      }
    }

    // Flagged instance (now or previously) → never auto-edit (spec #6).
    if (instance.status === STATUS_MANUAL) {
      const flaggedAlready = await db.rotationLog.findFirst({ where: { shop, orderId: orderGid } });
      if (!flaggedAlready) await writeLog(shop, orderGid, instance, null, group, "SKIPPED", MANUAL_REVIEW_MESSAGE);
      console.warn(`[rotation/flow] order=${orderId} instance=${instance.id} flagged NEEDS_MANUAL_REVIEW — skipping rotation`);
      continue;
    }

    // Duplicate protection — flow/activate may be re-delivered for the same order.
    const alreadyLogged = await db.rotationLog.findFirst({
      where: { shop, orderId: orderGid, customerId: instance.customerId },
    });
    if (alreadyLogged) {
      console.log(`[rotation/flow] order=${orderId} already processed, skipping duplicate`);
      continue;
    }

    // Lazy backfill: instances created before purchasedProductIds existed (or any null)
    // get seeded from history once so the skip check has data.
    if (instance.purchasedProductIds == null) {
      const orders = await loadCustomerOrders();
      const received = [...receivedRotationProductIds(orders, group, orderId)];
      instance.purchasedProductIds = serializePurchased(received);
      await db.subscriptionInstance.update({ where: { id: instance.id }, data: { purchasedProductIds: instance.purchasedProductIds } });
      console.log(`[rotation/flow] order=${orderId} backfilled purchasedProductIds=[${received.join(", ") || "none"}] for existing instance=${instance.id}`);
    }

    console.log(`[rotation/flow] order=${orderId} → rotating instance=${instance.id} index=${instance.currentIndex} purchased=${instance.purchasedProductIds}`);
    await rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin);
  }

  pruneOldLogs(shop).catch((err) =>
    console.error(`[rotation/flow] pruneOldLogs error for ${shop}:`, err.message)
  );
}
