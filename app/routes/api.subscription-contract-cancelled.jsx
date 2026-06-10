import { unauthenticated } from "../shopify.server";
import db from "../db.server";

const SECRET = process.env.LOOP_CANCEL_SECRET ?? "";

async function getContractFingerprint(admin, contractId) {
  const res = await admin.graphql(
    `query GetContract($id: ID!) {
      subscriptionContract(id: $id) {
        lines(first: 20) {
          nodes { variantId quantity }
        }
      }
    }`,
    { variables: { id: contractId } },
  );
  const json = await res.json();
  const lines = json?.data?.subscriptionContract?.lines?.nodes ?? [];
  if (lines.length === 0) return null;
  return lines
    .map((li) => `${String(li.variantId).split("/").pop()}:${li.quantity}`)
    .sort()
    .join(",");
}

export const action = async ({ request }) => {
  const secret = request.headers.get("x-rotation-secret") ?? "";
  if (SECRET && secret !== SECRET) {
    console.warn("[flow/cancel] rejected — invalid x-rotation-secret");
    return new Response("Unauthorized", { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const rawContractId = body.contractId ? String(body.contractId) : null;
  const rawCustomerId = body.customerId ? String(body.customerId) : null;
  const shop          = body.shop ? String(body.shop) : null;
  const email         = body.email ?? null;

  // Flow may send GID ("gid://shopify/Customer/123") or plain numeric ID
  const customerId = rawCustomerId?.includes("/")
    ? rawCustomerId.split("/").pop()
    : rawCustomerId;

  console.log("[flow/cancel] received:", { contractId: rawContractId, customerId, shop, email });

  if (!customerId && !email) {
    console.warn("[flow/cancel] no customerId or email in payload");
    return Response.json({ success: false, reason: "no_identifier" });
  }

  try {
    let deleted = { count: 0 };

    // ── Step 1: fetch contract line items → build fingerprint → delete exact instance ──
    if (rawContractId && shop) {
      try {
        const { admin } = await unauthenticated.admin(shop);
        const fingerprint = await getContractFingerprint(admin, rawContractId);
        console.log(`[flow/cancel] contract fingerprint from API: ${fingerprint ?? "null (contract not accessible)"}`);

        if (fingerprint && customerId) {
          deleted = await db.subscriptionInstance.deleteMany({
            where: { shop, customerId, lineItemFingerprint: fingerprint, status: "ACTIVE" },
          });
          console.log(`[flow/cancel] deleted ${deleted.count} instance(s) by fingerprint=${fingerprint}`);
        }
      } catch (err) {
        console.warn("[flow/cancel] Shopify API lookup failed:", err.message);
      }
    }

    // ── Step 2: match by contractId stored in DB (back-filled via activate webhook) ──
    if (deleted.count === 0 && rawContractId) {
      deleted = await db.subscriptionInstance.deleteMany({
        where: { subscriptionContractId: rawContractId },
      });
      console.log(`[flow/cancel] deleted ${deleted.count} instance(s) by contractId=${rawContractId}`);
    }

    // ── Step 3: safe customerId fallback — only if exactly 1 active instance ─────────
    if (deleted.count === 0 && customerId) {
      const whereClause = shop
        ? { shop, customerId, status: "ACTIVE" }
        : { customerId, status: "ACTIVE" };

      const instances = await db.subscriptionInstance.findMany({ where: whereClause });

      if (instances.length === 1) {
        deleted = await db.subscriptionInstance.deleteMany({ where: whereClause });
        console.log(`[flow/cancel] deleted ${deleted.count} instance(s) by customerId (sole active instance)`);
      } else if (instances.length > 1) {
        console.warn(
          `[flow/cancel] customer=${customerId} has ${instances.length} active instances — ` +
          `cannot safely delete without fingerprint or contractId match. Skipping to avoid removing wrong subscription.`,
        );
      } else {
        console.warn(`[flow/cancel] no ACTIVE instance found for customerId=${customerId}`);
      }
    }

    return Response.json({ success: true, deletedCount: deleted.count });
  } catch (err) {
    console.error("[flow/cancel] db error:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
};
