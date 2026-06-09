import { Form, redirect, useActionData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();

  const name = formData.get("name")?.toString().trim();
  const description = formData.get("description")?.toString().trim();
  const isActive = formData.get("isActive") === "true";

  if (!name) {
    return { errors: { name: "Group name is required" } };
  }

  const group = await db.rotationGroup.create({
    data: { shop, name, description: description || null, isActive },
  });

  return redirect(`/app/rotation-groups/${group.id}`);
};

export default function NewRotationGroup() {
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page heading="Create Rotation Group" back-action="/app/rotation-groups">
      <s-section heading="Group Details">
        <Form method="post">
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
                placeholder="e.g. Monthly Coffee Subscription"
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
                placeholder="Optional: describe the purpose of this rotation group"
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </div>

            <div>
              <label style={labelStyle}>Status</label>
              <s-stack direction="inline" gap="300">
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input type="radio" name="isActive" value="true" defaultChecked />
                  <span>Active</span>
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
                  <input type="radio" name="isActive" value="false" />
                  <span>Inactive</span>
                </label>
              </s-stack>
            </div>

            <s-stack direction="inline" gap="300">
              <s-button variant="primary" submit disabled={isSubmitting}>
                {isSubmitting ? "Creating..." : "Create Group"}
              </s-button>
              <s-button href="/app/rotation-groups" variant="secondary">
                Cancel
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

const labelStyle = {
  display: "block",
  marginBottom: "6px",
  fontWeight: "500",
  fontSize: "14px",
};

const inputStyle = {
  width: "100%",
  padding: "8px 12px",
  border: "1px solid #c9cccf",
  borderRadius: "6px",
  fontSize: "14px",
  boxSizing: "border-box",
  outline: "none",
};

const errorStyle = {
  color: "#d82c0d",
  fontSize: "13px",
  marginTop: "4px",
  marginBottom: "0",
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
