import { Form, redirect, useLoaderData, useActionData, useNavigation, useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const group = await db.rotationGroup.findFirst({
    where: { id: params.id, shop },
    include: { items: { orderBy: { position: "asc" } } },
  });

  if (!group) throw new Response("Not Found", { status: 404 });

  return {
    group: {
      ...group,
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
      items: group.items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
    },
  };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "updateGroup") {
    const name = formData.get("name")?.toString().trim();
    const description = formData.get("description")?.toString().trim();
    const isActive = formData.get("isActive") === "true";

    if (!name) return { errors: { name: "Group name is required" } };

    await db.rotationGroup.updateMany({
      where: { id: params.id, shop },
      data: { name, description: description || null, isActive },
    });

    return { success: "Group updated successfully" };
  }

  if (intent === "deleteGroup") {
    await db.rotationGroup.deleteMany({ where: { id: params.id, shop } });
    return redirect("/app/rotation-groups");
  }

  if (intent === "addItem") {
    const productId = formData.get("productId")?.toString().trim();
    const productTitle = formData.get("productTitle")?.toString().trim();
    const variantId = formData.get("variantId")?.toString().trim();
    const variantTitle = formData.get("variantTitle")?.toString().trim();
    const price = formData.get("price")?.toString().trim();
    const imageUrl = formData.get("imageUrl")?.toString().trim();

    if (!productId || !productTitle) {
      return { errors: { item: "Product ID and Product Title are required" } };
    }

    const maxPosition = await db.rotationItem.aggregate({
      where: { rotationGroupId: params.id },
      _max: { position: true },
    });
    const nextPosition = (maxPosition._max.position ?? -1) + 1;

    await db.rotationItem.create({
      data: {
        rotationGroupId: params.id,
        productId,
        productTitle,
        variantId: variantId || null,
        variantTitle: variantTitle || null,
        price: price || null,
        imageUrl: imageUrl || null,
        position: nextPosition,
      },
    });

    return { success: "Item added" };
  }

  if (intent === "deleteItem") {
    const itemId = formData.get("itemId");
    await db.rotationItem.delete({ where: { id: itemId } });

    // Re-sequence positions
    const remaining = await db.rotationItem.findMany({
      where: { rotationGroupId: params.id },
      orderBy: { position: "asc" },
    });
    await Promise.all(
      remaining.map((item, idx) =>
        db.rotationItem.update({ where: { id: item.id }, data: { position: idx } })
      )
    );

    return { success: "Item removed" };
  }

  if (intent === "moveItem") {
    const itemId = formData.get("itemId");
    const direction = formData.get("direction"); // "up" | "down"

    const items = await db.rotationItem.findMany({
      where: { rotationGroupId: params.id },
      orderBy: { position: "asc" },
    });

    const idx = items.findIndex((i) => i.id === itemId);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;

    if (swapIdx < 0 || swapIdx >= items.length) return null;

    await Promise.all([
      db.rotationItem.update({ where: { id: items[idx].id }, data: { position: items[swapIdx].position } }),
      db.rotationItem.update({ where: { id: items[swapIdx].id }, data: { position: items[idx].position } }),
    ]);

    return null;
  }

  return null;
};

export default function RotationGroupDetail() {
  const { group } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading={group.name} back-action="/app/rotation-groups">
      {actionData?.success && (
        <s-banner tone="success" title={actionData.success} />
      )}

      {/* Group Settings */}
      <s-section heading="Group Settings">
        <Form method="post">
          <input type="hidden" name="intent" value="updateGroup" />
          <s-stack direction="block" gap="400">
            <div>
              <label htmlFor="name" style={labelStyle}>
                Group Name <span style={{ color: "#d82c0d" }}>*</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                defaultValue={group.name}
                style={inputStyle}
              />
              {actionData?.errors?.name && (
                <p style={errorStyle}>{actionData.errors.name}</p>
              )}
            </div>

            <div>
              <label htmlFor="description" style={labelStyle}>
                Description
              </label>
              <textarea
                id="description"
                name="description"
                rows={3}
                defaultValue={group.description || ""}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>

            <div>
              <label style={labelStyle}>Status</label>
              <s-stack direction="inline" gap="300">
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input type="radio" name="isActive" value="true" defaultChecked={group.isActive} />
                  <span>Active</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input type="radio" name="isActive" value="false" defaultChecked={!group.isActive} />
                  <span>Inactive</span>
                </label>
              </s-stack>
            </div>

            <s-stack direction="inline" gap="300">
              <s-button variant="primary" submit disabled={isSubmitting}>
                Save Changes
              </s-button>
              <Form method="post" style={{ display: "inline" }}>
                <input type="hidden" name="intent" value="deleteGroup" />
                <s-button
                  variant="secondary"
                  tone="critical"
                  submit
                  onClick={(e) => {
                    if (!confirm("Delete this group? All items and linked subscription data will be removed.")) {
                      e.preventDefault();
                    }
                  }}
                >
                  Delete Group
                </s-button>
              </Form>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      {/* Rotation Items */}
      <s-section heading={`Rotation Items (${group.items.length})`}>
        {actionData?.errors?.item && (
          <s-banner tone="critical" title={actionData.errors.item} />
        )}

        {group.items.length === 0 ? (
          <s-paragraph>No items yet. Add products below to build the rotation sequence.</s-paragraph>
        ) : (
          <s-box borderWidth="025" borderRadius="200" overflow="hidden">
            <table style={tableStyle}>
              <thead>
                <tr style={theadRowStyle}>
                  <th style={thStyle}>#</th>
                  <th style={thStyle}>Product</th>
                  <th style={thStyle}>Variant</th>
                  <th style={thStyle}>Price</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {group.items.map((item, idx) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    idx={idx}
                    isFirst={idx === 0}
                    isLast={idx === group.items.length - 1}
                  />
                ))}
              </tbody>
            </table>
          </s-box>
        )}

        {/* Add Item Form */}
        <s-box padding="400" borderWidth="025" borderRadius="200" background="subdued">
          <s-heading>Add Rotation Item</s-heading>
          <Form method="post">
            <input type="hidden" name="intent" value="addItem" />
            <s-stack direction="block" gap="300">
              <s-stack direction="inline" gap="300">
                <div style={{ flex: 1 }}>
                  <label htmlFor="productId" style={labelStyle}>
                    Product ID (GID) <span style={{ color: "#d82c0d" }}>*</span>
                  </label>
                  <input
                    id="productId"
                    name="productId"
                    type="text"
                    required
                    placeholder="gid://shopify/Product/123456"
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="productTitle" style={labelStyle}>
                    Product Title <span style={{ color: "#d82c0d" }}>*</span>
                  </label>
                  <input
                    id="productTitle"
                    name="productTitle"
                    type="text"
                    required
                    placeholder="e.g. Coffee Blend A"
                    style={inputStyle}
                  />
                </div>
              </s-stack>

              <s-stack direction="inline" gap="300">
                <div style={{ flex: 1 }}>
                  <label htmlFor="variantId" style={labelStyle}>Variant ID (GID)</label>
                  <input
                    id="variantId"
                    name="variantId"
                    type="text"
                    placeholder="gid://shopify/ProductVariant/789"
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="variantTitle" style={labelStyle}>Variant Title</label>
                  <input
                    id="variantTitle"
                    name="variantTitle"
                    type="text"
                    placeholder="e.g. 250g"
                    style={inputStyle}
                  />
                </div>
              </s-stack>

              <s-stack direction="inline" gap="300">
                <div style={{ flex: 1 }}>
                  <label htmlFor="price" style={labelStyle}>Price</label>
                  <input
                    id="price"
                    name="price"
                    type="text"
                    placeholder="e.g. 19.99"
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label htmlFor="imageUrl" style={labelStyle}>Image URL</label>
                  <input
                    id="imageUrl"
                    name="imageUrl"
                    type="url"
                    placeholder="https://..."
                    style={inputStyle}
                  />
                </div>
              </s-stack>

              <s-button variant="primary" submit>Add Item</s-button>
            </s-stack>
          </Form>
        </s-box>
      </s-section>

      {/* Subscription Instances */}
      <s-section slot="aside" heading="Info">
        <s-stack direction="block" gap="200">
          <s-paragraph>
            <s-text fontWeight="semibold">ID: </s-text>
            <code style={{ fontSize: "12px" }}>{group.id}</code>
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="semibold">Created: </s-text>
            {new Date(group.createdAt).toLocaleString()}
          </s-paragraph>
          <s-paragraph>
            <s-text fontWeight="semibold">Updated: </s-text>
            {new Date(group.updatedAt).toLocaleString()}
          </s-paragraph>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ItemRow({ item, idx, isFirst, isLast }) {
  const fetcher = useFetcher();

  return (
    <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
      <td style={tdStyle}>
        <s-badge>{idx + 1}</s-badge>
      </td>
      <td style={tdStyle}>
        <s-stack direction="block" gap="050">
          <strong>{item.productTitle}</strong>
          <code style={{ fontSize: "11px", color: "#6d7175" }}>
            {item.productId.split("/").pop()}
          </code>
        </s-stack>
      </td>
      <td style={tdStyle}>
        {item.variantTitle ? (
          <s-stack direction="block" gap="050">
            <span>{item.variantTitle}</span>
            {item.variantId && (
              <code style={{ fontSize: "11px", color: "#6d7175" }}>
                {item.variantId.split("/").pop()}
              </code>
            )}
          </s-stack>
        ) : "—"}
      </td>
      <td style={tdStyle}>{item.price ? `$${item.price}` : "—"}</td>
      <td style={tdStyle}>
        <s-stack direction="inline" gap="200">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="moveItem" />
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="direction" value="up" />
            <s-button variant="secondary" size="slim" submit disabled={isFirst}>▲</s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="moveItem" />
            <input type="hidden" name="itemId" value={item.id} />
            <input type="hidden" name="direction" value="down" />
            <s-button variant="secondary" size="slim" submit disabled={isLast}>▼</s-button>
          </fetcher.Form>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="deleteItem" />
            <input type="hidden" name="itemId" value={item.id} />
            <s-button
              variant="secondary"
              tone="critical"
              size="slim"
              submit
              onClick={(e) => {
                if (!confirm(`Remove "${item.productTitle}" from rotation?`)) e.preventDefault();
              }}
            >
              Remove
            </s-button>
          </fetcher.Form>
        </s-stack>
      </td>
    </tr>
  );
}

const labelStyle = { display: "block", marginBottom: "6px", fontWeight: "500", fontSize: "14px" };
const inputStyle = { width: "100%", padding: "8px 12px", border: "1px solid #c9cccf", borderRadius: "6px", fontSize: "14px", boxSizing: "border-box" };
const errorStyle = { color: "#d82c0d", fontSize: "13px", marginTop: "4px", marginBottom: "0" };
const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: "14px" };
const theadRowStyle = { backgroundColor: "#f6f6f7" };
const thStyle = { padding: "10px 12px", textAlign: "left", fontWeight: "600", borderBottom: "1px solid #e1e3e5" };
const tdStyle = { padding: "10px 12px", verticalAlign: "middle" };

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
