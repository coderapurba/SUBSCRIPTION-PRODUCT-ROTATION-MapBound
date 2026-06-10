/**
 * Core rotation logic.
 *
 * Entry point: processOrderWebhook(shop, order, admin)
 *
 * First order  → create SubscriptionInstance (no JSON blobs, lean fields only)
 * Renewal order → find instance by contractId or customerId+product → rotate → prune logs
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

async function createSubscriptionInstance(shop, orderId, customerId, contractId, group) {
  const uniqueKey = buildUniqueKey(shop, customerId, group.targetProductId, orderId);

  const existing = await db.subscriptionInstance.findUnique({ where: { uniqueKey } });
  if (existing) return existing;

  return db.subscriptionInstance.create({
    data: {
      shop,
      customerId,
      originalOrderId: orderId,
      subscriptionContractId: contractId ?? null,
      targetProductId: group.targetProductId,
      currentIndex: 0,
      uniqueKey,
      status: "ACTIVE",
      rotationGroupId: group.id,
    },
  });
}

async function findRenewalInstance(shop, customerId, targetProductId, contractId) {
  // Primary: exact match by contract ID (most reliable — each Loop subscription has a unique contract)
  if (contractId) {
    const inst = await db.subscriptionInstance.findFirst({
      where: { shop, subscriptionContractId: contractId, targetProductId, status: "ACTIVE" },
    });
    if (inst) return inst;
    // Contract ID present but no instance found — log so we can investigate
    console.warn(`[rotation] No ACTIVE instance found for contractId=${contractId} (${targetProductId}). Falling back to recency lookup.`);
  }

  // Fallback: newest active instance for this customer+product.
  // This handles the rare case where Loop doesn't include the contract ID in the renewal order.
  // With multiple concurrent subscriptions, the most recently created instance is selected;
  // the others will be matched correctly when their own contract ID is present.
  const instances = await db.subscriptionInstance.findMany({
    where: { shop, customerId, targetProductId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });

  if (instances.length > 1) {
    console.warn(
      `[rotation] customer=${customerId} has ${instances.length} active instances for product=${targetProductId} ` +
      `and no contractId was found in the order. Using most-recent instance=${instances[0].id}. ` +
      `Other instances: ${instances.slice(1).map(i => i.id).join(", ")}`
    );
  }

  return instances[0] ?? null;
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

  // Find IDs beyond the 50-row cap (newest first)
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

  // Skip if the rotation item points back at the target product itself (self-rotation)
  if (toNumericId(nextItem.productId) === toNumericId(group.targetProductId)) {
    console.log(`[rotation] order=${orderGid} rotation item at index=${nextIndex} is the target product — skipping self-rotation, advancing index`);
    await db.subscriptionInstance.update({ where: { id: instance.id }, data: { currentIndex: newIndex } });
    await writeLog(shop, orderGid, instance, nextItem, group, "SKIPPED", "Rotation item is the target product — self-rotation skipped");
    return;
  }

  try {
    // order-edit uses targetLineItems directly — no lineItemSnapshot needed
    await performOrderEdit({ admin, orderGid, targetLineItems, nextItem, currency });

    await db.subscriptionInstance.update({
      where: { id: instance.id },
      data: { currentIndex: newIndex },
    });

    await writeLog(shop, orderGid, instance, nextItem, group, "SUCCESS");
  } catch (err) {
    if (err.concurrent) {
      // A concurrent webhook run already processed this order — not a failure
      console.log(`[rotation] order=${orderGid} already processed by concurrent webhook, skipping`);
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

  // Loop renewal orders always use this source_name — anything else is a new purchase
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
      // ── New subscription purchase ──
      // Create a fresh independent instance for this purchase.
      // Do NOT cancel other active instances — the customer may hold multiple
      // concurrent subscriptions for the same product (e.g. different quantities
      // or variants). Each purchase must track its own rotation index independently.
      // Real cancellations are handled by the subscription-contracts/cancel webhook.
      await createSubscriptionInstance(shop, orderId, customerId, contractId, group);
      console.log(`[rotation] order=${orderId} → new subscription purchase, fresh instance created`);
      continue;
    }

    // ── Loop renewal order ────────────────────────────────────────────────────
    const existingInstance = await findRenewalInstance(
      shop, customerId, group.targetProductId, contractId
    );

    console.log(`[rotation] order=${orderId} sourceIsLoopRenewal=true existingInstance=${existingInstance?.id ?? "none"}`);

    if (!existingInstance) {
      // Renewal arrived before any first-order instance — create one and wait for next
      console.warn(`[rotation] order=${orderId} → renewal but no prior instance, creating`);
      await createSubscriptionInstance(shop, orderId, customerId, contractId, group);
    } else {
      // Idempotency: skip if already processed this order
      const alreadyLogged = await db.rotationLog.findFirst({
        where: { shop, orderId: orderGid, customerId: existingInstance.customerId },
      });
      if (alreadyLogged) {
        console.log(`[rotation] order=${orderId} already processed, skipping duplicate`);
        continue;
      }

      console.log(`[rotation] order=${orderId} → renewal, rotating instance=${existingInstance.id} index=${existingInstance.currentIndex}`);
      await rotateOrderItems(shop, orderGid, existingInstance, group, targetLineItems, currency, admin);
    }
  }

  // Prune old logs once per webhook run (non-blocking)
  pruneOldLogs(shop).catch((err) =>
    console.error(`[rotation] pruneOldLogs error for ${shop}:`, err.message)
  );
}
