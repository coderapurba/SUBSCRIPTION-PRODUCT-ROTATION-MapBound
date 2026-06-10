import { useLoaderData, useSearchParams, Form, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 10;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url  = new URL(request.url);

  const status = url.searchParams.get("status") ?? "";
  const page   = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));

  const where = { shop, ...(status ? { status } : {}) };

  const [total, logs] = await Promise.all([
    db.rotationLog.count({ where }),
    db.rotationLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, shop: true, orderId: true, customerId: true,
        targetProductTitle: true, rotationProductTitle: true,
        status: true, message: true, createdAt: true,
      },
    }),
  ]);

  return {
    logs: logs.map((l) => ({ ...l, createdAt: l.createdAt.toISOString() })),
    total,
    page,
    totalPages: Math.ceil(total / PAGE_SIZE),
    filters: { status },
  };
};

export default function RotationLogsPage() {
  const { logs, total, page, totalPages, filters } = useLoaderData();
  const [searchParams] = useSearchParams();
  const hasFilters = Boolean(filters.status);

  return (
    <s-page heading="Rotation Logs" back-action="/app">

      <s-section>
        {/* ── Filter bar ────────────────────────────────────────────────── */}
        <Form method="get" style={filterBar}>
          <div style={filterGroup}>
            <label style={filterLabel}>Status</label>
            <select name="status" defaultValue={filters.status} style={selectStyle}>
              <option value="">All statuses</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILED">Failed</option>
              <option value="SKIPPED">Skipped</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "8px" }}>
            <button type="submit" style={filterBtn}>Apply Filter</button>
            {hasFilters && (
              <Link to="/app/rotation-logs" style={clearBtn}>Clear</Link>
            )}
          </div>
        </Form>

        {/* ── Summary ───────────────────────────────────────────────────── */}
        <div style={summaryRow}>
          <span style={{ fontSize: "14px", fontWeight: "600", color: "#303030" }}>
            {total} rotation event{total !== 1 ? "s" : ""}
            {hasFilters && <span style={{ fontSize: "12px", color: "#6d7175", fontWeight: "400" }}> (filtered)</span>}
          </span>
          {total > 0 && (
            <span style={{ fontSize: "12px", color: "#6d7175" }}>
              Page {page} of {totalPages}
            </span>
          )}
        </div>

        {/* ── Table ─────────────────────────────────────────────────────── */}
        {logs.length === 0 ? (
          <div style={emptyState}>
            <div style={{ fontSize: "40px", marginBottom: "12px" }}>📋</div>
            <div style={{ fontSize: "15px", fontWeight: "600", color: "#303030", marginBottom: "6px" }}>
              {hasFilters ? "No logs match your filters" : "No rotation logs yet"}
            </div>
            <div style={{ fontSize: "13px", color: "#6d7175" }}>
              {hasFilters
                ? "Try adjusting your filters or clear them to see all logs"
                : "Logs appear here after renewal orders are processed"}
            </div>
            {hasFilters && (
              <Link to="/app/rotation-logs" style={{ ...filterBtn, marginTop: "16px", display: "inline-block", textDecoration: "none" }}>
                Clear Filters
              </Link>
            )}
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto", borderRadius: "8px", border: "1px solid #e1e3e5" }}>
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={th}>Order</th>
                    <th style={th}>Customer</th>
                    <th style={th}>From</th>
                    <th style={th}>→ Rotated To</th>
                    <th style={th}>Status</th>
                    <th style={th}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log) => (
                    <tr key={log.id}>
                      <td style={td}>
                        <code style={codeChip}>#{log.orderId.split("/").pop()}</code>
                      </td>
                      <td style={td}>
                        <code style={{ fontSize: "11px", color: "#6d7175" }}>{log.customerId}</code>
                      </td>
                      <td style={td}>
                        <span style={{ fontSize: "13px", color: "#6d7175" }}>{log.targetProductTitle}</span>
                      </td>
                      <td style={td}>
                        <span style={{ fontSize: "13px", fontWeight: "500", color: "#303030" }}>{log.rotationProductTitle || "—"}</span>
                      </td>
                      <td style={td}>
                        <StatusBadge status={log.status} />
                        {log.message && (
                          <div style={{ fontSize: "11px", color: "#d82c0d", marginTop: "4px", maxWidth: "200px", lineHeight: "1.3" }}>
                            {log.message}
                          </div>
                        )}
                      </td>
                      <td style={td}>
                        <div style={{ fontSize: "13px", color: "#303030" }}>{new Date(log.createdAt).toLocaleDateString()}</div>
                        <div style={{ fontSize: "11px", color: "#8c9196" }}>{new Date(log.createdAt).toLocaleTimeString()}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div style={paginationRow}>
                {page > 1
                  ? <Link to={`/app/rotation-logs?${buildQuery(searchParams, page - 1)}`} style={pageBtn}>← Previous</Link>
                  : <span style={pageBtnDisabled}>← Previous</span>
                }
                <span style={{ fontSize: "13px", color: "#6d7175", padding: "0 4px" }}>
                  Page {page} of {totalPages}
                </span>
                {page < totalPages
                  ? <Link to={`/app/rotation-logs?${buildQuery(searchParams, page + 1)}`} style={pageBtn}>Next →</Link>
                  : <span style={pageBtnDisabled}>Next →</span>
                }
              </div>
            )}
          </>
        )}
      </s-section>

    </s-page>
  );
}

function StatusBadge({ status }) {
  const map = {
    SUCCESS: { bg: "#e3f5e9", color: "#008060" },
    FAILED:  { bg: "#fce8e8", color: "#d82c0d" },
    SKIPPED: { bg: "#fff5e5", color: "#b98900" },
  };
  const s = map[status] ?? { bg: "#f1f2f3", color: "#6d7175" };
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: "11px", fontWeight: "600", padding: "3px 9px", borderRadius: "12px" }}>
      {status}
    </span>
  );
}

function buildQuery(sp, newPage) {
  const p = new URLSearchParams(sp);
  p.set("page", String(newPage));
  return p.toString();
}

const filterBar   = { display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "flex-end", padding: "16px", background: "#fafafa", borderRadius: "8px", border: "1px solid #e1e3e5", marginBottom: "16px" };
const filterGroup = { display: "flex", flexDirection: "column", gap: "5px", minWidth: "140px" };
const filterLabel = { fontSize: "12px", fontWeight: "600", color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.4px" };
const selectStyle = { padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: "7px", fontSize: "13px", fontFamily: "inherit", color: "#303030", background: "#fff" };
const filterBtn   = { background: "#303030", color: "#fff", border: "none", borderRadius: "7px", padding: "8px 16px", fontSize: "13px", fontWeight: "500", cursor: "pointer", fontFamily: "inherit" };
const clearBtn    = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "7px", padding: "7px 14px", fontSize: "13px", fontWeight: "500", textDecoration: "none", display: "inline-block" };

const summaryRow  = { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" };
const emptyState  = { textAlign: "center", padding: "56px 20px", background: "#fafafa", borderRadius: "8px", border: "1px dashed #c9cccf" };

const tableStyle  = { width: "100%", borderCollapse: "collapse", fontSize: "13px" };
const th = { padding: "10px 14px", textAlign: "left", fontWeight: "600", fontSize: "11px", color: "#6d7175", borderBottom: "2px solid #e1e3e5", background: "#fafafa", textTransform: "uppercase", letterSpacing: "0.5px", whiteSpace: "nowrap" };
const td = { padding: "12px 14px", verticalAlign: "middle", borderBottom: "1px solid #f1f2f3" };

const codeChip = { fontSize: "12px", background: "#f6f6f7", padding: "2px 7px", borderRadius: "4px", fontFamily: "monospace", color: "#303030" };

const paginationRow   = { display: "flex", justifyContent: "center", alignItems: "center", gap: "12px", paddingTop: "16px" };
const pageBtn         = { background: "#fff", color: "#303030", border: "1px solid #c9cccf", borderRadius: "6px", padding: "7px 14px", fontSize: "13px", fontWeight: "500", textDecoration: "none", display: "inline-block" };
const pageBtnDisabled = { background: "#f6f6f7", color: "#c9cccf", border: "1px solid #e1e3e5", borderRadius: "6px", padding: "7px 14px", fontSize: "13px", fontWeight: "500", display: "inline-block" };

export const headers = (headersArgs) => boundary.headers(headersArgs);
