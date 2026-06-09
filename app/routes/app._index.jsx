import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [groupCount, itemCount, activeInstanceCount, logCount, recentLogs] =
    await Promise.all([
      db.rotationGroup.count({ where: { shop } }),
      db.rotationItem.count({ where: { rotationGroup: { shop } } }),
      db.subscriptionInstance.count({ where: { shop, status: "ACTIVE" } }),
      db.rotationLog.count({ where: { shop } }),
      db.rotationLog.findMany({
        where: { shop },
        orderBy: { rotatedAt: "desc" },
        take: 10,
        include: { subscriptionInstance: true },
      }),
    ]);

  return {
    groupCount,
    itemCount,
    activeInstanceCount,
    logCount,
    recentLogs: recentLogs.map((log) => ({
      ...log,
      rotatedAt: log.rotatedAt.toISOString(),
    })),
  };
};

export default function Dashboard() {
  const { groupCount, itemCount, activeInstanceCount, logCount, recentLogs } =
    useLoaderData();

  return (
    <s-page heading="Subscription Product Rotation">
      <s-section heading="Overview">
        <s-stack direction="inline" gap="400">
          <StatCard label="Rotation Groups" value={groupCount} href="/app/rotation-groups" />
          <StatCard label="Rotation Items" value={itemCount} />
          <StatCard label="Active Subscriptions" value={activeInstanceCount} />
          <StatCard label="Total Rotations" value={logCount} href="/app/rotation-logs" />
        </s-stack>
      </s-section>

      <s-section heading="Quick Actions">
        <s-stack direction="inline" gap="300">
          <s-button href="/app/rotation-groups/new" variant="primary">
            Create Rotation Group
          </s-button>
          <s-button href="/app/rotation-groups" variant="secondary">
            Manage Groups
          </s-button>
          <s-button href="/app/rotation-logs" variant="secondary">
            View Logs
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="Recent Rotation Activity">
        {recentLogs.length === 0 ? (
          <s-paragraph>No rotation activity yet. Rotations will appear here once subscriptions are processed.</s-paragraph>
        ) : (
          <s-box padding="0" borderWidth="025" borderRadius="200" overflow="hidden">
            <table style={tableStyle}>
              <thead>
                <tr style={theadRowStyle}>
                  <th style={thStyle}>Contract ID</th>
                  <th style={thStyle}>From Product</th>
                  <th style={thStyle}>To Product</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Triggered By</th>
                  <th style={thStyle}>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentLogs.map((log) => (
                  <tr key={log.id} style={trStyle}>
                    <td style={tdStyle}>
                      <code style={{ fontSize: "12px" }}>
                        {log.subscriptionInstance.subscriptionContractId.split("/").pop()}
                      </code>
                    </td>
                    <td style={tdStyle}>{log.fromProductTitle || "—"}</td>
                    <td style={tdStyle}>{log.toProductTitle}</td>
                    <td style={tdStyle}>
                      <StatusBadge status={log.status} />
                    </td>
                    <td style={tdStyle}>{log.triggeredBy}</td>
                    <td style={tdStyle}>
                      {new Date(log.rotatedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
        {recentLogs.length > 0 && (
          <s-stack direction="inline" gap="200" align="end">
            <s-link href="/app/rotation-logs">View all logs →</s-link>
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How It Works">
        <s-unordered-list>
          <s-list-item>Create a Rotation Group with ordered products</s-list-item>
          <s-list-item>Link subscription contracts to a group</s-list-item>
          <s-list-item>Products rotate automatically on each billing cycle</s-list-item>
          <s-list-item>Track all rotations in the Logs view</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

function StatCard({ label, value, href }) {
  return (
    <s-box
      padding="400"
      borderWidth="025"
      borderRadius="200"
      background="subdued"
    >
      <s-stack direction="block" gap="100">
        <div style={{ fontSize: "28px", fontWeight: "700", lineHeight: "1" }}>
          {value}
        </div>
        <s-text tone="subdued">{label}</s-text>
        {href && (
          <s-link href={href}>
            <s-text tone="interactive">View →</s-text>
          </s-link>
        )}
      </s-stack>
    </s-box>
  );
}

function StatusBadge({ status }) {
  const toneMap = { SUCCESS: "success", FAILED: "critical", SKIPPED: "warning" };
  return <s-badge tone={toneMap[status] || "info"}>{status}</s-badge>;
}

const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const theadRowStyle = { backgroundColor: "#f6f6f7" };
const thStyle = { padding: "10px 12px", textAlign: "left", fontWeight: "600", borderBottom: "1px solid #e1e3e5" };
const tdStyle = { padding: "10px 12px", borderBottom: "1px solid #e1e3e5" };
const trStyle = {};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
