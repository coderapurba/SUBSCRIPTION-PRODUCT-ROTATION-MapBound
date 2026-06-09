import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} for ${shop}`);

  const contractId = payload?.admin_graphql_api_id;
  if (!contractId) return new Response(null, { status: 200 });

  // Primary: update by contractId (works when activate webhook already back-filled it)
  const { count } = await db.subscriptionInstance.updateMany({
    where: { shop, subscriptionContractId: contractId },
    data: { status: "CANCELLED" },
  });

  // Fallback: contractId not yet stored — look up customer+products via GraphQL
  if (count === 0) {
    try {
      const { admin } = await unauthenticated.admin(shop);

      const res = await admin.graphql(`
        query GetContract($id: ID!) {
          subscriptionContract(id: $id) {
            customer { id }
            lines(first: 20) { nodes { productId } }
          }
        }
      `, { variables: { id: contractId } });

      const json = await res.json();
      const contract = json?.data?.subscriptionContract;

      if (contract) {
        const customerId = contract.customer?.id?.split("/").pop();
        const productIds = (contract.lines?.nodes ?? [])
          .map((n) => n.productId)
          .filter(Boolean);

        if (customerId && productIds.length > 0) {
          await db.subscriptionInstance.updateMany({
            where: {
              shop,
              customerId,
              targetProductId: { in: productIds },
              status: "ACTIVE",
            },
            data: { status: "CANCELLED", subscriptionContractId: contractId },
          });
        }
      }
    } catch (err) {
      console.error(`[webhook] ${topic} fallback error for ${shop}:`, err.message);
    }
  }

  return new Response(null, { status: 200 });
};
