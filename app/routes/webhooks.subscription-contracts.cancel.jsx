import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} for ${shop} — payload:`, JSON.stringify(payload));

  const contractId = payload?.admin_graphql_api_id;
  // REST payload includes customer_id as a numeric field
  const customerId = payload?.customer_id ? String(payload.customer_id) : null;

  // Primary: update by contractId (works when activate webhook already back-filled it)
  if (contractId) {
    const { count } = await db.subscriptionInstance.updateMany({
      where: { shop, subscriptionContractId: contractId },
      data: { status: "CANCELLED" },
    });
    console.log(`[webhook] ${topic} — updated ${count} instances by contractId`);
    if (count > 0) return new Response(null, { status: 200 });
  }

  // Fallback: contractId not stored yet — use customer_id from payload directly
  // (works even when the contract was created by another subscription app)
  if (customerId) {
    const { count } = await db.subscriptionInstance.updateMany({
      where: { shop, customerId, status: "ACTIVE" },
      data: {
        status: "CANCELLED",
        ...(contractId ? { subscriptionContractId: contractId } : {}),
      },
    });
    console.log(`[webhook] ${topic} — updated ${count} instances by customerId fallback`);
  } else {
    console.warn(`[webhook] ${topic} — no contractId or customerId in payload, nothing updated`);
  }

  return new Response(null, { status: 200 });
};
