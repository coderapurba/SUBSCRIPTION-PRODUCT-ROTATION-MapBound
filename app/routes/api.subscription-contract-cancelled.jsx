import db from "../db.server";

const SECRET = process.env.LOOP_CANCEL_SECRET ?? "";

export const action = async ({ request }) => {
  // Validate shared secret set in the Flow HTTP request header
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
  const email        = body.email ?? null;
  const status       = body.status ?? null;

  // Flow may send a GID ("gid://shopify/Customer/9918827528285") or plain numeric ID
  const customerId = rawCustomerId?.includes("/")
    ? rawCustomerId.split("/").pop()
    : rawCustomerId;

  console.log("[flow/cancel] received:", { contractId: rawContractId, customerId, email, status });

  if (!customerId && !email) {
    console.warn("[flow/cancel] no customerId or email in payload — cannot match instance");
    return Response.json({ success: false, reason: "no_identifier" });
  }

  try {
    let deleted = { count: 0 };

    // Primary: delete by contractId (back-filled via activate webhook)
    if (rawContractId) {
      deleted = await db.subscriptionInstance.deleteMany({
        where: { subscriptionContractId: rawContractId },
      });
      console.log(`[flow/cancel] deleted ${deleted.count} instance(s) by contractId=${rawContractId}`);
    }

    // Fallback: delete by numeric customerId
    if (deleted.count === 0 && customerId) {
      deleted = await db.subscriptionInstance.deleteMany({
        where: { customerId, status: "ACTIVE" },
      });
      console.log(`[flow/cancel] deleted ${deleted.count} instance(s) by customerId=${customerId}`);
    }

    if (deleted.count === 0) {
      console.warn(
        `[flow/cancel] no ACTIVE instance found — contractId=${rawContractId ?? "none"} customerId=${customerId ?? "none"} email=${email ?? "none"}`,
      );
    }

    return Response.json({ success: true, deletedCount: deleted.count });
  } catch (err) {
    console.error("[flow/cancel] db error:", err.message);
    return Response.json({ success: false, error: err.message }, { status: 500 });
  }
};
