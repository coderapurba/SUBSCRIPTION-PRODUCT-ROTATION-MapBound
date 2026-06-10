import { authenticate } from "../shopify.server";
import db from "../db.server";

const TERMINAL_STATUSES = ["CANCELLED", "EXPIRED", "FAILED"];

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  // ── Debug logging ─────────────────────────────────────────────────────────
  console.log("🔥 SUBSCRIPTION CONTRACT UPDATE WEBHOOK HIT");
  console.log("shop:", shop);
  console.log("topic:", topic);
  console.log("payload.status:", payload?.status);
  console.log("payload.admin_graphql_api_id:", payload?.admin_graphql_api_id);
  console.log("full payload:", JSON.stringify(payload, null, 2));

  const contractId = payload?.admin_graphql_api_id;
  const status     = payload?.status;
  const customerId = payload?.customer_id ? String(payload.customer_id) : null;

  // Only act on terminal statuses
  if (!status || !TERMINAL_STATUSES.includes(status)) {
    console.log(`[webhook] ${topic} — status=${status ?? "none"} is not terminal, skipping`);
    return Response.json({ success: true, topic, contractId, status, updatedCount: 0 });
  }

  let updatedCount = 0;
  let logStatus    = "FAILED";
  let logMessage   = "";

  try {
    // Primary: update by contractId
    if (contractId) {
      const { count } = await db.subscriptionInstance.updateMany({
        where: { shop, subscriptionContractId: contractId },
        data: { status: "CANCELLED" },
      });
      updatedCount = count;
      console.log(`[webhook] ${topic} — updated ${count} instance(s) by contractId=${contractId} → CANCELLED`);
    }

    // Fallback: match by customerId if contractId found nothing
    if (updatedCount === 0 && customerId) {
      console.warn(`[webhook] ${topic} — no instance found by contractId=${contractId ?? "none"}, trying customerId=${customerId} fallback`);

      const { count } = await db.subscriptionInstance.updateMany({
        where: { shop, customerId, status: "ACTIVE" },
        data: {
          status: "CANCELLED",
          ...(contractId ? { subscriptionContractId: contractId } : {}),
        },
      });
      updatedCount = count;
      console.log(`[webhook] ${topic} — updated ${count} instance(s) by customerId fallback → CANCELLED`);
    }

    if (updatedCount === 0) {
      console.warn(`[webhook] ${topic} — no matching SubscriptionInstance found for contractId=${contractId ?? "none"} customer=${customerId ?? "none"}`);
      logStatus  = "FAILED";
      logMessage = `No matching SubscriptionInstance found. contractId=${contractId ?? "none"} status=${status}`;
    } else {
      logStatus  = "SUCCESS";
      logMessage = `${updatedCount} instance(s) set to CANCELLED. contractId=${contractId ?? "none"} status=${status}`;
    }

    // Write rotation log
    await db.rotationLog.create({
      data: {
        shop,
        orderId:              `subscription_contracts_update:${contractId ?? customerId ?? "unknown"}`,
        customerId:           customerId ?? "unknown",
        targetProductTitle:   "subscription_contracts_update_webhook",
        rotationProductTitle: "",
        status:               logStatus,
        message:              logMessage,
      },
    });
  } catch (err) {
    console.error(`[webhook] ${topic} error for ${shop}:`, err.message);
  }

  return Response.json({ success: true, topic, contractId, status, updatedCount });
};
