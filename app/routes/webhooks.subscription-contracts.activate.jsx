import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

/**
 * When a subscription contract activates, back-fill the subscriptionContractId
 * on the matching SubscriptionInstance so renewal orders can be linked precisely.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} for ${shop}`);

  const contractId = payload?.admin_graphql_api_id; // gid://shopify/SubscriptionContract/...
  if (!contractId) return new Response(null, { status: 200 });

  try {
    // Query the contract via GraphQL to get the customer and product line items
    const { admin } = await unauthenticated.admin(shop);

    const res = await admin.graphql(`
      query GetContract($id: ID!) {
        subscriptionContract(id: $id) {
          id
          status
          customer { id }
          lines(first: 20) {
            nodes {
              productId
            }
          }
        }
      }
    `, { variables: { id: contractId } });

    const json = await res.json();
    const contract = json?.data?.subscriptionContract;

    if (!contract) return new Response(null, { status: 200 });

    const customerId = contract.customer?.id?.split("/").pop();
    const productIds = (contract.lines?.nodes ?? [])
      .map((n) => n.productId)
      .filter(Boolean);

    if (!customerId || productIds.length === 0) {
      return new Response(null, { status: 200 });
    }

    // Update all matching instances that don't yet have a contractId
    await db.subscriptionInstance.updateMany({
      where: {
        shop,
        customerId,
        targetProductId: { in: productIds },
        subscriptionContractId: null,
        status: "ACTIVE",
      },
      data: { subscriptionContractId: contractId },
    });
  } catch (err) {
    console.error(`[webhook] subscription_contracts/activate error for ${shop}:`, err.message);
  }

  return new Response(null, { status: 200 });
};
