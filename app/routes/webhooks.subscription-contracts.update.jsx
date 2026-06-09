import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const contractId = payload?.admin_graphql_api_id;
  const newStatus = payload?.status; // ACTIVE, PAUSED, CANCELLED, EXPIRED, FAILED

  if (contractId && newStatus) {
    const statusMap = {
      ACTIVE: "ACTIVE",
      PAUSED: "PAUSED",
      CANCELLED: "CANCELLED",
      EXPIRED: "CANCELLED",
      FAILED: "CANCELLED",
    };

    const mappedStatus = statusMap[newStatus];
    if (mappedStatus) {
      await db.subscriptionInstance.updateMany({
        where: { shop, subscriptionContractId: contractId },
        data: { status: mappedStatus },
      });
    }
  }

  return new Response(null, { status: 200 });
};
