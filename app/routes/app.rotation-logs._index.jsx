import { useLoaderData, Form, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 25;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const status = url.searchParams.get("status") || "";
  const triggeredBy = url.searchParams.get("triggeredBy") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));

  const where = {
    shop,
    ...(status ? { status } : {}),
    ...(triggeredBy ? { triggeredBy } : {}),
  };

  const [total, logs] = await Promise.all([
    db.rotationLog.count({ where }),
    db.rotationLog.findMany({
      where,
      orderBy: { rotatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { subscriptionInstance: true },
    }),
  ]);

  return {
    logs: logs.map((log) => ({
      ...log,
      rotatedAt: log.rotatedAt.toISOString(),
      subscriptionInstance: {
        ...log.subscriptionInstance,
        createdAt: log.subscriptionInstance.createdAt.toISOString(),
        updatedAt: log.subscriptionInstance.updatedAt.toISOString(),
      },
    })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    filters: { status, triggeredBy },
  };
};

export default function RotationLogsIndex() {
  const { logs, total, page, totalPages, filters } = useLoaderData();
  const [searchParams] = useSearchParams();

  return (
    <s-page heading="Rotation Logs" back-action="/app">
      <s-section heading={`${total} log${total !== 1 ? "s" : ""}`}>
        {/* Filters */}
        <Form method="get">
          <s-stack direction="inline" gap="300" align="end">
            <div>
              <label htmlFor="status" style={labelStyle}>Status</label>
              <select id="status" name="status" defaultValue={filters.status} style={selectStyle}>
                <option value="">All statuses</option>
                <option value="SUCCESS">Success</option>
                <option value="FAILED">Failed</option>
                <option value="SKIPPED">Skipped</option>
              </select>
            </div>
            <div>
              <label htmlFor="triggeredBy" style={labelStyle}>Triggered By</label>
              <select id="triggeredBy" name="triggeredBy" defaultValue={filters.triggeredBy} style={selectStyle}>
                <option value="">All triggers</option>
                <option value="SCHEDULED">Scheduled</option>
                <option value="MANUAL">Manual</option>
                <option value="WEBHOOK">Webhook</option>
              </select>
            </div>
            <s-button variant="secondary" submit>Filter</s-button>
            <s-button href="/app/rotation-logs" variant="secondary">Clear</s-button>
          </s-stack>
        </Form>

        {logs.length === 0 ? (
          <s-stack direction="block" gap="200" align="center">
            <s-paragraph>No rotation logs found.</s-paragraph>
            {(filters.status || filters.triggeredBy) && (
              <s-link href="/app/rotation-logs">Clear filters</s-link>
            )}
          </s-stack>
        ) : (
          <>
            <s-box borderWidth="025" borderRadius="200" overflow="hidden">
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
                  {logs.map((log) => (
                    <tr key={log.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                      <td style={tdStyle}>
                        <s-stack direction="block" gap="050">
                          <code style={{ fontSize: "12px" }}>
                            {log.subscriptionInstance.subscriptionContractId.split("/").pop()}
                          </code>
                          <s-text tone="subdued" variant="bodySm">
                            {log.shop}
                          </s-text>
                        </s-stack>
                      </td>
                      <td style={tdStyle}>
                        {log.fromProductTitle ? (
                          <s-stack direction="block" gap="025">
                            <span>{log.fromProductTitle}</span>
                            {log.fromProductId && (
                              <code style={{ fontSize: "11px", color: "#6d7175" }}>
                                {log.fromProductId.split("/").pop()}
                              </code>
                            )}
                          </s-stack>
                        ) : (
                          <s-text tone="subdued">—</s-text>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <s-stack direction="block" gap="025">
                          <span>{log.toProductTitle}</span>
                          <code style={{ fontSize: "11px", color: "#6d7175" }}>
                            {log.toProductId.split("/").pop()}
                          </code>
                        </s-stack>
                      </td>
                      <td style={tdStyle}>
                        <s-badge tone={statusTone(log.status)}>{log.status}</s-badge>
                        {log.errorMessage && (
                          <p style={{ color: "#d82c0d", fontSize: "12px", margin: "4px 0 0" }}>
                            {log.errorMessage}
                          </p>
                        )}
                      </td>
                      <td style={tdStyle}>{log.triggeredBy}</td>
                      <td style={tdStyle} title={new Date(log.rotatedAt).toLocaleString()}>
                        {new Date(log.rotatedAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </s-box>

            {/* Pagination */}
            {totalPages > 1 && (
              <s-stack direction="inline" gap="200" align="center">
                {page > 1 && (
                  <s-button
                    href={`/app/rotation-logs?${buildQuery(searchParams, page - 1)}`}
                    variant="secondary"
                    size="slim"
                  >
                    ← Previous
                  </s-button>
                )}
                <s-text tone="subdued">
                  Page {page} of {totalPages} ({total} total)
                </s-text>
                {page < totalPages && (
                  <s-button
                    href={`/app/rotation-logs?${buildQuery(searchParams, page + 1)}`}
                    variant="secondary"
                    size="slim"
                  >
                    Next →
                  </s-button>
                )}
              </s-stack>
            )}
          </>
        )}
      </s-section>
    </s-page>
  );
}

function statusTone(status) {
  return { SUCCESS: "success", FAILED: "critical", SKIPPED: "warning" }[status] || "info";
}

function buildQuery(searchParams, newPage) {
  const params = new URLSearchParams(searchParams);
  params.set("page", String(newPage));
  return params.toString();
}

const labelStyle = { display: "block", marginBottom: "4px", fontWeight: "500", fontSize: "13px" };
const selectStyle = { padding: "7px 10px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "14px" };
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const theadRowStyle = { backgroundColor: "#f6f6f7" };
const thStyle = { padding: "10px 12px", textAlign: "left", fontWeight: "600", borderBottom: "1px solid #e1e3e5", whiteSpace: "nowrap" };
const tdStyle = { padding: "10px 12px", verticalAlign: "middle" };

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
