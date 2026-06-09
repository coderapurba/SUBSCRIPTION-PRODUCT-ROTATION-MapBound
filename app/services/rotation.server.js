/**
 * Core rotation logic.
 *
 * Entry point: processOrderWebhook(shop, order, admin)
 *
 * First order  (source_name !== "subscription"):
 *   → create SubscriptionInstance, store line-item snapshot, currentIndex = 0
 *
 * Renewal order (source_name === "subscription"):
 *   → find SubscriptionInstance by contractId OR customerId+targetProduct
 *   → call performOrderEdit to swap products
 *   → advance currentIndex, write RotationLog
 */

import db from "../db.server.js";
import { performOrderEdit } from "./order-edit.server.js";

// ─── Utilities ────────────────────────────────────────────────────────────────

function toNumericId(gid) {
  return String(gid).split("/").pop();
}

function buildUniqueKey(shop, customerId, targetProductId, orderId) {
  // targetProductId stored as GID; use numeric portion for stable key
  return `${shop}:${customerId}:${toNumericId(targetProductId)}:${orderId}`;
}

/**
 * Try to extract a SubscriptionContract GID from the order payload.
 * Shopify doesn't have a single canonical field for this across all apps,
 * so we scan note_attributes and line item properties for any value matching
 * the GID pattern.
 */
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

  // Idempotency guard
  const existing = await db.subscriptionInstance.findUnique({ where: { uniqueKey } });
  if (existing) return existing;

  const lineItemSnapshot = targetLineItems.map((li) => ({
    lineItemId: String(li.id),
    variantId: `gid://shopify/ProductVariant/${li.variant_id}`,
    variantTitle: li.variant_title || "Default Title",
    quantity: li.quantity,
    finalLinePrice: li.final_line_price ?? String(parseFloat(li.price) * li.quantity),
  }));

  return db.subscriptionInstance.create({
    data: {
      shop,
      customerId,
      originalOrderId: orderId,
      originalLineItemIds: targetLineItems.map((li) => String(li.id)),
      subscriptionContractId: contractId ?? null,
      targetProductId: group.targetProductId,
      currentIndex: 0,
      uniqueKey,
      status: "ACTIVE",
      lineItemSnapshot,
      rotationGroupId: group.id,
    },
  });
}

async function findRenewalInstance(shop, customerId, targetProductId, contractId) {
  // Most precise: match by subscription contract GID
  if (contractId) {
    const inst = await db.subscriptionInstance.findFirst({
      where: { shop, subscriptionContractId: contractId, targetProductId, status: "ACTIVE" },
    });
    if (inst) return inst;
  }

  // Fallback: most recent active instance for this customer + target product
  return db.subscriptionInstance.findFirst({
    where: { shop, customerId, targetProductId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
}

// ─── Rotation ─────────────────────────────────────────────────────────────────

async function rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin) {
  const activeItems = group.rotationItems; // already filtered + sorted

  if (activeItems.length === 0) {
    await writeLog(shop, orderGid, instance, null, group, "SKIPPED", "No active rotation items");
    return;
  }

  const nextIndex = instance.currentIndex % activeItems.length;
  const nextItem = activeItems[nextIndex];

  try {
    await performOrderEdit({
      admin,
      orderGid,
      targetLineItems,
      nextItem,
      lineItemSnapshot: instance.lineItemSnapshot,
      currency,
    });

    const newIndex = (nextIndex + 1) % activeItems.length;

    await db.subscriptionInstance.update({
      where: { id: instance.id },
      data: { currentIndex: newIndex },
    });

    await writeLog(shop, orderGid, instance, nextItem, group, "SUCCESS");
  } catch (err) {
    await writeLog(shop, orderGid, instance, nextItem, group, "FAILED", err.message);
    throw err; // surface to webhook handler so Shopify retries
  }
}

async function writeLog(shop, orderId, instance, rotationItem, group, status, errorMessage = null) {
  await db.rotationLog.create({
    data: {
      shop,
      orderId,
      subscriptionInstanceId: instance.id,
      fromProductId: group.targetProductId,
      fromProductTitle: group.targetProductTitle,
      toProductId: rotationItem?.productId ?? "",
      toProductTitle: rotationItem?.productTitle ?? "",
      rotationIndex: instance.currentIndex,
      status,
      errorMessage,
    },
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Process an orders/create webhook.
 *
 * @param {string} shop   - myshopify domain
 * @param {object} order  - raw Shopify order REST payload
 * @param {object} admin  - Shopify Admin GraphQL client (from unauthenticated.admin)
 */
export async function processOrderWebhook(shop, order, admin) {
  await db.shopSetting.upsert({ where: { shop }, create: { shop }, update: {} });

  const customerId = String(order.customer?.id ?? "anonymous");
  const orderId    = String(order.id);
  const orderGid   = `gid://shopify/Order/${orderId}`;
  const contractId = extractContractId(order);
  const currency   = order.currency ?? "USD";

  // source_name is "subscription" for native Shopify subscription billing.
  // Loop and other apps may use different values, so we also check by existing instance below.
  const sourceIsSubscription = order.source_name === "subscription";

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

    // Look for an existing active instance for this customer + product.
    // If one exists, this order is a renewal — rotate regardless of source_name.
    // This makes rotation work with Loop, ReCharge, Bold, and other subscription apps
    // that may not set source_name="subscription".
    const existingInstance = await findRenewalInstance(
      shop, customerId, group.targetProductId, contractId
    );

    const isRenewal = sourceIsSubscription || existingInstance !== null;

    console.log(`[rotation] order=${orderId} sourceIsSubscription=${sourceIsSubscription} existingInstance=${existingInstance?.id ?? "none"} isRenewal=${isRenewal}`);

    if (!isRenewal) {
      // ── Genuinely first order — create instance, do NOT rotate ────────────
      await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems);
      console.log(`[rotation] order=${orderId} → first order, instance created, no rotation`);
    } else if (!existingInstance) {
      // ── source_name says renewal but no prior instance found ───────────────
      // Create instance now; next renewal will rotate.
      console.warn(`[rotation] order=${orderId} → renewal but no prior instance, creating instance`);
      await createSubscriptionInstance(shop, orderId, customerId, contractId, group, targetLineItems);
    } else {
      // ── Renewal with existing instance — rotate ────────────────────────────

      // Idempotency guard: skip if we already processed this exact order for this instance
      // (webhook can fire twice — duplicate delivery or Loop's two-phase order creation)
      const alreadyLogged = await db.rotationLog.findFirst({
        where: { shop, orderId: orderGid, subscriptionInstanceId: existingInstance.id },
      });
      if (alreadyLogged) {
        console.log(`[rotation] order=${orderId} already processed (log id=${alreadyLogged.id}), skipping duplicate`);
        continue;
      }

      console.log(`[rotation] order=${orderId} → renewal, rotating instance=${existingInstance.id} index=${existingInstance.currentIndex}`);
      await rotateOrderItems(shop, orderGid, existingInstance, group, targetLineItems, currency, admin);
    }
  }
}
