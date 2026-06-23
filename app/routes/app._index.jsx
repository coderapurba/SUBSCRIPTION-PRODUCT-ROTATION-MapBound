import { useLoaderData, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [groupCount, activeItemCount, totalLogs, recentLogs] =
    await Promise.all([
      db.rotationGroup.count({ where: { shop, isActive: true } }),
      db.rotationItem.count({
        where: { rotationGroup: { shop }, isActive: true },
      }),
      db.rotationLog.count({ where: { shop } }),
      db.rotationLog.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: {
          id: true,
          orderId: true,
          customerId: true,
          targetProductTitle: true,
          rotationProductTitle: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

  return {
    shop,
    stats: { groupCount, activeItemCount, totalLogs },
    checklist: { hasGroups: groupCount > 0, hasItems: activeItemCount > 0 },
    recentLogs: recentLogs.map((l) => ({
      ...l,
      createdAt: l.createdAt.toISOString(),
    })),
  };
};

export default function Dashboard() {
  const { shop, stats, checklist, recentLogs } = useLoaderData();
  const setupDone = checklist.hasGroups && checklist.hasItems;

  return (
    <s-page heading="Subscription Product Rotation">
      {/* ── Stats ─────────────────────────────────────────────────────────── */}
      <s-section heading="Overview">
        <div style={statsGrid}>
          <StatCard
            value={stats.groupCount}
            label="Target Products"
            icon="🎯"
            href="/app/rotation-groups"
          />
          <StatCard
            value={stats.activeItemCount}
            label="Rotation Items"
            icon="🔄"
          />
          <StatCard
            value={stats.totalLogs}
            label="Total Rotations"
            icon="📊"
            href="/app/rotation-logs"
          />
        </div>
      </s-section>

      {/* ── Setup Checklist ───────────────────────────────────────────────── */}
      {!setupDone && (
        <s-section heading="Setup Checklist">
          <div style={warningBanner}>
            <span>⚠️</span>
            <span>Complete these steps before rotations can run</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <CheckItem
              done={checklist.hasGroups}
              label="Add at least one target subscription product"
              href="/app/rotation-groups/new"
            />
            <CheckItem
              done={checklist.hasItems}
              label="Add rotation products to each group"
              href="/app/rotation-groups"
            />
            <CheckItem
              done
              label="orders/create webhook registered (shopify.app.toml)"
            />
          </div>
        </s-section>
      )}

      {/* ── Quick Actions ─────────────────────────────────────────────────── */}
      <s-section heading="Quick Actions">
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <s-button href="/app/rotation-groups/new" variant="primary">
            + Add Target Product
          </s-button>
          <s-button href="/app/rotation-groups" variant="secondary">
            Manage Groups
          </s-button>
          <s-button href="/app/rotation-logs" variant="secondary">
            View Logs
          </s-button>
        </div>
      </s-section>

      {/* ── Recent Rotations ──────────────────────────────────────────────── */}
      <s-section heading="Recent Rotations">
        {recentLogs.length === 0 ? (
          <div style={emptyState}>
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>🔄</div>
            <div
              style={{
                fontSize: "15px",
                fontWeight: "600",
                color: "#303030",
                marginBottom: "6px",
              }}
            >
              No rotations yet
            </div>
            <div style={{ fontSize: "13px", color: "#6d7175" }}>
              Rotations appear here after renewal orders are processed
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                overflowX: "auto",
                borderRadius: "8px",
                border: "1px solid #e1e3e5",
              }}
            >
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Order</th>
                    <th style={th}>From</th>
                    <th style={th}>→ To</th>
                    <th style={th}>Status</th>
                    <th style={th}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLogs.map((log) => (
                    <tr key={log.id}>
                      <td style={td}>
                        <code
                          style={{
                            fontSize: "12px",
                            background: "#f6f6f7",
                            padding: "2px 6px",
                            borderRadius: "4px",
                          }}
                        >
                          #{log.orderId.split("/").pop()}
                        </code>
                      </td>
                      <td style={td}>
                        <span style={{ color: "#6d7175" }}>
                          {log.targetProductTitle || "—"}
                        </span>
                      </td>
                      <td style={td}>
                        <span style={{ fontWeight: "500" }}>
                          {log.rotationProductTitle}
                        </span>
                      </td>
                      <td style={td}>
                        <StatusBadge status={log.status} />
                      </td>
                      <td style={td}>
                        <span style={{ color: "#6d7175" }}>
                          {new Date(log.createdAt).toLocaleDateString()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ paddingTop: "12px" }}>
              <Link
                to="/app/rotation-logs"
                style={{
                  color: "#2c6ecb",
                  textDecoration: "none",
                  fontSize: "13px",
                }}
              >
                View all logs →
              </Link>
            </div>
          </>
        )}
      </s-section>

      {/* ── Aside ─────────────────────────────────────────────────────────── */}
      <s-section slot="aside" heading="How It Works">
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {[
            "Add a target subscription product from your store",
            "Add rotation products in order — they replace the subscription product on each renewal",
            "On the first order, the original product is kept and a rotation instance is created",
            "On each renewal, the next rotation product is swapped in automatically",
            "Prices are matched using order edit discounts",
          ].map((text, i) => (
            <div
              key={i}
              style={{ display: "flex", gap: "10px", alignItems: "flex-start" }}
            >
              <div style={stepDot}>{i + 1}</div>
              <div
                style={{
                  fontSize: "13px",
                  color: "#303030",
                  lineHeight: "1.5",
                  paddingTop: "2px",
                }}
              >
                {text}
              </div>
            </div>
          ))}
        </div>
      </s-section>

      <s-section slot="aside" heading="Connected Store">
        <div
          style={{
            background: "#f6f6f7",
            borderRadius: "6px",
            padding: "10px 12px",
            fontFamily: "monospace",
            fontSize: "12px",
            color: "#303030",
            wordBreak: "break-all",
          }}
        >
          {shop}
        </div>
      </s-section>
    </s-page>
  );
}

function StatCard({ value, label, icon, href }) {
  const card = (
    <div style={statCard}>
      <div style={{ fontSize: "26px", marginBottom: "10px" }}>{icon}</div>
      <div
        style={{
          fontSize: "32px",
          fontWeight: "700",
          color: "#303030",
          lineHeight: "1",
          marginBottom: "6px",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: "12px",
          color: "#6d7175",
          fontWeight: "500",
          textTransform: "uppercase",
          letterSpacing: "0.4px",
        }}
      >
        {label}
      </div>
      {href && (
        <div style={{ marginTop: "10px", fontSize: "12px", color: "#2c6ecb" }}>
          View →
        </div>
      )}
    </div>
  );
  return href ? (
    <Link to={href} style={{ textDecoration: "none" }}>
      {card}
    </Link>
  ) : (
    card
  );
}

function CheckItem({ done, label, href }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 16px",
        borderRadius: "8px",
        background: done ? "#f1fbf6" : "#fafafa",
        border: `1px solid ${done ? "#c3e6cc" : "#e1e3e5"}`,
      }}
    >
      <span style={{ fontSize: "16px", flexShrink: 0 }}>
        {done ? "✅" : "⬜"}
      </span>
      {href && !done ? (
        <Link
          to={href}
          style={{ fontSize: "13px", color: "#2c6ecb", textDecoration: "none" }}
        >
          {label}
        </Link>
      ) : (
        <span style={{ fontSize: "13px", color: done ? "#008060" : "#6d7175" }}>
          {label}
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    SUCCESS: { bg: "#e3f5e9", color: "#008060" },
    FAILED: { bg: "#fce8e8", color: "#d82c0d" },
    SKIPPED: { bg: "#fff5e5", color: "#b98900" },
  };
  const s = map[status] ?? { bg: "#f1f2f3", color: "#6d7175" };
  return (
    <span
      style={{
        background: s.bg,
        color: s.color,
        fontSize: "11px",
        fontWeight: "600",
        padding: "3px 8px",
        borderRadius: "12px",
      }}
    >
      {status}
    </span>
  );
}

const statsGrid = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: "12px",
};
const statCard = {
  background: "#fff",
  border: "1px solid #e1e3e5",
  borderRadius: "10px",
  padding: "20px 16px",
  textAlign: "center",
};
const warningBanner = {
  background: "#fff8e1",
  border: "1px solid #ffc453",
  borderRadius: "8px",
  padding: "12px 16px",
  marginBottom: "16px",
  fontSize: "13px",
  color: "#5c4813",
  display: "flex",
  alignItems: "center",
  gap: "8px",
};
const emptyState = {
  textAlign: "center",
  padding: "48px 20px",
  color: "#6d7175",
  background: "#fafafa",
  borderRadius: "8px",
  border: "1px dashed #c9cccf",
};
const stepDot = {
  minWidth: "22px",
  height: "22px",
  borderRadius: "50%",
  background: "#303030",
  color: "#fff",
  fontSize: "11px",
  fontWeight: "600",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
const tableStyle = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};
const th = {
  padding: "10px 14px",
  textAlign: "left",
  fontWeight: "600",
  fontSize: "11px",
  color: "#6d7175",
  borderBottom: "2px solid #e1e3e5",
  background: "#fafafa",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  whiteSpace: "nowrap",
};
const td = {
  padding: "12px 14px",
  verticalAlign: "middle",
  borderBottom: "1px solid #f1f2f3",
};

export const headers = (headersArgs) => boundary.headers(headersArgs);
