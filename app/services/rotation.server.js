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
  // Ensure ShopSetting row exists (upsert is safe across concurrent requests)
  await db.shopSetting.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  const isRenewal = order.source_name === "subscription";
  const customerId = String(order.customer?.id ?? "anonymous");
  const orderId = String(order.id);
  const orderGid = `gid://shopify/Order/${orderId}`;
  const contractId = extractContractId(order);
  const currency = order.currency ?? "USD";

  // Load all active rotation groups for this shop (with their active, ordered items)
  const groups = await db.rotationGroup.findMany({
    where: { shop, isActive: true },
    include: {
      rotationItems: {
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      },
    },
  });

  if (groups.length === 0) return;

  for (const group of groups) {
    const targetNumericId = toNumericId(group.targetProductId);

    // All line items in this order that belong to the target product
    const targetLineItems = (order.line_items ?? []).filter(
      (li) => String(li.product_id) === targetNumericId
    );

    if (targetLineItems.length === 0) continue;

    if (!isRenewal) {
      // ── First / new order ──────────────────────────────────────────────────
      await createSubscriptionInstance(
        shop, orderId, customerId, contractId, group, targetLineItems
      );
      // Do NOT rotate — keep original product on first order
    } else {
      // ── Renewal order ──────────────────────────────────────────────────────
      const instance = await findRenewalInstance(
        shop, customerId, group.targetProductId, contractId
      );

      if (!instance) {
        // Edge case: renewal arrived before first order was processed
        console.warn(
          `[rotation] Renewal for unknown instance — shop=${shop} order=${orderId} product=${group.targetProductId}. Creating new instance.`
        );
        await createSubscriptionInstance(
          shop, orderId, customerId, contractId, group, targetLineItems
        );
        continue;
      }

      await rotateOrderItems(shop, orderGid, instance, group, targetLineItems, currency, admin);
    }
  }
}
