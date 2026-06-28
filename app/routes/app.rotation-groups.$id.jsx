import { useState } from "react";
import { redirect, useLoaderData, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Breadcrumbs } from "../components/Breadcrumbs";

// ─── Loader ───────────────────────────────────────────────────────────────────

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  const group = await db.rotationGroup.findFirst({
    where: { id: params.id, shop },
    include: {
      rotationItems: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!group) throw new Response("Not Found", { status: 404 });

  // Fetch target product image and search results in parallel
  const [productImageRes, searchRes] = await Promise.all([
    admin.graphql(`
      query GetProductImage($id: ID!) {
        product(id: $id) {
          featuredImage { url }
        }
      }
    `, { variables: { id: group.targetProductId } }),
    q ? admin.graphql(`
      query SearchProducts($query: String!) {
        products(first: 8, query: $query) {
          nodes {
            id title
            featuredImage { url }
            variants(first: 50) { nodes { id title price } }
          }
        }
      }
    `, { variables: { query: q } }) : null,
  ]);

  const productImageJson = await productImageRes.json();
  const targetProductImage = productImageJson.data?.product?.featuredImage?.url ?? null;

  const searchProducts = q
    ? ((await searchRes.json()).data?.products?.nodes ?? [])
    : [];

  return {
    group: {
      ...group,
      targetProductImage,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
      rotationItems: group.rotationItems.map((i) => ({
        ...i,
        createdAt: i.createdAt.toISOString(),
        updatedAt: i.updatedAt.toISOString(),
      })),
    },
    searchProducts,
  };
};

// ─── Action ───────────────────────────────────────────────────────────────────

// A "renewal step" (batch) groups rotation items by stepIndex. Legacy items have
// stepIndex = null (each is its own step via stepOf = stepIndex ?? sortOrder). Before any
// step-aware mutation we make every item's stepIndex explicit so the new UI can manage steps
// cleanly. Idempotent — a no-op once normalized.
async function normalizeSteps(rotationGroupId) {
  const items = await db.rotationItem.findMany({
    where: { rotationGroupId },
    orderBy: { sortOrder: "asc" },
  });
  if (items.some((it) => it.stepIndex == null)) {
    await Promise.all(
      items.map((it) =>
        db.rotationItem.update({ where: { id: it.id }, data: { stepIndex: it.stepIndex ?? it.sortOrder } })
      )
    );
  }
}

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "updateGroup") {
    const isActive          = fd.get("isActive") === "true";
    const freeRotation      = fd.get("freeRotation") === "true";
    const keepTargetProduct = fd.get("keepTargetProduct") === "true";
    const autoFulfill       = fd.get("autoFulfill") === "true";
    const skipEnabled       = fd.get("skipEnabled") === "true";
    const skipMatchBy       = fd.get("skipMatchBy") === "PRODUCT_TITLE" ? "PRODUCT_TITLE" : "PRODUCT_ID";
    const current = await db.rotationGroup.findFirst({ where: { id: params.id, shop }, select: { skipMatchBy: true } });
    await db.rotationGroup.updateMany({ where: { id: params.id, shop }, data: { isActive, freeRotation, keepTargetProduct, autoFulfill, skipEnabled, skipMatchBy } });
    if (current && current.skipMatchBy !== skipMatchBy) {
      // Match mode changed → re-backfill both purchased lists in the new form on next renewal.
      await db.subscriptionInstance.updateMany({
        where: { rotationGroupId: params.id },
        data: { purchasedProductIds: null, purchasedProductTitles: null },
      });
    }
    return { success: "Group settings saved." };
  }

  if (intent === "changeTargetProduct") {
    const productId    = fd.get("productId")?.toString().trim();
    const productTitle = fd.get("productTitle")?.toString().trim();
    if (!productId || !productTitle) return { changeError: "Select a product." };
    const conflict = await db.rotationGroup.findFirst({
      where: { shop, targetProductId: productId, NOT: { id: params.id } },
    });
    if (conflict) return { changeError: `A rotation group for "${productTitle}" already exists.` };
    await db.rotationGroup.updateMany({
      where: { id: params.id, shop },
      data: { targetProductId: productId, targetProductTitle: productTitle },
    });
    return redirect(`/app/rotation-groups/${params.id}`);
  }

  if (intent === "deleteGroup") {
    await db.rotationGroup.deleteMany({ where: { id: params.id, shop } });
    return redirect("/app/rotation-groups");
  }

  if (intent === "addItem") {
    const productId    = fd.get("productId")?.toString().trim();
    const variantId    = fd.get("variantId")?.toString().trim();
    const productTitle = fd.get("productTitle")?.toString().trim();
    const variantTitle = fd.get("variantTitle")?.toString().trim();
    const price        = fd.get("price")?.toString().trim();
    const imageUrl     = fd.get("imageUrl")?.toString().trim();
    const stepMode     = fd.get("stepMode")?.toString();          // "new" | "existing"
    const stepIndexRaw = fd.get("stepIndex")?.toString();

    if (!productId || !variantId || !productTitle) return { error: "Select a product and variant." };

    await normalizeSteps(params.id);

    const agg = await db.rotationItem.aggregate({
      where: { rotationGroupId: params.id },
      _max: { sortOrder: true, stepIndex: true },
    });
    const nextOrder = (agg._max.sortOrder ?? -1) + 1;

    // Add to an existing renewal step, or start a new step at the end of the sequence.
    let stepIndex;
    if (stepMode === "existing" && stepIndexRaw !== undefined && stepIndexRaw !== "") {
      stepIndex = parseInt(stepIndexRaw, 10);
    } else {
      stepIndex = (agg._max.stepIndex ?? -1) + 1;
    }

    await db.rotationItem.create({
      data: { rotationGroupId: params.id, productId, variantId, productTitle, variantTitle: variantTitle || null, price: price || null, imageUrl: imageUrl || null, sortOrder: nextOrder, stepIndex, isActive: true },
    });
    return { success: "Product added to rotation." };
  }

  if (intent === "toggleItem") {
    const itemId = fd.get("itemId");
    const item = await db.rotationItem.findUnique({ where: { id: itemId } });
    if (item) await db.rotationItem.update({ where: { id: itemId }, data: { isActive: !item.isActive } });
    return null;
  }

  if (intent === "toggleItemAutoFulfill") {
    const itemId = fd.get("itemId");
    const item = await db.rotationItem.findUnique({
      where: { id: itemId },
      include: { rotationGroup: { select: { autoFulfill: true } } },
    });
    if (item) {
      // Flip the EFFECTIVE value (item override, else group default) and store it explicitly.
      const effective = item.autoFulfill ?? item.rotationGroup.autoFulfill;
      await db.rotationItem.update({ where: { id: itemId }, data: { autoFulfill: !effective } });
    }
    return null;
  }

  if (intent === "deleteItem") {
    const itemId = fd.get("itemId");
    // Just delete — stepIndex drives batches, so a step with no remaining items simply
    // disappears. Gaps in sortOrder/stepIndex are harmless (buildBatches sorts by them).
    await db.rotationItem.delete({ where: { id: itemId } });
    return null;
  }

  // Reorder a product WITHIN its renewal step (swap sortOrder with the item above/below it
  // in the same step).
  if (intent === "moveItem") {
    await normalizeSteps(params.id);
    const itemId = fd.get("itemId");
    const dir = fd.get("direction");
    const all = await db.rotationItem.findMany({ where: { rotationGroupId: params.id }, orderBy: { sortOrder: "asc" } });
    const current = all.find((i) => i.id === itemId);
    if (!current) return null;
    const sameStep = all.filter((i) => i.stepIndex === current.stepIndex);
    const idx = sameStep.findIndex((i) => i.id === itemId);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sameStep.length) return null;
    await Promise.all([
      db.rotationItem.update({ where: { id: sameStep[idx].id },     data: { sortOrder: sameStep[swapIdx].sortOrder } }),
      db.rotationItem.update({ where: { id: sameStep[swapIdx].id }, data: { sortOrder: sameStep[idx].sortOrder } }),
    ]);
    return null;
  }

  // Reorder a whole renewal step up/down (swap stepIndex with the neighbouring step, moving
  // all of its products together).
  if (intent === "moveStep") {
    await normalizeSteps(params.id);
    const stepIndex = parseInt(fd.get("stepIndex"), 10);
    const dir = fd.get("direction");
    const items = await db.rotationItem.findMany({ where: { rotationGroupId: params.id } });
    const stepKeys = [...new Set(items.map((i) => i.stepIndex))].sort((a, b) => a - b);
    const pos = stepKeys.indexOf(stepIndex);
    const swapPos = dir === "up" ? pos - 1 : pos + 1;
    if (pos === -1 || swapPos < 0 || swapPos >= stepKeys.length) return null;
    const otherStep = stepKeys[swapPos];
    await Promise.all(
      items
        .filter((it) => it.stepIndex === stepIndex || it.stepIndex === otherStep)
        .map((it) =>
          db.rotationItem.update({
            where: { id: it.id },
            data: { stepIndex: it.stepIndex === stepIndex ? otherStep : stepIndex },
          })
        )
    );
    return null;
  }

  return null;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RotationGroupDetail() {
  const { group } = useLoaderData();

  return (
    <>
      <Breadcrumbs crumbs={[
        { label: "Dashboard", href: "/app" },
        { label: "Rotation Groups", href: "/app/rotation-groups" },
        { label: group.targetProductTitle },
      ]} />
      <s-page heading={group.targetProductTitle} back-action="/app/rotation-groups">

      <GroupSettingsSection group={group} />
      <RotationSequenceSection group={group} />

      {/* ── Aside ─────────────────────────────────────────────────────────── */}
      <s-section slot="aside" heading="Rotation Logic">
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {[
            { icon: "✅", text: "Only active products are used in rotation" },
            { icon: "📅", text: "Each renewal sends one renewal step; steps cycle back to step 1 after the last" },
            { icon: "🧺", text: "A step with multiple products sends them all together; the subscription price is split evenly across them" },
            { icon: "↕️",  text: "Use ▲▼ on a step to reorder steps, and on a product to reorder it within its step" },
            { icon: "🔀", text: "Single-product steps: if variants match, each is swapped individually (Case 2), else the default variant is used (Case 1)" },
          ].map(({ icon, text }, i) => (
            <div key={i} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <span style={{ fontSize: "16px", flexShrink: 0 }}>{icon}</span>
              <span style={{ fontSize: "13px", color: "#303030", lineHeight: "1.5" }}>{text}</span>
            </div>
          ))}
        </div>
      </s-section>

      <s-section slot="aside" heading="Group Info">
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <InfoRow label="Group ID"   value={<code style={codeStyle}>{group.id}</code>} />
          <InfoRow label="Created"    value={new Date(group.createdAt).toLocaleString()} />
          <InfoRow label="Steps"      value={`${buildBatchesClient(group.rotationItems).length} renewal steps`} />
          <InfoRow label="Products"   value={`${group.rotationItems.length} rotation products`} />
        </div>
      </s-section>

    </s-page>
    </>
  );
}

// ─── Group Settings Section ───────────────────────────────────────────────────

function GroupSettingsSection({ group }) {
  const fetcher = useFetcher();
  const [isActive, setIsActive] = useState(group.isActive);
  const [freeRotation, setFreeRotation] = useState(group.freeRotation ?? false);
  const [keepTargetProduct, setKeepTargetProduct] = useState(group.keepTargetProduct ?? false);
  const [autoFulfill, setAutoFulfill] = useState(group.autoFulfill ?? false);
  const [skipEnabled, setSkipEnabled] = useState(group.skipEnabled ?? true);
  const [skipMatchBy, setSkipMatchBy] = useState(group.skipMatchBy ?? "PRODUCT_ID");
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isChangingTarget, setIsChangingTarget] = useState(false);
  const isBusy = fetcher.state !== "idle";

  return (
    <s-section heading="Group Settings">
      <ConfirmModal
        isOpen={showDeleteModal}
        icon="⚠️"
        title="Delete rotation group?"
        message={
          <span>
            <strong style={{ color: "#303030" }}>{group.targetProductTitle}</strong>
            <span style={{ display: "block", marginTop: "6px", color: "#6d7175" }}>
              All rotation items will be permanently deleted. Active subscriptions will no longer be rotated. This cannot be undone.
            </span>
          </span>
        }
        confirmLabel="Delete Group"
        confirmStyle="critical"
        onConfirm={() => { setShowDeleteModal(false); fetcher.submit({ intent: "deleteGroup" }, { method: "post" }); }}
        onCancel={() => setShowDeleteModal(false)}
      />
      {fetcher.data?.success && (
        <div style={successBanner}>{fetcher.data.success}</div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        {/* Target product info */}
        <div style={{ background: "#f6f6f7", borderRadius: "8px", padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
            <div style={{ fontSize: "11px", fontWeight: "600", color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.5px" }}>Target Product</div>
            {!isChangingTarget && (
              <button type="button" onClick={() => setIsChangingTarget(true)} style={smallSecBtn}>Change</button>
            )}
          </div>

          {!isChangingTarget ? (
            <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
              {group.targetProductImage ? (
                <img src={group.targetProductImage} alt={group.targetProductTitle} style={targetThumb} />
              ) : (
                <div style={{ ...targetThumb, background: "#e1e3e5", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "22px" }}>📦</div>
              )}
              <div>
                <div style={{ fontSize: "15px", fontWeight: "600", color: "#303030", marginBottom: "3px" }}>{group.targetProductTitle}</div>
                <div style={{ fontFamily: "monospace", fontSize: "11px", color: "#8c9196" }}>{group.targetProductId}</div>
              </div>
            </div>
          ) : (
            <ChangeTargetForm
              currentProductId={group.targetProductId}
              onCancel={() => setIsChangingTarget(false)}
            />
          )}
        </div>

        {/* Status toggle */}
        <div>
          <div style={{ fontSize: "13px", fontWeight: "600", color: "#303030", marginBottom: "8px" }}>Status</div>
          <div style={toggleContainer}>
            <button type="button" onClick={() => setIsActive(true)}  style={{ ...toggleBtn, ...(isActive ? toggleActiveGreen : {}) }}>Active</button>
            <button type="button" onClick={() => setIsActive(false)} style={{ ...toggleBtn, ...(!isActive ? toggleActiveRed : {}) }}>Inactive</button>
          </div>
          <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "6px" }}>
            {isActive ? "Rotation is enabled. Renewal orders will be rotated." : "Rotation is paused. Renewal orders will not be modified."}
          </div>
        </div>

        {/* Free rotation toggle */}
        <div
          onClick={() => setFreeRotation(!freeRotation)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px",
            padding: "14px 16px", borderRadius: "8px", cursor: "pointer",
            border: `1.5px solid ${freeRotation ? "#008060" : "#e1e3e5"}`,
            background: freeRotation ? "#f0faf6" : "#fafafa",
            transition: "all 0.18s",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={freeRotation ? "#008060" : "#6d7175"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7" strokeWidth="3"/>
              </svg>
              <span style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>Free Rotation (100% Discount)</span>
              {freeRotation && (
                <span style={{ fontSize: "10px", fontWeight: "700", color: "#008060", background: "#c9f0e1", padding: "2px 7px", borderRadius: "10px", letterSpacing: "0.4px", textTransform: "uppercase" }}>ON</span>
              )}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", lineHeight: "1.5", paddingLeft: "24px" }}>
              {freeRotation
                ? "Rotation products will be sent at 100% discount — free to the customer."
                : "Rotation products are priced to match the original subscription product."}
            </div>
          </div>

          {/* iOS-style toggle switch */}
          <div style={{
            position: "relative", width: "44px", height: "26px", borderRadius: "13px", flexShrink: 0,
            background: freeRotation ? "#008060" : "#c9cccf",
            transition: "background 0.2s",
          }}>
            <div style={{
              position: "absolute", top: "3px",
              left: freeRotation ? "21px" : "3px",
              width: "20px", height: "20px", borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
              transition: "left 0.2s",
            }} />
          </div>
        </div>

        {/* Keep target product toggle */}
        <div
          onClick={() => setKeepTargetProduct(!keepTargetProduct)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px",
            padding: "14px 16px", borderRadius: "8px", cursor: "pointer",
            border: `1.5px solid ${keepTargetProduct ? "#008060" : "#e1e3e5"}`,
            background: keepTargetProduct ? "#f0faf6" : "#fafafa",
            transition: "all 0.18s",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={keepTargetProduct ? "#008060" : "#6d7175"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
              </svg>
              <span style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>Keep Subscription Product</span>
              {keepTargetProduct && (
                <span style={{ fontSize: "10px", fontWeight: "700", color: "#008060", background: "#c9f0e1", padding: "2px 7px", borderRadius: "10px", letterSpacing: "0.4px", textTransform: "uppercase" }}>ON</span>
              )}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", lineHeight: "1.5", paddingLeft: "24px" }}>
              {keepTargetProduct
                ? "The original subscription product stays in the order; rotation product is added alongside it."
                : "The original subscription product is replaced by the rotation product."}
            </div>
          </div>

          {/* iOS-style toggle switch */}
          <div style={{
            position: "relative", width: "44px", height: "26px", borderRadius: "13px", flexShrink: 0,
            background: keepTargetProduct ? "#008060" : "#c9cccf",
            transition: "background 0.2s",
          }}>
            <div style={{
              position: "absolute", top: "3px",
              left: keepTargetProduct ? "21px" : "3px",
              width: "20px", height: "20px", borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
              transition: "left 0.2s",
            }} />
          </div>
        </div>

        {/* Auto-fulfill toggle */}
        <div
          onClick={() => setAutoFulfill(!autoFulfill)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px",
            padding: "14px 16px", borderRadius: "8px", cursor: "pointer",
            border: `1.5px solid ${autoFulfill ? "#008060" : "#e1e3e5"}`,
            background: autoFulfill ? "#f0faf6" : "#fafafa",
            transition: "all 0.18s",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={autoFulfill ? "#008060" : "#6d7175"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              <span style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>Auto-Fulfill Rotation Products (default)</span>
              {autoFulfill && (
                <span style={{ fontSize: "10px", fontWeight: "700", color: "#008060", background: "#c9f0e1", padding: "2px 7px", borderRadius: "10px", letterSpacing: "0.4px", textTransform: "uppercase" }}>ON</span>
              )}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", lineHeight: "1.5", paddingLeft: "24px" }}>
              {autoFulfill
                ? "Default for rotation products: automatically marked as fulfilled after being added. Each product can override this in the rotation sequence below."
                : "Default for rotation products: added as unfulfilled — fulfill manually. Each product can override this in the rotation sequence below."}
            </div>
          </div>

          {/* iOS-style toggle switch */}
          <div style={{
            position: "relative", width: "44px", height: "26px", borderRadius: "13px", flexShrink: 0,
            background: autoFulfill ? "#008060" : "#c9cccf",
            transition: "background 0.2s",
          }}>
            <div style={{
              position: "absolute", top: "3px",
              left: autoFulfill ? "21px" : "3px",
              width: "20px", height: "20px", borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
              transition: "left 0.2s",
            }} />
          </div>
        </div>

        {/* Skip Already-Received toggle */}
        <div
          onClick={() => setSkipEnabled(!skipEnabled)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px",
            padding: "14px 16px", borderRadius: "8px", cursor: "pointer",
            border: `1.5px solid ${skipEnabled ? "#008060" : "#e1e3e5"}`,
            background: skipEnabled ? "#f0faf6" : "#fafafa",
            transition: "all 0.18s",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={skipEnabled ? "#008060" : "#6d7175"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
              </svg>
              <span style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>Skip Already-Received Products</span>
              {skipEnabled && (
                <span style={{ fontSize: "10px", fontWeight: "700", color: "#008060", background: "#c9f0e1", padding: "2px 7px", borderRadius: "10px", letterSpacing: "0.4px", textTransform: "uppercase" }}>ON</span>
              )}
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", lineHeight: "1.5", paddingLeft: "24px" }}>
              {skipEnabled
                ? "Renewal steps whose products the customer already received are skipped — the next not-yet-received step is sent."
                : "Skip check is off — renewal steps run strictly in sequence (step 1, 2, 3 …), even if the customer already received some products."}
            </div>
          </div>

          {/* iOS-style toggle switch */}
          <div style={{
            position: "relative", width: "44px", height: "26px", borderRadius: "13px", flexShrink: 0,
            background: skipEnabled ? "#008060" : "#c9cccf",
            transition: "background 0.2s",
          }}>
            <div style={{
              position: "absolute", top: "3px",
              left: skipEnabled ? "21px" : "3px",
              width: "20px", height: "20px", borderRadius: "50%",
              background: "#fff",
              boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
              transition: "left 0.2s",
            }} />
          </div>
        </div>

        {/* Skip-match-by selector — only shown when skip is enabled */}
        {skipEnabled && (
          <div
            style={{
              padding: "14px 16px", borderRadius: "8px",
              border: "1.5px solid #e1e3e5", background: "#fafafa",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "3px" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6d7175" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <span style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>Skip Already-Received Match By</span>
            </div>
            <div style={{ fontSize: "12px", color: "#6d7175", lineHeight: "1.5", paddingLeft: "24px", marginBottom: "10px" }}>
              How the app decides a rotation product was already received by the customer.
              <strong> Product title</strong> matches the same book even if it has a different product ID (old/duplicate products); <strong>Product ID</strong> is an exact match.
            </div>
            <div style={{ display: "flex", gap: "8px", paddingLeft: "24px" }}>
              {[
                { value: "PRODUCT_ID", label: "Product ID" },
                { value: "PRODUCT_TITLE", label: "Product Title" },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSkipMatchBy(opt.value)}
                  style={{
                    padding: "7px 14px", borderRadius: "8px", fontSize: "12px", fontWeight: "600", cursor: "pointer",
                    border: `1.5px solid ${skipMatchBy === opt.value ? "#008060" : "#e1e3e5"}`,
                    background: skipMatchBy === opt.value ? "#f0faf6" : "#fff",
                    color: skipMatchBy === opt.value ? "#008060" : "#6d7175",
                    transition: "all 0.18s",
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: "10px", paddingTop: "4px" }}>
          <button
            type="button"
            onClick={() => fetcher.submit({ intent: "updateGroup", isActive: isActive.toString(), freeRotation: freeRotation.toString(), keepTargetProduct: keepTargetProduct.toString(), autoFulfill: autoFulfill.toString(), skipEnabled: skipEnabled.toString(), skipMatchBy }, { method: "post" })}
            disabled={isBusy}
            style={isBusy ? { ...primaryBtn, opacity: 0.7 } : primaryBtn}
          >
            {isBusy && fetcher.formData?.get("intent") === "updateGroup" ? "Saving…" : "Save Settings"}
          </button>
          <button
            type="button"
            onClick={() => setShowDeleteModal(true)}
            disabled={isBusy}
            style={criticalBtn}
          >
            Delete Group
          </button>
        </div>
      </div>
    </s-section>
  );
}

// ─── Rotation Sequence Section ────────────────────────────────────────────────

// Group rotation items into ordered renewal steps (batches). Mirrors the server's stepOf
// rule: stepOf = stepIndex ?? sortOrder. Items sharing a step are sent together in one renewal.
function buildBatchesClient(items) {
  const stepOf = (it) => (it.stepIndex != null ? it.stepIndex : it.sortOrder);
  const byStep = new Map();
  for (const it of items) {
    const k = stepOf(it);
    if (!byStep.has(k)) byStep.set(k, []);
    byStep.get(k).push(it);
  }
  return [...byStep.keys()]
    .sort((a, b) => a - b)
    .map((k) => ({
      stepIndex: k,
      items: byStep.get(k).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    }));
}

function RotationSequenceSection({ group }) {
  const batches = buildBatchesClient(group.rotationItems);
  const productCount = group.rotationItems.length;

  return (
    <s-section heading={`Rotation Sequence (${batches.length} renewal step${batches.length !== 1 ? "s" : ""} · ${productCount} product${productCount !== 1 ? "s" : ""})`}>
      <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px", lineHeight: "1.6" }}>
        Each renewal sends the products in <strong>one renewal step</strong>. Steps run in order; after the
        last step the sequence cycles back to step 1. A step with a single product behaves like a normal
        one-product rotation; a step with multiple products sends them all together in that renewal (the
        original subscription price is split evenly across them, unless Free Rotation is on).
      </div>

      {batches.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "24px" }}>
          {batches.map((batch, bIdx) => (
            <BatchCard
              key={batch.stepIndex}
              batch={batch}
              displayNum={bIdx + 1}
              isFirstStep={bIdx === 0}
              isLastStep={bIdx === batches.length - 1}
              groupAutoFulfill={group.autoFulfill ?? false}
            />
          ))}
        </div>
      ) : (
        <div style={emptySequence}>
          <div style={{ fontSize: "32px", marginBottom: "10px" }}>📋</div>
          <div style={{ fontSize: "14px", fontWeight: "600", color: "#303030", marginBottom: "4px" }}>No rotation products yet</div>
          <div style={{ fontSize: "13px", color: "#6d7175" }}>Search and add products below to build the rotation sequence</div>
        </div>
      )}

      {/* Add item form */}
      <div style={{ borderTop: "1px solid #e1e3e5", paddingTop: "20px" }}>
        <div style={{ fontSize: "14px", fontWeight: "600", color: "#303030", marginBottom: "16px" }}>+ Add Rotation Product</div>
        <AddItemForm batches={batches} />
      </div>
    </s-section>
  );
}

// ─── Batch (renewal step) card ────────────────────────────────────────────────

function BatchCard({ batch, displayNum, isFirstStep, isLastStep, groupAutoFulfill }) {
  const fetcher = useFetcher();
  const isBusy = fetcher.state !== "idle";
  const moveStep = (direction) =>
    fetcher.submit({ intent: "moveStep", stepIndex: String(batch.stepIndex), direction }, { method: "post" });

  return (
    <div style={{ border: "1px solid #e1e3e5", borderRadius: "10px", overflow: "hidden", opacity: isBusy ? 0.6 : 1, transition: "opacity 0.15s" }}>
      {/* Step header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", padding: "10px 14px", background: "#f6f6f7", borderBottom: "1px solid #e1e3e5" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={stepBadge}>Renewal Step {displayNum}</span>
          <span style={{ fontSize: "12px", color: "#6d7175" }}>{batch.items.length} product{batch.items.length !== 1 ? "s" : ""}</span>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          <button type="button" onClick={() => moveStep("up")}   disabled={isFirstStep || isBusy} style={{ ...iconBtn, opacity: isFirstStep ? 0.3 : 1 }} title="Move step up">▲</button>
          <button type="button" onClick={() => moveStep("down")} disabled={isLastStep  || isBusy} style={{ ...iconBtn, opacity: isLastStep  ? 0.3 : 1 }} title="Move step down">▼</button>
        </div>
      </div>

      {/* Products in this step */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ ...tableStyle, minWidth: "640px" }}>
          <thead>
            <tr>
              <th style={th}>Product</th>
              <th style={th}>Default Variant</th>
              <th style={th}>Price</th>
              <th style={th}>Status</th>
              <th style={th}>Auto-Fulfill</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {batch.items.map((item, idx) => (
              <RotationItemRow
                key={item.id}
                item={item}
                isFirst={idx === 0}
                isLast={idx === batch.items.length - 1}
                groupAutoFulfill={groupAutoFulfill}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Confirm Modal ────────────────────────────────────────────────────────────

function ConfirmModal({ isOpen, icon, title, message, confirmLabel, confirmStyle, onConfirm, onCancel }) {
  if (!isOpen) return null;
  return (
    <div style={modalOverlay} onClick={onCancel}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        {/* Icon */}
        <div style={modalIconWrap}>
          <span style={{ fontSize: "22px" }}>{icon}</span>
        </div>
        {/* Content */}
        <div style={{ flex: 1 }}>
          <div style={modalTitle}>{title}</div>
          <div style={modalMessage}>{message}</div>
        </div>
        {/* Actions */}
        <div style={modalActions}>
          <button type="button" onClick={onCancel}  style={modalCancelBtn}>Cancel</button>
          <button type="button" onClick={onConfirm} style={confirmStyle === "critical" ? modalConfirmCritBtn : modalConfirmBtn}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Item Row ─────────────────────────────────────────────────────────────────

function RotationItemRow({ item, isFirst, isLast, groupAutoFulfill }) {
  const fetcher = useFetcher();
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const isBusy = fetcher.state !== "idle";
  // Effective auto-fulfill = item override, falling back to the group default.
  const itemFulfill = item.autoFulfill ?? groupAutoFulfill;
  const isOverridden = item.autoFulfill != null;

  const submit = (intent, extra = {}) => {
    fetcher.submit({ intent, itemId: item.id, ...extra }, { method: "post" });
  };

  return (
    <>
      <ConfirmModal
        isOpen={showRemoveModal}
        icon="🗑️"
        title="Remove from rotation?"
        message={
          <span>
            <strong style={{ color: "#303030" }}>{item.productTitle}</strong>
            {item.variantTitle && item.variantTitle !== "Default Title" && (
              <span style={{ color: "#6d7175" }}> — {item.variantTitle}</span>
            )}
            <span style={{ display: "block", marginTop: "6px", color: "#6d7175" }}>
              This item will be removed from the rotation sequence. Existing orders are not affected.
            </span>
          </span>
        }
        confirmLabel="Remove"
        confirmStyle="critical"
        onConfirm={() => { setShowRemoveModal(false); submit("deleteItem"); }}
        onCancel={() => setShowRemoveModal(false)}
      />

      <tr style={{ borderBottom: "1px solid #f1f2f3", opacity: isBusy ? 0.6 : 1, transition: "opacity 0.15s" }}>
        <td style={td}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            {item.imageUrl
              ? <img src={item.imageUrl} alt="" style={itemThumb} />
              : <div style={{ ...itemThumb, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px" }}>📦</div>
            }
            <div>
              <div style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>{item.productTitle}</div>
              <div style={{ fontSize: "11px", color: "#8c9196", fontFamily: "monospace" }}>{item.productId.split("/").pop()}</div>
            </div>
          </div>
        </td>
        <td style={td}>
          <div style={{ fontSize: "13px", color: "#303030" }}>{item.variantTitle ?? "Default Title"}</div>
          <div style={{ fontSize: "11px", color: "#8c9196", fontFamily: "monospace" }}>{item.variantId.split("/").pop()}</div>
        </td>
        <td style={td}>
          <span style={{ fontSize: "13px", fontWeight: "600", color: "#303030" }}>
            {item.price ? `$${item.price}` : "—"}
          </span>
        </td>
        <td style={td}>
          <span style={item.isActive ? badgeActive : badgeInactive}>
            {item.isActive ? "Active" : "Paused"}
          </span>
        </td>
        <td style={td}>
          <div
            onClick={() => !isBusy && submit("toggleItemAutoFulfill")}
            title={
              (itemFulfill ? "Auto-fulfill ON" : "Auto-fulfill OFF") +
              (isOverridden ? " (per-product override)" : " (inherited from group default)")
            }
            style={{
              position: "relative", width: "40px", height: "23px", borderRadius: "12px", flexShrink: 0,
              background: itemFulfill ? "#008060" : "#c9cccf",
              cursor: isBusy ? "default" : "pointer", opacity: isBusy ? 0.6 : 1,
              transition: "background 0.2s",
            }}
          >
            <div style={{
              position: "absolute", top: "3px", left: itemFulfill ? "20px" : "3px",
              width: "17px", height: "17px", borderRadius: "50%", background: "#fff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.25)", transition: "left 0.2s",
            }} />
          </div>
          <div style={{ fontSize: "10px", color: isOverridden ? "#008060" : "#8c9196", marginTop: "3px" }}>
            {isOverridden ? "Override" : "Default"}
          </div>
        </td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
            <button type="button" onClick={() => submit("moveItem", { direction: "up" })}   disabled={isFirst || isBusy} style={{ ...iconBtn, opacity: isFirst ? 0.3 : 1 }} title="Move up within step">▲</button>
            <button type="button" onClick={() => submit("moveItem", { direction: "down" })} disabled={isLast  || isBusy} style={{ ...iconBtn, opacity: isLast  ? 0.3 : 1 }} title="Move down within step">▼</button>
            <button type="button" onClick={() => submit("toggleItem")} disabled={isBusy} style={smallSecBtn} title={item.isActive ? "Pause this item" : "Activate this item"}>
              {item.isActive ? "Pause" : "Activate"}
            </button>
            <button
              type="button"
              onClick={() => setShowRemoveModal(true)}
              disabled={isBusy}
              style={smallCritBtn}
              title="Remove from rotation"
            >Remove</button>
          </div>
        </td>
      </tr>
    </>
  );
}

// ─── Add Item Form ────────────────────────────────────────────────────────────

function AddItemForm({ batches = [] }) {
  const fetcher = useFetcher();
  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);
  // "new" = start a new renewal step; "existing:<stepIndex>" = add to that step.
  const [stepChoice, setStepChoice] = useState("new");

  const searchResults = fetcher.data?.searchProducts ?? [];
  const isSearching = fetcher.state === "loading";
  const isAdding    = fetcher.state === "submitting";
  const showDropdown = searchResults.length > 0 && !selectedProduct;

  function handleSearch(value) {
    setQuery(value);
    setSelectedProduct(null);
    setSelectedVariant(null);
    if (value.length >= 2) fetcher.load(`?q=${encodeURIComponent(value)}`);
  }

  function pickProduct(p) {
    setSelectedProduct(p);
    setQuery(p.title);
    if (p.variants?.nodes?.length > 0) setSelectedVariant(p.variants.nodes[0]);
  }

  function handleAdd() {
    if (!selectedProduct || !selectedVariant) return;
    const [stepMode, stepIndex] = stepChoice === "new" ? ["new", ""] : ["existing", stepChoice.split(":")[1]];
    fetcher.submit({
      intent: "addItem",
      productId:    selectedProduct.id,
      variantId:    selectedVariant.id,
      productTitle: selectedProduct.title,
      variantTitle: selectedVariant.title,
      price:        selectedVariant.price,
      imageUrl:     selectedProduct.featuredImage?.url ?? "",
      stepMode,
      stepIndex,
    }, { method: "post" });
    setQuery("");
    setSelectedProduct(null);
    setSelectedVariant(null);
    setStepChoice("new");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>

      {/* Search input */}
      <div>
        <label style={labelStyle}>Search product</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Type product name to search…"
            style={{ ...inputStyle, flex: 1 }}
            autoComplete="off"
          />
          {isSearching && (
            <div style={{ display: "flex", alignItems: "center", fontSize: "12px", color: "#6d7175", whiteSpace: "nowrap" }}>
              Searching…
            </div>
          )}
          {(query && !selectedProduct) && (
            <button type="button" onClick={() => { setQuery(""); setSelectedProduct(null); setSelectedVariant(null); }} style={smallSecBtn}>✕</button>
          )}
        </div>
      </div>

      {/* Inline search results — rendered in document flow, no overflow clipping */}
      {searchResults.length > 0 && !selectedProduct && (
        <div style={resultsListStyle}>
          <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.4px", padding: "8px 14px 4px", borderBottom: "1px solid #f1f2f3" }}>
            {searchResults.length} product{searchResults.length !== 1 ? "s" : ""} found — click to select
          </div>
          {searchResults.map((p) => (
            <div
              key={p.id}
              onClick={() => pickProduct(p)}
              style={dropItemBase}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
            >
              {p.featuredImage
                ? <img src={p.featuredImage.url} alt="" style={dropThumb} />
                : <div style={{ ...dropThumb, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center" }}>📦</div>
              }
              <div>
                <div style={{ fontSize: "13px", fontWeight: "500", color: "#303030" }}>{p.title}</div>
                <div style={{ fontSize: "11px", color: "#8c9196" }}>{p.variants?.nodes?.length ?? 0} variants available</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Variant selector */}
      {selectedProduct && (
        <div>
          <label style={labelStyle}>Select default / fallback variant</label>
          <select
            value={selectedVariant?.id ?? ""}
            onChange={(e) => {
              const v = selectedProduct.variants.nodes.find((x) => x.id === e.target.value);
              setSelectedVariant(v ?? null);
            }}
            style={selectStyle}
          >
            {selectedProduct.variants.nodes.map((v) => (
              <option key={v.id} value={v.id}>{v.title} — ${v.price}</option>
            ))}
          </select>
          <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "5px" }}>
            Used when subscription variants don't match (Case 1 fallback)
          </div>
        </div>
      )}

      {/* Renewal step selector */}
      {selectedProduct && (
        <div>
          <label style={labelStyle}>Add to renewal step</label>
          <select value={stepChoice} onChange={(e) => setStepChoice(e.target.value)} style={selectStyle}>
            <option value="new">➕ New renewal step (step {batches.length + 1})</option>
            {batches.map((b, i) => (
              <option key={b.stepIndex} value={`existing:${b.stepIndex}`}>
                Add to Renewal Step {i + 1} ({b.items.length} product{b.items.length !== 1 ? "s" : ""})
              </option>
            ))}
          </select>
          <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "5px" }}>
            A <strong>new step</strong> sends this product on its own renewal. Adding to an
            <strong> existing step</strong> sends it together with that step's other products in one renewal.
          </div>
        </div>
      )}

      {/* Selected product preview + Add button */}
      {selectedProduct && selectedVariant && (
        <div style={selectedPreview}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
            {selectedProduct.featuredImage
              ? <img src={selectedProduct.featuredImage.url} alt="" style={previewThumb} />
              : <div style={{ ...previewThumb, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center" }}>📦</div>
            }
            <div>
              <div style={{ fontSize: "14px", fontWeight: "600", color: "#303030" }}>{selectedProduct.title}</div>
              <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>
                Variant: <strong>{selectedVariant.title}</strong> · <strong>${selectedVariant.price}</strong>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            <button
              type="button"
              onClick={handleAdd}
              disabled={isAdding}
              style={isAdding ? { ...addBtn, opacity: 0.7 } : addBtn}
            >
              {isAdding ? "Adding…" : "+ Add to Rotation"}
            </button>
            <button
              type="button"
              onClick={() => { setSelectedProduct(null); setSelectedVariant(null); setQuery(""); }}
              style={smallSecBtn}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Change Target Product Form ───────────────────────────────────────────────

function ChangeTargetForm({ currentProductId, onCancel }) {
  const fetcher = useFetcher();
  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);

  const searchResults = (fetcher.data?.searchProducts ?? []).filter((p) => p.id !== currentProductId);
  const isSearching = fetcher.state === "loading";
  const isSaving    = fetcher.state === "submitting";

  function handleSearch(value) {
    setQuery(value);
    setSelectedProduct(null);
    if (value.length >= 2) fetcher.load(`?q=${encodeURIComponent(value)}`);
  }

  function handleSave() {
    if (!selectedProduct) return;
    fetcher.submit(
      { intent: "changeTargetProduct", productId: selectedProduct.id, productTitle: selectedProduct.title },
      { method: "post" },
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {fetcher.data?.changeError && (
        <div style={errorBanner}>{fetcher.data.changeError}</div>
      )}

      {/* Search input */}
      <div>
        <label style={labelStyle}>Search new target product</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder="Type product name to search…"
            style={{ ...inputStyle, flex: 1 }}
            autoComplete="off"
          />
          {isSearching && (
            <div style={{ display: "flex", alignItems: "center", fontSize: "12px", color: "#6d7175", whiteSpace: "nowrap" }}>Searching…</div>
          )}
          {query && !selectedProduct && (
            <button type="button" onClick={() => { setQuery(""); setSelectedProduct(null); }} style={smallSecBtn}>✕</button>
          )}
        </div>
      </div>

      {/* Search results */}
      {searchResults.length > 0 && !selectedProduct && (
        <div style={resultsListStyle}>
          <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.4px", padding: "8px 14px 4px", borderBottom: "1px solid #f1f2f3" }}>
            {searchResults.length} product{searchResults.length !== 1 ? "s" : ""} found — click to select
          </div>
          {searchResults.map((p) => (
            <div
              key={p.id}
              onClick={() => { setSelectedProduct(p); setQuery(p.title); }}
              style={dropItemBase}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
            >
              {p.featuredImage
                ? <img src={p.featuredImage.url} alt="" style={dropThumb} />
                : <div style={{ ...dropThumb, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center" }}>📦</div>
              }
              <div>
                <div style={{ fontSize: "13px", fontWeight: "500", color: "#303030" }}>{p.title}</div>
                <div style={{ fontSize: "11px", color: "#8c9196" }}>{p.variants?.nodes?.length ?? 0} variants</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Selected preview + save */}
      {selectedProduct ? (
        <div style={selectedPreview}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", flex: 1 }}>
            {selectedProduct.featuredImage
              ? <img src={selectedProduct.featuredImage.url} alt="" style={previewThumb} />
              : <div style={{ ...previewThumb, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center" }}>📦</div>
            }
            <div>
              <div style={{ fontSize: "14px", fontWeight: "600", color: "#303030" }}>{selectedProduct.title}</div>
              <div style={{ fontSize: "12px", color: "#6d7175", marginTop: "2px" }}>New target product</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px", flexShrink: 0 }}>
            <button type="button" onClick={handleSave} disabled={isSaving} style={isSaving ? { ...addBtn, opacity: 0.7 } : addBtn}>
              {isSaving ? "Saving…" : "Save Target"}
            </button>
            <button type="button" onClick={() => { setSelectedProduct(null); setQuery(""); }} style={smallSecBtn}>Clear</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={onCancel} style={smallSecBtn}>Cancel</button>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function InfoRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px", gap: "12px" }}>
      <span style={{ color: "#6d7175", fontWeight: "500", flexShrink: 0 }}>{label}</span>
      <span style={{ color: "#303030", textAlign: "right" }}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const primaryBtn   = { background: "#303030", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 18px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const criticalBtn  = { background: "#fff", color: "#d82c0d", border: "1px solid #f5c6c2", borderRadius: "8px", padding: "8px 18px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const smallSecBtn  = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "6px", padding: "5px 10px", fontSize: "12px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const smallCritBtn = { background: "#fff", color: "#d82c0d", border: "1px solid #f5c6c2", borderRadius: "6px", padding: "5px 10px", fontSize: "12px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const iconBtn      = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "6px", padding: "5px 7px", fontSize: "12px", cursor: "pointer", fontFamily: "inherit", lineHeight: "1" };
const addBtn       = { background: "#303030", color: "#fff", border: "none", borderRadius: "6px", padding: "7px 14px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };

const toggleContainer = { display: "inline-flex", background: "#f1f2f3", borderRadius: "8px", padding: "3px", gap: "2px" };
const toggleBtn        = { background: "transparent", color: "#6d7175", border: "none", borderRadius: "6px", padding: "7px 16px", fontSize: "13px", cursor: "pointer", fontWeight: "500", fontFamily: "inherit", transition: "all 0.15s" };
const toggleActiveGreen = { background: "#008060", color: "#fff" };
const toggleActiveRed   = { background: "#d82c0d", color: "#fff" };

const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };
const th = { padding: "10px 14px", textAlign: "left", fontWeight: "600", fontSize: "11px", color: "#6d7175", borderBottom: "2px solid #e1e3e5", background: "#fafafa", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" };
const td = { padding: "12px 14px", verticalAlign: "middle" };

const badgeActive   = { background: "#e3f5e9", color: "#008060", fontSize: "11px", fontWeight: "600", padding: "3px 9px", borderRadius: "12px" };
const badgeInactive = { background: "#f6f6f7", color: "#6d7175", fontSize: "11px", fontWeight: "600", padding: "3px 9px", borderRadius: "12px" };

const targetThumb  = { width: "64px", height: "64px", objectFit: "cover", borderRadius: "8px", flexShrink: 0, border: "1px solid #d9dadb" };
const posNumber    = { width: "26px", height: "26px", borderRadius: "50%", background: "#303030", color: "#fff", fontSize: "11px", fontWeight: "700", display: "flex", alignItems: "center", justifyContent: "center" };
const stepBadge    = { background: "#303030", color: "#fff", fontSize: "12px", fontWeight: "700", padding: "4px 12px", borderRadius: "14px", letterSpacing: "0.2px" };
const itemThumb    = { width: "40px", height: "40px", objectFit: "cover", borderRadius: "6px", flexShrink: 0, border: "1px solid #e1e3e5" };
const emptySequence = { textAlign: "center", padding: "36px 20px", background: "#fafafa", borderRadius: "8px", border: "1px dashed #c9cccf", marginBottom: "24px" };

const labelStyle   = { display: "block", marginBottom: "7px", fontSize: "13px", fontWeight: "600", color: "#303030" };
const inputStyle   = { width: "100%", padding: "9px 12px", border: "1px solid #c9cccf", borderRadius: "8px", fontSize: "13px", boxSizing: "border-box", fontFamily: "inherit", outline: "none" };
const selectStyle  = { width: "100%", padding: "9px 12px", border: "1px solid #c9cccf", borderRadius: "8px", fontSize: "13px", fontFamily: "inherit" };
const resultsListStyle = { border: "1px solid #c9cccf", borderRadius: "8px", overflow: "hidden", background: "#fff" };
const dropItemBase = { display: "flex", alignItems: "center", gap: "10px", padding: "10px 14px", cursor: "pointer", background: "#fff", borderBottom: "1px solid #f1f2f3", transition: "background 0.1s" };
const dropThumb    = { width: "40px", height: "40px", objectFit: "cover", borderRadius: "6px", flexShrink: 0, border: "1px solid #e1e3e5" };

const selectedPreview = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "16px", background: "#f6f6f7", border: "1px solid #e1e3e5", borderRadius: "8px", flexWrap: "wrap" };
const previewThumb = { width: "48px", height: "48px", objectFit: "cover", borderRadius: "6px", border: "1px solid #e1e3e5", flexShrink: 0 };

const successBanner = { background: "#e3f5e9", color: "#008060", border: "1px solid #b3dfcc", borderRadius: "8px", padding: "10px 14px", fontSize: "13px", marginBottom: "16px" };
const errorBanner   = { background: "#fff4f4", color: "#d82c0d", border: "1px solid #f5c6c2", borderRadius: "8px", padding: "10px 14px", fontSize: "13px" };
const codeStyle = { fontSize: "11px", background: "#f6f6f7", padding: "2px 6px", borderRadius: "4px", fontFamily: "monospace", wordBreak: "break-all" };

// ─── Modal styles ─────────────────────────────────────────────────────────────

const modalOverlay = {
  position: "fixed", inset: 0, zIndex: 1000,
  background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center",
  padding: "20px",
};
const modalCard = {
  background: "#fff",
  borderRadius: "12px",
  boxShadow: "0 8px 32px rgba(0,0,0,0.18), 0 2px 8px rgba(0,0,0,0.10)",
  padding: "24px",
  width: "100%",
  maxWidth: "420px",
  display: "flex",
  flexDirection: "column",
  gap: "16px",
  animation: "modalIn 0.15s ease",
};
const modalIconWrap = {
  width: "44px", height: "44px", borderRadius: "50%",
  background: "#fff5e5", border: "1px solid #ffc453",
  display: "flex", alignItems: "center", justifyContent: "center",
  flexShrink: 0,
};
const modalTitle   = { fontSize: "16px", fontWeight: "700", color: "#303030", marginBottom: "4px" };
const modalMessage = { fontSize: "13px", color: "#6d7175", lineHeight: "1.6" };
const modalActions = { display: "flex", justifyContent: "flex-end", gap: "8px", paddingTop: "4px" };
const modalCancelBtn     = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "8px", padding: "9px 18px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const modalConfirmBtn    = { background: "#303030", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 18px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const modalConfirmCritBtn = { background: "#d82c0d", color: "#fff", border: "none", borderRadius: "8px", padding: "9px 18px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };

export const headers = (headersArgs) => boundary.headers(headersArgs);
