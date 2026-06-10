import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

/**
 * When a subscription contract activates, back-fill subscriptionContractId on the
 * matching SubscriptionInstance using fingerprint matching. This lets the cancel
 * webhook later find and delete the exact instance by contractId.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const contractId = payload?.admin_graphql_api_id;
  console.log(`[webhook] ${topic} for ${shop} — contract=${contractId ?? "none"}`);

  if (!contractId) return new Response(null, { status: 200 });

  try {
    const { admin } = await unauthenticated.admin(shop);

    const res = await admin.graphql(`
      query GetContract($id: ID!) {
        subscriptionContract(id: $id) {
          customer { id }
          lines(first: 20) {
            nodes { productId variantId quantity }
          }
        }
      }
    `, { variables: { id: contractId } });

    const json = await res.json();
    const contract = json?.data?.subscriptionContract;

    if (!contract) return new Response(null, { status: 200 });

    const customerId = contract.customer?.id?.split("/").pop();
    const lines = contract.lines?.nodes ?? [];

    if (!customerId || lines.length === 0) {
      console.warn(`[webhook] ${topic} — missing customer or lines for contract=${contractId}`);
      return new Response(null, { status: 200 });
    }

    // Build fingerprint matching the format in rotation.server.js
    const fingerprint = lines
      .map((li) => `${String(li.variantId).split("/").pop()}:${li.quantity}`)
      .sort()
      .join(",");

    // Back-fill contractId on the exact matching instance via fingerprint
    const { count } = await db.subscriptionInstance.updateMany({
      where: {
        shop,
        customerId,
        lineItemFingerprint: fingerprint,
        subscriptionContractId: null,
        status: "ACTIVE",
      },
      data: { subscriptionContractId: contractId },
    });

    if (count > 0) {
      console.log(`[webhook] ${topic} — back-filled contractId on ${count} instance(s) via fingerprint=${fingerprint}`);
      return new Response(null, { status: 200 });
    }

    // Fallback for legacy instances with no fingerprint
    const productIds = lines.map((li) => li.productId).filter(Boolean);
    const { count: legacyCount } = await db.subscriptionInstance.updateMany({
      where: {
        shop,
        customerId,
        targetProductId: { in: productIds },
        lineItemFingerprint: null,
        subscriptionContractId: null,
        status: "ACTIVE",
      },
      data: { subscriptionContractId: contractId },
    });

    console.log(`[webhook] ${topic} — legacy fallback: back-filled contractId on ${legacyCount} instance(s)`);
  } catch (err) {
    console.error(`[webhook] ${topic} error for ${shop}:`, err.message);
  }

  return new Response(null, { status: 200 });
};
