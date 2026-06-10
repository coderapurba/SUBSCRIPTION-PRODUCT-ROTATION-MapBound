import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState, useEffect } from "react";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shopParam = url.searchParams.get("shop");
  if (shopParam) {
    try {
      // login() throws a redirect() when OAuth is needed — catch it so we can
      // hand the URL back to the client and exit the iframe there (not server-side).
      const errors = loginErrorMessage(await login(request));
      return { errors, shop: shopParam, oauthRedirectUrl: null };
    } catch (thrown) {
      if (
        thrown instanceof Response &&
        thrown.status >= 300 &&
        thrown.status < 400
      ) {
        // Return the OAuth URL as data so the client can do window.top.location.assign
        // instead of letting the browser follow the redirect inside the iframe.
        const oauthRedirectUrl = thrown.headers.get("Location");
        return { errors: {}, shop: shopParam, oauthRedirectUrl };
      }
      throw thrown;
    }
  }
  return { errors: {}, shop: "", oauthRedirectUrl: null };
};

export const action = async ({ request }) => {
  try {
    const errors = loginErrorMessage(await login(request));
    return { errors, oauthRedirectUrl: null };
  } catch (thrown) {
    if (
      thrown instanceof Response &&
      thrown.status >= 300 &&
      thrown.status < 400
    ) {
      const oauthRedirectUrl = thrown.headers.get("Location");
      return { errors: {}, oauthRedirectUrl };
    }
    throw thrown;
  }
};

export default function Auth() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const { errors, shop: prefilledShop, oauthRedirectUrl } =
    actionData || loaderData;
  const [shop, setShop] = useState(prefilledShop || "");

  useEffect(() => {
    // OAuth redirect: exit the iframe so accounts.shopify.com can load properly.
    const url = (actionData || loaderData).oauthRedirectUrl;
    if (url) {
      try {
        if (window !== window.top) {
          window.top.location.assign(url);
        } else {
          window.location.assign(url);
        }
      } catch {
        window.location.assign(url);
      }
    }
  }, [oauthRedirectUrl]);

  useEffect(() => {
    // No shop yet — check localStorage (happens when session expires mid-session).
    if (shop || oauthRedirectUrl) return;
    try {
      const saved = localStorage.getItem("shopify_shop");
      if (saved) {
        window.location.href = `/auth/login?shop=${encodeURIComponent(saved)}`;
      }
    } catch {}
  }, []);

  // If we're about to redirect, render nothing to avoid a flash.
  if (oauthRedirectUrl) return null;

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
