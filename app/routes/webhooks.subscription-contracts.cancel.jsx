import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const contractId = payload?.admin_graphql_api_id;

  if (contractId) {
    await db.subscriptionInstance.updateMany({
      where: { shop, subscriptionContractId: contractId },
      data: { status: "CANCELLED" },
    });
  }

  return new Response(null, { status: 200 });
};
