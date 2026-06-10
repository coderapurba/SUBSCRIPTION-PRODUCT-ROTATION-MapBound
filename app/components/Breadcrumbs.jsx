import { Link, useNavigate } from "react-router";

/**
 * Breadcrumbs — renders a navigation trail at the top of every page.
 *
 * Usage:
 *   <Breadcrumbs crumbs={[
 *     { label: "Dashboard", href: "/app" },
 *     { label: "Rotation Groups", href: "/app/rotation-groups" },
 *     { label: "My Product" },          // no href = current page
 *   ]} />
 *
 * The last crumb with no href is treated as the current page (plain text).
 */
export function Breadcrumbs({ crumbs = [] }) {
  const navigate = useNavigate();

  // Derive back target: the second-to-last crumb that has an href
  const backCrumb = [...crumbs].reverse().find((c, i) => i > 0 && c.href);

  return (
    <div style={wrapStyle}>
      {/* Back button — goes one level up */}
      {backCrumb && (
        <button
          type="button"
          onClick={() => navigate(backCrumb.href)}
          style={backBtn}
          title={`Back to ${backCrumb.label}`}
        >
          <span style={backArrow}>‹</span>
          <span style={backLabel}>{backCrumb.label}</span>
        </button>
      )}

      {/* Breadcrumb trail */}
      <nav aria-label="Breadcrumb" style={trailStyle}>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <span key={i} style={segmentWrap}>
              {i > 0 && <span style={sepStyle} aria-hidden>›</span>}
              {!isLast && crumb.href ? (
                <Link to={crumb.href} style={linkStyle}>
                  {i === 0 && <span style={homeIcon} aria-hidden>⊞</span>}
                  {crumb.label}
                </Link>
              ) : (
                <span style={isLast ? currentStyle : plainStyle}>
                  {i === 0 && <span style={homeIcon} aria-hidden>⊞</span>}
                  {crumb.label}
                </span>
              )}
            </span>
          );
        })}
      </nav>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const wrapStyle = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
  padding: "10px 20px 10px",
  marginBottom: "0",
  background: "#f6f6f7",
  borderBottom: "1px solid #e1e3e5",
};

const backBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: "3px",
  background: "#f1f2f3",
  border: "1px solid #d9dadb",
  borderRadius: "6px",
  padding: "5px 11px 5px 8px",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "12px",
  fontWeight: "500",
  color: "#303030",
  flexShrink: 0,
  transition: "background 0.12s",
  lineHeight: "1",
};

const backArrow = {
  fontSize: "18px",
  lineHeight: "1",
  marginTop: "-1px",
  color: "#6d7175",
};

const backLabel = {
  fontSize: "12px",
  fontWeight: "500",
  color: "#303030",
};

const trailStyle = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0",
  minWidth: 0,
};

const segmentWrap = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
};

const sepStyle = {
  color: "#b0b4b8",
  fontSize: "14px",
  margin: "0 4px",
  userSelect: "none",
};

const homeIcon = {
  fontSize: "12px",
  marginRight: "4px",
  opacity: 0.6,
};

const linkStyle = {
  fontSize: "13px",
  color: "#2c6ecb",
  textDecoration: "none",
  fontWeight: "500",
  display: "inline-flex",
  alignItems: "center",
};

const plainStyle = {
  fontSize: "13px",
  color: "#6d7175",
  fontWeight: "400",
};

const currentStyle = {
  fontSize: "13px",
  color: "#303030",
  fontWeight: "600",
  maxWidth: "240px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  display: "inline-block",
};
