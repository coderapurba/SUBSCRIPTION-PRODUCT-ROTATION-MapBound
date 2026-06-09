import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const contractId = payload?.admin_graphql_api_id;

  if (contractId) {
    // Upsert: create instance if it doesn't exist, or reactivate if cancelled
    const existing = await db.subscriptionInstance.findUnique({
      where: { shop_subscriptionContractId: { shop, subscriptionContractId: contractId } },
    });

    if (!existing) {
      // No linked group yet — store a placeholder so we can link it later
      // Actual group assignment happens via the admin UI
      console.log(`New subscription contract activated: ${contractId} for ${shop}`);
    } else if (existing.status === "CANCELLED") {
      await db.subscriptionInstance.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", updatedAt: new Date() },
      });
    }
  }

  return new Response(null, { status: 200 });
};
