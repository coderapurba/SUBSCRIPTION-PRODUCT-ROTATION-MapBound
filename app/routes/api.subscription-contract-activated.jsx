import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { fetchOrderForRotation, processRenewalForContract } from "../services/rotation.server";

const SECRET = process.env.LOOP_CANCEL_SECRET ?? "";

/**
 * POST /api/subscription-contract-activated  (called by a Loop Flow on every renewal)
 *
 * Expected JSON body: { contractId, customerId, orderId, shop }
 *
 * The renewal ORDER does not carry the subscription contract id, so the orders/create
 * webhook cannot tell two same-product subscriptions of one customer apart. This Loop
 * Flow fires on every renewal WITH the contract id + order id — the only place a renewal
 * can be tied to its subscription. We use it to:
 *   • Renewal order  → rotate the order, routed strictly by contract id
 *                      (same contract → same instance; new contract → fresh instance).
 *   • First order    → just link the contract id onto the instance orders/create made.
 */
export const action = async ({ request }) => {
  const secret = request.headers.get("x-rotation-secret") ?? "";
  if (SECRET && secret !== SECRET) {
    console.warn("[flow/activate] rejected — invalid x-rotation-secret");
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
  const rawOrderId    = body.orderId ? String(body.orderId) : null;
  const shop          = body.shop ? String(body.shop) : null;

  const customerId = rawCustomerId?.includes("/") ? rawCustomerId.split("/").pop() : rawCustomerId;
  const orderNumericId = rawOrderId?.includes("/") ? rawOrderId.split("/").pop() : rawOrderId;

  console.log("[flow/activate] received:", { contractId: rawContractId, customerId, orderId: orderNumericId, shop });

  if (!rawContractId || !customerId || !shop) {
    return Response.json({ success: false, reason: "missing contractId, customerId, or shop" });
  }

  // ── Preferred path: we have the order id ────────────────────────────────────
  if (orderNumericId) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const order = await fetchOrderForRotation(admin, orderNumericId);

      if (!order) {
        console.warn(`[flow/activate] order=${orderNumericId} not found via Admin API — falling back to instance linking`);
      } else if (order.source_name === "subscription_contract_checkout_one") {
        // Renewal → rotate, routed by contract id.
        await processRenewalForContract(shop, order, admin, rawContractId);
        return Response.json({ success: true, rotated: true });
      } else {
        // First order / activation → don't rotate; just bind the contract id to the
        // instance that orders/create created for this exact order.
        const own = await db.subscriptionInstance.findFirst({
          where: { shop, originalOrderId: orderNumericId },
          orderBy: { createdAt: "desc" },
        });
        if (own && (!own.subscriptionContractId || own.subscriptionContractId === rawContractId)) {
          await db.subscriptionInstance.update({
            where: { id: own.id },
            data: { subscriptionContractId: rawContractId },
          });
          console.log(`[flow/activate] first order — linked contractId=${rawContractId} to instance=${own.id}`);
          return Response.json({ success: true, linked: 1 });
        }
        console.log(`[flow/activate] first order=${orderNumericId} — no own unlinked instance, falling back to windowed linking`);
      }
    } catch (err) {
      console.error(`[flow/activate] error processing order=${orderNumericId}: ${err.message} — falling back to instance linking`);
    }
  }

  // ── Fallback: link contract id to a single unlinked instance ─────────────────
  // (Used when no order id is provided, or the order lookup/rotation could not run.)

  const already = await db.subscriptionInstance.findFirst({
    where: { subscriptionContractId: rawContractId },
  });
  if (already) {
    console.log(`[flow/activate] contractId already stored on instance=${already.id}, skipping`);
    return Response.json({ success: true, updated: 0 });
  }

  const windowStart = new Date(Date.now() - 10 * 60 * 1000);
  const baseWhere = {
    customerId,
    subscriptionContractId: null,
    status: "ACTIVE",
    ...(shop ? { shop } : {}),
  };

  const candidates = await db.subscriptionInstance.findMany({
    where: { ...baseWhere, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "desc" },
  });

  if (candidates.length === 0) {
    const wider = await db.subscriptionInstance.findMany({
      where: baseWhere,
      orderBy: { createdAt: "desc" },
    });

    if (wider.length === 1) {
      await db.subscriptionInstance.update({
        where: { id: wider[0].id },
        data: { subscriptionContractId: rawContractId },
      });
      console.log(`[flow/activate] back-filled contractId=${rawContractId} on instance=${wider[0].id} (wider search)`);
      return Response.json({ success: true, updated: 1 });
    }

    console.warn(`[flow/activate] no unlinked instance found for customerId=${customerId} (wider: ${wider.length})`);
    return Response.json({ success: true, updated: 0 });
  }

  await db.subscriptionInstance.update({
    where: { id: candidates[0].id },
    data: { subscriptionContractId: rawContractId },
  });
  console.log(
    `[flow/activate] ${candidates.length} candidate(s) in window, linked contractId=${rawContractId} to most-recent instance=${candidates[0].id}`,
  );
  return Response.json({ success: true, updated: 1 });
};
