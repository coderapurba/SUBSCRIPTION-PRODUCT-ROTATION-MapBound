import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const contractGid = payload?.admin_graphql_api_id;
  const customerId = payload?.customer_id ? String(payload.customer_id) : null;

  console.log(`[webhook] ${topic} for ${shop} — contract=${contractGid ?? "none"} customer=${customerId ?? "none"}`);

  try {
    // Primary: delete by contractId if it was back-filled on the instance
    if (contractGid) {
      const { count } = await db.subscriptionInstance.deleteMany({
        where: { shop, subscriptionContractId: contractGid },
      });
      if (count > 0) {
        console.log(`[webhook] ${topic} — deleted ${count} instance(s) by contractId`);
        return new Response(null, { status: 200 });
      }
    }

    if (!customerId) {
      console.warn(`[webhook] ${topic} — no customerId in payload, cannot delete instance`);
      return new Response(null, { status: 200 });
    }

    // Fallback: fetch contract line items via API, build fingerprint, delete precisely
    if (contractGid) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        const res = await admin.graphql(`
          query GetContractLines($id: ID!) {
            subscriptionContract(id: $id) {
              lines(first: 20) {
                nodes { variantId quantity }
              }
            }
          }
        `, { variables: { id: contractGid } });

        const json = await res.json();
        const lines = json?.data?.subscriptionContract?.lines?.nodes ?? [];

        if (lines.length > 0) {
          const fingerprint = lines
            .map((li) => `${String(li.variantId).split("/").pop()}:${li.quantity}`)
            .sort()
            .join(",");

          const { count } = await db.subscriptionInstance.deleteMany({
            where: { shop, customerId, lineItemFingerprint: fingerprint },
          });

          if (count > 0) {
            console.log(`[webhook] ${topic} — deleted ${count} instance(s) by fingerprint=${fingerprint}`);
          } else {
            console.warn(`[webhook] ${topic} — no instance matched fingerprint=${fingerprint} for customer=${customerId}`);
          }
          return new Response(null, { status: 200 });
        }
      } catch (apiErr) {
        console.warn(`[webhook] ${topic} — API call failed: ${apiErr.message}`);
      }
    }

    // Last resort: customer has only one active instance — safe to delete by customerId
    const activeInstances = await db.subscriptionInstance.findMany({
      where: { shop, customerId, status: "ACTIVE" },
      select: { id: true },
    });

    if (activeInstances.length === 1) {
      await db.subscriptionInstance.delete({ where: { id: activeInstances[0].id } });
      console.log(`[webhook] ${topic} — deleted sole active instance for customer=${customerId}`);
    } else if (activeInstances.length > 1) {
      console.warn(
        `[webhook] ${topic} — customer=${customerId} has ${activeInstances.length} active instances ` +
        `and no fingerprint match found. Skipping deletion to avoid removing wrong instance.`
      );
    }
  } catch (err) {
    console.error(`[webhook] ${topic} error for ${shop}:`, err.message);
  }

  return new Response(null, { status: 200 });
};
