import db from "../db.server";

const SECRET = process.env.LOOP_CANCEL_SECRET ?? "";

// When a Loop subscription becomes ACTIVE, back-fill subscriptionContractId on the
// matching SubscriptionInstance so the cancel endpoint can later delete it precisely.
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
  const shop          = body.shop ? String(body.shop) : null;

  const customerId = rawCustomerId?.includes("/")
    ? rawCustomerId.split("/").pop()
    : rawCustomerId;

  console.log("[flow/activate] received:", { contractId: rawContractId, customerId, shop });

  if (!rawContractId || !customerId) {
    return Response.json({ success: false, reason: "missing contractId or customerId" });
  }

  // Already back-filled — idempotent
  const already = await db.subscriptionInstance.findFirst({
    where: { subscriptionContractId: rawContractId },
  });
  if (already) {
    console.log(`[flow/activate] contractId already stored on instance=${already.id}, skipping`);
    return Response.json({ success: true, updated: 0 });
  }

  // Find active instances for this customer that have no contractId yet,
  // created within the last 10 minutes (the subscription activates within seconds of purchase).
  const windowStart = new Date(Date.now() - 10 * 60 * 1000);
  const whereClause = {
    customerId,
    subscriptionContractId: null,
    status: "ACTIVE",
    createdAt: { gte: windowStart },
    ...(shop ? { shop } : {}),
  };

  const candidates = await db.subscriptionInstance.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
  });

  if (candidates.length === 0) {
    // Widen search — instance may have been created more than 10 minutes ago
    const wider = await db.subscriptionInstance.findMany({
      where: {
        customerId,
        subscriptionContractId: null,
        status: "ACTIVE",
        ...(shop ? { shop } : {}),
      },
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

  if (candidates.length === 1) {
    await db.subscriptionInstance.update({
      where: { id: candidates[0].id },
      data: { subscriptionContractId: rawContractId },
    });
    console.log(`[flow/activate] back-filled contractId=${rawContractId} on instance=${candidates[0].id}`);
    return Response.json({ success: true, updated: 1 });
  }

  // Multiple candidates in the window — use most recent (just-purchased subscription)
  await db.subscriptionInstance.update({
    where: { id: candidates[0].id },
    data: { subscriptionContractId: rawContractId },
  });
  console.log(
    `[flow/activate] ${candidates.length} candidates in window, used most-recent instance=${candidates[0].id} for contractId=${rawContractId}`,
  );
  return Response.json({ success: true, updated: 1 });
};
