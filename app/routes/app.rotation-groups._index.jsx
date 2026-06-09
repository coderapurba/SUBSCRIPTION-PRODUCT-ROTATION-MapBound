import { useLoaderData, Form } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const groups = await db.rotationGroup.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { items: true, instances: true } },
    },
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
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const id = formData.get("id");
    await db.rotationGroup.deleteMany({ where: { id, shop } });
  }

  return null;
};

export default function RotationGroupsIndex() {
  const { groups } = useLoaderData();

  return (
    <s-page heading="Rotation Groups" back-action="/app">
      <s-button slot="primary-action" href="/app/rotation-groups/new" variant="primary">
        Create Group
      </s-button>

      <s-section heading={`${groups.length} group${groups.length !== 1 ? "s" : ""}`}>
        {groups.length === 0 ? (
          <s-stack direction="block" gap="300" align="center">
            <s-paragraph>
              No rotation groups yet. Create one to start managing product rotations.
            </s-paragraph>
            <s-button href="/app/rotation-groups/new" variant="primary">
              Create your first group
            </s-button>
          </s-stack>
        ) : (
          <s-box borderWidth="025" borderRadius="200" overflow="hidden">
            <table style={tableStyle}>
              <thead>
                <tr style={theadRowStyle}>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Items</th>
                  <th style={thStyle}>Linked Subscriptions</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Created</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td style={tdStyle}>
                      <s-stack direction="block" gap="050">
                        <s-link href={`/app/rotation-groups/${group.id}`}>
                          <strong>{group.name}</strong>
                        </s-link>
                        {group.description && (
                          <s-text tone="subdued" variant="bodySm">
                            {group.description}
                          </s-text>
                        )}
                      </s-stack>
                    </td>
                    <td style={tdStyle}>{group._count.items}</td>
                    <td style={tdStyle}>{group._count.instances}</td>
                    <td style={tdStyle}>
                      <s-badge tone={group.isActive ? "success" : "critical"}>
                        {group.isActive ? "Active" : "Inactive"}
                      </s-badge>
                    </td>
                    <td style={tdStyle}>
                      {new Date(group.createdAt).toLocaleDateString()}
                    </td>
                    <td style={tdStyle}>
                      <s-stack direction="inline" gap="200">
                        <s-button href={`/app/rotation-groups/${group.id}`} variant="secondary" size="slim">
                          Edit
                        </s-button>
                        <Form method="post">
                          <input type="hidden" name="intent" value="delete" />
                          <input type="hidden" name="id" value={group.id} />
                          <s-button
                            variant="secondary"
                            tone="critical"
                            size="slim"
                            onClick={(e) => {
                              if (!confirm(`Delete "${group.name}"? This will also remove all items and linked subscriptions.`)) {
                                e.preventDefault();
                              }
                            }}
                            submit
                          >
                            Delete
                          </s-button>
                        </Form>
                      </s-stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-box>
        )}
      </s-section>
    </s-page>
  );
}

const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const theadRowStyle = { backgroundColor: "#f6f6f7" };
const thStyle = { padding: "10px 12px", textAlign: "left", fontWeight: "600", borderBottom: "1px solid #e1e3e5", whiteSpace: "nowrap" };
const tdStyle = { padding: "10px 12px", borderBottom: "1px solid #e1e3e5", verticalAlign: "middle" };

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
