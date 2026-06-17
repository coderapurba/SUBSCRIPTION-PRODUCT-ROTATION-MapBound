/**
 * Core rotation logic.
 *
 * Entry point: processOrderWebhook(shop, order, admin)
 *
 * First order  → create SubscriptionInstance with line item fingerprint
 * Renewal order → find instance by contractId → fingerprint → recency fallback → rotate → prune logs
 */

import db from "../db.server.js";
import { performOrderEdit } from "./order-edit.server.js";

// ─── Utilities ────────────────────────────────────────────────────────────────

function toNumericId(gid) {
  return String(gid).split("/").pop();
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

async function createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems) {
  const uniqueKey = buildUniqueKey(shop, customerId, group.targetProductId, orderId);
  const fingerprint = buildLineItemFingerprint(targetLineItems);

  // upsert is atomic — safe when Shopify delivers the same webhook twice concurrently
  return db.subscriptionInstance.upsert({
    where: { uniqueKey },
    update: {},
    create: {
      shop,
      customerId,
      originalOrderId: orderId,
      subscriptionContractId: contractId ?? null,
      targetProductId: group.targetProductId,
      currentIndex: 0,
      uniqueKey,
      lineItemFingerprint: fingerprint,
      status: "ACTIVE",
      rotationGroupId: group.id,
    },
  });
}

async function findRenewalInstance(shop, customerId, targetProductId, contractId, renewalLineItems) {
  // Primary: exact match by contract ID
  if (contractId) {
    const inst = await db.subscriptionInstance.findFirst({
      where: { shop, subscriptionContractId: contractId, targetProductId, status: "ACTIVE" },
    });
    if (inst) return inst;
    console.warn(`[rotation] No ACTIVE instance for contractId=${contractId}. Falling back to fingerprint lookup.`);
  }

  const renewalFingerprint = buildLineItemFingerprint(renewalLineItems);

  const instances = await db.subscriptionInstance.findMany({
    where: { shop, customerId, targetProductId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });

  if (instances.length === 0) return null;

  // Single instance: if fingerprint stored and doesn't match, this renewal belongs to a
  // different subscription (the matching instance hasn't been created yet)
  if (instances.length === 1) {
    const inst = instances[0];
    if (inst.lineItemFingerprint && inst.lineItemFingerprint !== renewalFingerprint) {
      console.warn(
        `[rotation] customer=${customerId} single instance=${inst.id} fingerprint mismatch — ` +
        `renewal fingerprint=${renewalFingerprint} vs stored=${inst.lineItemFingerprint}. ` +
        `Treating as new subscription.`
      );
      return null;
    }
    return inst;
  }

  // Multiple instances — match by fingerprint
  const matched = instances.find((i) => i.lineItemFingerprint === renewalFingerprint);
  if (matched) {
    console.log(`[rotation] customer=${customerId} matched instance=${matched.id} by fingerprint=${renewalFingerprint}`);
    return matched;
  }

  // No fingerprint match — check for legacy instances (null fingerprint)
  const untagged = instances.filter((i) => !i.lineItemFingerprint);
  if (untagged.length === 1) {
    // Exactly one legacy instance: assign this fingerprint to it and use it
    await db.subscriptionInstance.update({
      where: { id: untagged[0].id },
      data: { lineItemFingerprint: renewalFingerprint },
    });
    console.log(`[rotation] customer=${customerId} assigned fingerprint to legacy instance=${untagged[0].id}`);
    return untagged[0];
  }

  // Multiple untagged instances — cannot reliably distinguish, use most-recent
  console.warn(
    `[rotation] customer=${customerId} has ${instances.length} active instances for product=${targetProductId}, ` +
    `fingerprint=${renewalFingerprint} unmatched (${untagged.length} untagged). ` +
    `Using most-recent=${instances[0].id}. ` +
    `Fix: delete stale SubscriptionInstance rows and re-test.`
  );
  return instances[0];
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

  const nextIndex = instance.currentIndex % activeItems.length;
  const nextItem  = activeItems[nextIndex];
  const newIndex  = (nextIndex + 1) % activeItems.length;

  if (toNumericId(nextItem.productId) === toNumericId(group.targetProductId)) {
    console.log(`[rotation] order=${orderGid} rotation item at index=${nextIndex} is the target product — skipping self-rotation, advancing index`);
    await db.subscriptionInstance.update({ where: { id: instance.id }, data: { currentIndex: newIndex } });
    await writeLog(shop, orderGid, instance, nextItem, group, "SKIPPED", "Rotation item is the target product — self-rotation skipped");
    return;
  }

  try {
    await performOrderEdit({ admin, orderGid, targetLineItems, nextItem, currency, freeRotation: group.freeRotation ?? false, keepTargetProduct: group.keepTargetProduct ?? false });

    await db.subscriptionInstance.update({
      where: { id: instance.id },
      data: { currentIndex: newIndex },
    });

    await writeLog(shop, orderGid, instance, nextItem, group, "SUCCESS");
  } catch (err) {
    if (err.concurrent) {
      if (err.message.includes("Order already processed by concurrent webhook run")) {
        // Zero-out detected another run already modified the order — that run will commit.
        console.log(`[rotation] order=${orderGid} skipped — concurrent run has the lock`);
      } else {
        // Commit was rejected — could be a genuine concurrent conflict (one run succeeds,
        // others hit this) OR the order is no longer editable (fulfilled, archived, etc.).
        // Write a FAILED log so it appears in the Rotation Logs UI for investigation.
        console.warn(`[rotation] order=${orderGid} commit failed — ${err.message}`);
        await writeLog(shop, orderGid, instance, nextItem, group, "FAILED",
          `Order edit rejected by Shopify (may be fulfilled/archived): ${err.message}`);
      }
      return;
    }
    await writeLog(shop, orderGid, instance, nextItem, group, "FAILED", err.message);
    throw err;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function processOrderWebhook(shop, order, admin) {
  await db.shopSetting.upsert({ where: { shop }, create: { shop }, update: {} });

  const customerId = String(order.customer?.id ?? "anonymous");
  const orderId    = String(order.id);
  const orderGid   = `gid://shopify/Order/${orderId}`;
  const contractId = extractContractId(order);
  const currency   = order.currency ?? "USD";

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
      // Do NOT cancel other active instances — each purchase tracks its own rotation index.
      // Real cancellations are handled by the subscription-contracts/cancel webhook.
      await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems);
      console.log(`[rotation] order=${orderId} → new subscription purchase, fresh instance created`);
      continue;
    }

    // ── Loop renewal order ────────────────────────────────────────────────────
    let instance = await findRenewalInstance(
      shop, customerId, group.targetProductId, contractId, targetLineItems
    );

    if (!instance) {
      // No prior instance — customer subscribed before the app was installed.
      // Create an instance now and rotate this renewal immediately (don't skip it).
      // sourceIsLoopRenewal=true guarantees this is NOT a first purchase.
      console.log(`[rotation] order=${orderId} → renewal, no prior instance (pre-install subscriber), creating and rotating`);
      instance = await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems);
    }

    console.log(`[rotation] order=${orderId} sourceIsLoopRenewal=true instance=${instance.id} index=${instance.currentIndex}`);

    // Duplicate protection — handles sequential webhook retries after a successful run
    const alreadyLogged = await db.rotationLog.findFirst({
      where: { shop, orderId: orderGid, customerId: instance.customerId },
    });
    if (alreadyLogged) {
      console.log(`[rotation] order=${orderId} already processed, skipping duplicate`);
      continue;
    }

    console.log(`[rotation] order=${orderId} → rotating instance=${instance.id} index=${instance.currentIndex} fingerprint=${instance.lineItemFingerprint ?? "none"}`);
    await rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin);
  }

  pruneOldLogs(shop).catch((err) =>
    console.error(`[rotation] pruneOldLogs error for ${shop}:`, err.message)
  );
}
