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

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "updateGroup") {
    const isActive = fd.get("isActive") === "true";
    await db.rotationGroup.updateMany({ where: { id: params.id, shop }, data: { isActive } });
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

    if (!productId || !variantId || !productTitle) return { error: "Select a product and variant." };

    const max = await db.rotationItem.aggregate({
      where: { rotationGroupId: params.id },
      _max: { sortOrder: true },
    });
    const nextOrder = (max._max.sortOrder ?? -1) + 1;

    await db.rotationItem.create({
      data: { rotationGroupId: params.id, productId, variantId, productTitle, variantTitle: variantTitle || null, price: price || null, imageUrl: imageUrl || null, sortOrder: nextOrder, isActive: true },
    });
    return { success: "Item added to rotation." };
  }

  if (intent === "toggleItem") {
    const itemId = fd.get("itemId");
    const item = await db.rotationItem.findUnique({ where: { id: itemId } });
    if (item) await db.rotationItem.update({ where: { id: itemId }, data: { isActive: !item.isActive } });
    return null;
  }

  if (intent === "deleteItem") {
    const itemId = fd.get("itemId");
    await db.rotationItem.delete({ where: { id: itemId } });
    const remaining = await db.rotationItem.findMany({ where: { rotationGroupId: params.id }, orderBy: { sortOrder: "asc" } });
    await Promise.all(remaining.map((item, idx) => db.rotationItem.update({ where: { id: item.id }, data: { sortOrder: idx } })));
    return null;
  }

  if (intent === "moveItem") {
    const itemId = fd.get("itemId");
    const dir = fd.get("direction");
    const items = await db.rotationItem.findMany({ where: { rotationGroupId: params.id }, orderBy: { sortOrder: "asc" } });
    const idx = items.findIndex((i) => i.id === itemId);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= items.length) return null;
    await Promise.all([
      db.rotationItem.update({ where: { id: items[idx].id },     data: { sortOrder: items[swapIdx].sortOrder } }),
      db.rotationItem.update({ where: { id: items[swapIdx].id }, data: { sortOrder: items[idx].sortOrder } }),
    ]);
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
            { icon: "✅", text: "Only active items are used in rotation" },
            { icon: "↕️",  text: "Position determines order; use ▲▼ to reorder" },
            { icon: "🔀", text: "If variants match subscription variants, each is swapped individually (Case 2)" },
            { icon: "📦", text: "Otherwise, default variant is used at combined quantity and price (Case 1)" },
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
          <InfoRow label="Items"      value={`${group.rotationItems.length} rotation products`} />
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

        {/* Action buttons */}
        <div style={{ display: "flex", gap: "10px", paddingTop: "4px" }}>
          <button
            type="button"
            onClick={() => fetcher.submit({ intent: "updateGroup", isActive: isActive.toString() }, { method: "post" })}
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

function RotationSequenceSection({ group }) {
  return (
    <s-section heading={`Rotation Sequence (${group.rotationItems.length} item${group.rotationItems.length !== 1 ? "s" : ""})`}>
      <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px" }}>
        Products rotate in order on each renewal. After the last item, the sequence cycles back to position 1.
      </div>

      {group.rotationItems.length > 0 ? (
        <div style={{ border: "1px solid #e1e3e5", borderRadius: "8px", marginBottom: "24px" }}>
          <div style={{ overflowX: "auto" }}>
          <table style={{ ...tableStyle, minWidth: "680px" }}>
            <thead>
              <tr>
                <th style={th}>#</th>
                <th style={th}>Product</th>
                <th style={th}>Default Variant</th>
                <th style={th}>Price</th>
                <th style={th}>Status</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {group.rotationItems.map((item, idx) => (
                <RotationItemRow
                  key={item.id}
                  item={item}
                  idx={idx}
                  isFirst={idx === 0}
                  isLast={idx === group.rotationItems.length - 1}
                />
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div style={emptySequence}>
          <div style={{ fontSize: "32px", marginBottom: "10px" }}>📋</div>
          <div style={{ fontSize: "14px", fontWeight: "600", color: "#303030", marginBottom: "4px" }}>No rotation items yet</div>
          <div style={{ fontSize: "13px", color: "#6d7175" }}>Search and add products below to build the rotation sequence</div>
        </div>
      )}

      {/* Add item form */}
      <div style={{ borderTop: "1px solid #e1e3e5", paddingTop: "20px" }}>
        <div style={{ fontSize: "14px", fontWeight: "600", color: "#303030", marginBottom: "16px" }}>+ Add Rotation Product</div>
        <AddItemForm />
      </div>
    </s-section>
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

function RotationItemRow({ item, idx, isFirst, isLast }) {
  const fetcher = useFetcher();
  const [showRemoveModal, setShowRemoveModal] = useState(false);
  const isBusy = fetcher.state !== "idle";

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
          <div style={posNumber}>{idx + 1}</div>
        </td>
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
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
            <button type="button" onClick={() => submit("moveItem", { direction: "up" })}   disabled={isFirst || isBusy} style={{ ...iconBtn, opacity: isFirst ? 0.3 : 1 }} title="Move up">▲</button>
            <button type="button" onClick={() => submit("moveItem", { direction: "down" })} disabled={isLast  || isBusy} style={{ ...iconBtn, opacity: isLast  ? 0.3 : 1 }} title="Move down">▼</button>
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

function AddItemForm() {
  const fetcher = useFetcher();
  const [query, setQuery] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedVariant, setSelectedVariant] = useState(null);

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
    fetcher.submit({
      intent: "addItem",
      productId:    selectedProduct.id,
      variantId:    selectedVariant.id,
      productTitle: selectedProduct.title,
      variantTitle: selectedVariant.title,
      price:        selectedVariant.price,
      imageUrl:     selectedProduct.featuredImage?.url ?? "",
    }, { method: "post" });
    setQuery("");
    setSelectedProduct(null);
    setSelectedVariant(null);
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
