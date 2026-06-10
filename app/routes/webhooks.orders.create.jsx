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
    if (err.message?.includes("Could not find a session")) {
      // The offline access token for this shop is missing from the database.
      // This happens when the app hasn't been properly installed/authenticated on the store.
      // FIX: Reinstall the app by visiting:
      //   https://<your-vercel-url>/auth/login?shop=<shop-domain>
      console.error(
        `[webhook] OFFLINE SESSION MISSING for ${shop}. ` +
        `The app needs to be reinstalled to store an offline access token. ` +
        `Visit your app URL with /auth/login?shop=${shop} to fix this.`
      );
    } else {
      console.error(`[webhook] orders/create error for ${shop}:`, err.message);
    }
  }

  return new Response(null, { status: 200 });
};
