import { useLoaderData, useFetcher, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const groups = await db.rotationGroup.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { rotationItems: true, instances: true } } },
  });

  return {
    groups: groups.map((g) => ({
      ...g,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const fd = await request.formData();
  const intent = fd.get("intent");

  if (intent === "delete") {
    await db.rotationGroup.deleteMany({ where: { id: String(fd.get("id")), shop } });
  }

  if (intent === "toggle") {
    const id = String(fd.get("id"));
    const group = await db.rotationGroup.findFirst({ where: { id, shop } });
    if (group) await db.rotationGroup.update({ where: { id }, data: { isActive: !group.isActive } });
  }

  return null;
};

export default function RotationGroupsList() {
  const { groups } = useLoaderData();

  return (
    <s-page heading="Rotation Groups" back-action="/app">
      <s-button slot="primary-action" href="/app/rotation-groups/new" variant="primary">
        + Add Target Product
      </s-button>

      {groups.length === 0 ? (
        <s-section>
          <div style={emptyState}>
            <div style={{ fontSize: "44px", marginBottom: "14px" }}>🎯</div>
            <div style={{ fontSize: "16px", fontWeight: "600", color: "#303030", marginBottom: "8px" }}>No rotation groups yet</div>
            <div style={{ fontSize: "13px", color: "#6d7175", marginBottom: "20px" }}>
              Add a target subscription product to start setting up rotation sequences
            </div>
            <s-button href="/app/rotation-groups/new" variant="primary">+ Add Target Product</s-button>
          </div>
        </s-section>
      ) : (
        <s-section heading={`${groups.length} target product${groups.length !== 1 ? "s" : ""} configured`}>
          <div style={{ borderRadius: "8px", border: "1px solid #e1e3e5", overflow: "hidden" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={th}>Target Product</th>
                  <th style={th}>Rotation Items</th>
                  <th style={th}>Active Subs</th>
                  <th style={th}>Status</th>
                  <th style={th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <GroupRow key={group.id} group={group} />
                ))}
              </tbody>
            </table>
          </div>
        </s-section>
      )}
    </s-page>
  );
}

function GroupRow({ group }) {
  const fetcher = useFetcher();
  const isBusy = fetcher.state !== "idle";

  const toggle = () => fetcher.submit({ intent: "toggle", id: group.id }, { method: "post" });
  const remove = () => {
    if (confirm(`Delete "${group.targetProductTitle}"?\n\nAll rotation items and subscription instances will be removed.`)) {
      fetcher.submit({ intent: "delete", id: group.id }, { method: "post" });
    }
  };

  return (
    <tr style={{ borderBottom: "1px solid #f1f2f3", opacity: isBusy ? 0.6 : 1, transition: "opacity 0.15s" }}>
      <td style={td}>
        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <Link to={`/app/rotation-groups/${group.id}`} style={{ fontSize: "14px", fontWeight: "600", color: "#2c6ecb", textDecoration: "none" }}>
            {group.targetProductTitle}
          </Link>
          <span style={{ fontSize: "11px", color: "#8c9196", fontFamily: "monospace" }}>
            {group.targetProductId.split("/").pop()}
          </span>
        </div>
      </td>
      <td style={td}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "18px", fontWeight: "700", color: "#303030" }}>{group._count.rotationItems}</span>
          <span style={{ fontSize: "12px", color: "#8c9196" }}>items</span>
        </div>
      </td>
      <td style={td}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "18px", fontWeight: "700", color: "#303030" }}>{group._count.instances}</span>
          <span style={{ fontSize: "12px", color: "#8c9196" }}>subs</span>
        </div>
      </td>
      <td style={td}>
        <span style={group.isActive ? badgeActive : badgeInactive}>
          {group.isActive ? "Active" : "Inactive"}
        </span>
      </td>
      <td style={td}>
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
          <Link to={`/app/rotation-groups/${group.id}`} style={btnSecondary}>Edit</Link>
          <button type="button" onClick={toggle} disabled={isBusy} style={btnSecondary}>
            {group.isActive ? "Pause" : "Activate"}
          </button>
          <button type="button" onClick={remove} disabled={isBusy} style={btnCritical}>
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}

const emptyState = { textAlign: "center", padding: "60px 20px", color: "#6d7175", background: "#fafafa", borderRadius: "8px" };
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };
const th = { padding: "11px 16px", textAlign: "left", fontWeight: "600", fontSize: "11px", color: "#6d7175", borderBottom: "2px solid #e1e3e5", background: "#fafafa", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" };
const td = { padding: "14px 16px", verticalAlign: "middle" };
const badgeActive   = { background: "#e3f5e9", color: "#008060", fontSize: "11px", fontWeight: "600", padding: "4px 10px", borderRadius: "12px" };
const badgeInactive = { background: "#fce8e8", color: "#d82c0d", fontSize: "11px", fontWeight: "600", padding: "4px 10px", borderRadius: "12px" };
const btnSecondary = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "6px", padding: "5px 12px", fontSize: "12px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit", textDecoration: "none", display: "inline-block" };
const btnCritical  = { background: "#fff", color: "#d82c0d", border: "1px solid #f5c6c2", borderRadius: "6px", padding: "5px 12px", fontSize: "12px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };

export const headers = (headersArgs) => boundary.headers(headersArgs);
