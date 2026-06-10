import { useState, useRef } from "react";
import { Form, redirect, useLoaderData, useFetcher, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { Breadcrumbs } from "../components/Breadcrumbs";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();

  if (!q) return { products: [], shop: session.shop };

  const res = await admin.graphql(`
    query SearchProducts($query: String!) {
      products(first: 8, query: $query) {
        nodes {
          id title
          featuredImage { url }
          variants(first: 1) { nodes { id title price } }
        }
      }
    }
  `, { variables: { query: q } });

  const json = await res.json();
  return { products: json.data?.products?.nodes ?? [], shop: session.shop };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();

  const targetProductId    = fd.get("targetProductId")?.toString().trim();
  const targetProductTitle = fd.get("targetProductTitle")?.toString().trim();

  if (!targetProductId || !targetProductTitle) {
    return { error: "Select a target subscription product." };
  }

  await db.shopSetting.upsert({ where: { shop }, create: { shop }, update: {} });

  const group = await db.rotationGroup.upsert({
    where: { shop_targetProductId: { shop, targetProductId } },
    create: { shop, targetProductId, targetProductTitle, isActive: true },
    update: { targetProductTitle, isActive: true },
  });

  return redirect(`/app/rotation-groups/${group.id}`);
};

export default function NewRotationGroup() {
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const formRef = useRef(null);
  const isSubmitting = navigation.state === "submitting";

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);

  const searchResults = fetcher.data?.products ?? [];
  const isSearching = fetcher.state === "loading";
  const showDropdown = searchResults.length > 0 && !selected;

  function handleSearch(value) {
    setQuery(value);
    if (value.length >= 2) {
      fetcher.load(`/app/rotation-groups/new?q=${encodeURIComponent(value)}`);
    }
    if (!value) setSelected(null);
  }

  function selectProduct(product) {
    setSelected({ id: product.id, title: product.title, image: product.featuredImage?.url });
    setQuery(product.title);
  }

  return (
    <>
      <Breadcrumbs crumbs={[
        { label: "Dashboard", href: "/app" },
        { label: "Rotation Groups", href: "/app/rotation-groups" },
        { label: "Add Target Product" },
      ]} />
      <s-page heading="Add Target Subscription Product" back-action="/app/rotation-groups">

      <s-section heading="Search & Select Target Product">
        <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px", lineHeight: "1.5" }}>
          Search for the subscription product you want to rotate. This is the product customers initially subscribe to.
          On each renewal order, it will be replaced by the next product in your rotation sequence.
        </div>

        {/* Search box */}
        <div style={searchWrapper}>
          <label style={labelStyle}>Search product by title</label>
          <div style={{ position: "relative" }}>
            <div style={searchIconWrapper}>🔍</div>
            <input
              type="text"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
              placeholder="e.g. Growing Up Guide For Teens"
              style={searchInput}
              autoComplete="off"
            />
            {isSearching && (
              <div style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", fontSize: "12px", color: "#6d7175" }}>
                Searching…
              </div>
            )}
              </div>
        </div>

        {/* Inline search results — no overflow clipping issues */}
        {showDropdown && (
          <div style={resultsListStyle}>
            <div style={{ fontSize: "11px", color: "#6d7175", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.4px", padding: "8px 14px 4px", borderBottom: "1px solid #f1f2f3" }}>
              {searchResults.length} product{searchResults.length !== 1 ? "s" : ""} found — click to select
            </div>
            {searchResults.map((p) => (
              <div
                key={p.id}
                onClick={() => selectProduct(p)}
                style={dropItemStyle}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f3f4f6")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#fff")}
              >
                {p.featuredImage
                  ? <img src={p.featuredImage.url} alt="" style={thumbStyle} />
                  : <div style={{ ...thumbStyle, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center" }}>📦</div>
                }
                <div>
                  <div style={{ fontSize: "14px", fontWeight: "500", color: "#303030" }}>{p.title}</div>
                  <div style={{ fontSize: "11px", color: "#8c9196", fontFamily: "monospace" }}>{p.id.split("/").pop()}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Selected product card */}
        {selected && (
          <div style={selectedCard}>
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flex: 1 }}>
              {selected.image
                ? <img src={selected.image} alt="" style={selectedThumb} />
                : <div style={{ ...selectedThumb, background: "#f1f2f3", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px" }}>📦</div>
              }
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                  <span style={selectedBadge}>✓ Selected</span>
                </div>
                <div style={{ fontSize: "15px", fontWeight: "600", color: "#303030" }}>{selected.title}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => { setSelected(null); setQuery(""); }}
              style={changeBtn}
            >
              Change
            </button>
          </div>
        )}

        {/* Action form */}
        {selected && (
          <Form method="post" ref={formRef}>
            <input type="hidden" name="targetProductId"    value={selected.id} />
            <input type="hidden" name="targetProductTitle" value={selected.title} />
            <div style={{ display: "flex", gap: "10px", marginTop: "20px" }}>
              <button
                type="button"
                onClick={() => formRef.current?.requestSubmit()}
                disabled={isSubmitting}
                style={isSubmitting ? { ...primaryBtn, opacity: 0.7 } : primaryBtn}
              >
                {isSubmitting ? "Creating…" : "Create Rotation Group →"}
              </button>
              <s-button href="/app/rotation-groups" variant="secondary">Cancel</s-button>
            </div>
          </Form>
        )}
      </s-section>

      <s-section slot="aside" heading="What is a Rotation Group?">
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {[
            { icon: "🎯", text: "A rotation group links one target subscription product to an ordered list of replacement products" },
            { icon: "🔄", text: "On each renewal order, the next product in the list is substituted automatically" },
            { icon: "↩️", text: "When the list ends, it cycles back to the first product" },
          ].map(({ icon, text }, i) => (
            <div key={i} style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <span style={{ fontSize: "18px", flexShrink: 0 }}>{icon}</span>
              <span style={{ fontSize: "13px", color: "#303030", lineHeight: "1.5" }}>{text}</span>
            </div>
          ))}
        </div>
      </s-section>

    </s-page>
    </>
  );
}

const labelStyle   = { display: "block", marginBottom: "8px", fontSize: "13px", fontWeight: "600", color: "#303030" };
const searchWrapper = { position: "relative", marginBottom: "16px" };
const searchIconWrapper = { position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", fontSize: "14px", zIndex: 1, pointerEvents: "none" };
const searchInput   = { width: "100%", padding: "10px 12px 10px 36px", border: "1px solid #c9cccf", borderRadius: "8px", fontSize: "14px", boxSizing: "border-box", fontFamily: "inherit", outline: "none" };
const resultsListStyle = { border: "1px solid #c9cccf", borderRadius: "8px", overflow: "hidden", background: "#fff" };
const dropItemStyle = { display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", cursor: "pointer", background: "#fff", borderBottom: "1px solid #f1f2f3", transition: "background 0.1s" };
const thumbStyle   = { width: "44px", height: "44px", objectFit: "cover", borderRadius: "6px", flexShrink: 0, border: "1px solid #e1e3e5" };
const selectedCard = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px", padding: "16px 20px", background: "#f1fbf6", border: "1px solid #c3e6cc", borderRadius: "10px" };
const selectedThumb = { width: "52px", height: "52px", objectFit: "cover", borderRadius: "8px", border: "1px solid #b3dfcc", flexShrink: 0 };
const selectedBadge = { background: "#008060", color: "#fff", fontSize: "11px", fontWeight: "600", padding: "3px 8px", borderRadius: "12px" };
const changeBtn    = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "6px", padding: "6px 12px", fontSize: "12px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" };
const primaryBtn   = { background: "#303030", color: "#fff", border: "none", borderRadius: "8px", padding: "10px 20px", fontSize: "14px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };

export const headers = (headersArgs) => boundary.headers(headersArgs);
