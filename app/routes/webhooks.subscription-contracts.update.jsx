import { authenticate } from "../shopify.server";
import db from "../db.server";

const STATUS_MAP = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  CANCELLED: "CANCELLED",
  EXPIRED: "CANCELLED",
  FAILED: "CANCELLED",
};

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} for ${shop} — status: ${payload?.status}`);

  const contractId = payload?.admin_graphql_api_id;
  const newStatus = payload?.status;
  const customerId = payload?.customer_id ? String(payload.customer_id) : null;

  if (!newStatus) return new Response(null, { status: 200 });

  const mappedStatus = STATUS_MAP[newStatus];
  if (!mappedStatus) return new Response(null, { status: 200 });

  // Primary: update by contractId
  if (contractId) {
    const { count } = await db.subscriptionInstance.updateMany({
      where: { shop, subscriptionContractId: contractId },
      data: { status: mappedStatus },
    });
    console.log(`[webhook] ${topic} — updated ${count} instances by contractId`);
    if (count > 0) return new Response(null, { status: 200 });
  }

  // Fallback: use customer_id from payload directly
  // Only for non-ACTIVE transitions (don't accidentally activate all instances)
  if (customerId && mappedStatus !== "ACTIVE") {
    const { count } = await db.subscriptionInstance.updateMany({
      where: { shop, customerId, status: "ACTIVE" },
      data: {
        status: mappedStatus,
        ...(contractId ? { subscriptionContractId: contractId } : {}),
      },
    });
    console.log(`[webhook] ${topic} — updated ${count} instances by customerId fallback`);
  }

  return new Response(null, { status: 200 });
};
