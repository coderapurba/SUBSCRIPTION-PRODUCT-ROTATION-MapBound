import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState, useEffect } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  if (shopParam) {
    // Auto-trigger OAuth for the given shop (comes from ?shop= param or localStorage redirect)
    const errors = loginErrorMessage(await login(request));
    return { errors, shop: shopParam };
  }
  return { errors: {}, shop: "" };
};

export const action = async ({ request }) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const { errors, shop: prefilledShop } = actionData || loaderData;
  const [shop, setShop] = useState(prefilledShop || "");

  useEffect(() => {
    // Only auto-redirect if the page loaded without a shop (session expired mid-session)
    if (shop) return;
    try {
      const saved = localStorage.getItem("shopify_shop");
      if (saved) {
        // Navigate to this same page with ?shop= so the loader triggers OAuth automatically
        window.location.href = `/auth/login?shop=${encodeURIComponent(saved)}`;
      }
    } catch {}
  }, []);

  return (
    <AppProvider embedded={false}>
      <s-page>
        <Form method="post">
          <s-section heading="Log in">
            <s-text-field
              name="shop"
              label="Shop domain"
              details="example.myshopify.com"
              value={shop}
              onChange={(e) => setShop(e.currentTarget.value)}
              autocomplete="on"
              error={errors.shop}
            ></s-text-field>
            <s-button type="submit">Log in</s-button>
          </s-section>
        </Form>
      </s-page>
    </AppProvider>
  );
}
