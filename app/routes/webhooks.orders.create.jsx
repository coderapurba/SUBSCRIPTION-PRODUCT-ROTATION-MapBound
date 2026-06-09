import { authenticate, unauthenticated } from "../shopify.server";
import { processOrderWebhook } from "../services/rotation.server";

/**
 * POST /webhooks/orders/create
 *
 * authenticate.webhook() verifies the X-Shopify-Hmac-Sha256 header using
 * the API secret and returns 401 automatically if validation fails.
 * Never runs rotation logic if HMAC is invalid.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] ${topic} for ${shop} — order #${payload?.order_number}`);

  try {
    const { admin } = await unauthenticated.admin(shop);
    await processOrderWebhook(shop, payload, admin);
  } catch (err) {
    // Log but return 200 so Shopify doesn't keep retrying on expected errors.
    // Re-throw only for transient failures (handled by the rotation service).
    console.error(`[webhook] orders/create error for ${shop}:`, err.message);
  }

  return new Response(null, { status: 200 });
};
