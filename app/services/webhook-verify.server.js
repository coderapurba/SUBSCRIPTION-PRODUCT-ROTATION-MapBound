import crypto from "crypto";

/**
 * Manually verify a Shopify webhook HMAC signature.
 * The Shopify library's authenticate.webhook() already does this automatically,
 * but this utility can be used for additional validation or testing.
 *
 * @param {string} rawBody   - The raw UTF-8 request body
 * @param {string} hmacHeader - The value from X-Shopify-Hmac-Sha256 header
 * @param {string} secret    - Your Shopify API secret key
 * @returns {boolean}
 */
export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;

  const computed = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}
