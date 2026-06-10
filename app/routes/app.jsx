import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate, registerWebhooks } from "../shopify.server";

// When the server throws a redirect for re-auth (OAuth), the browser would follow
// it inside the iframe and hit accounts.shopify.com which blocks iframe loading.
// This component detects that case and exits the iframe before the redirect.
function ExitIframeRedirect({ error }) {
  useEffect(() => {
    if (!(error instanceof Response)) return;
    const location = error.headers?.get("Location");
    if (!location) return;
    try {
      if (window !== window.top) {
        window.top.location.assign(location);
      } else {
        window.location.assign(location);
      }
    } catch {
      window.location.assign(location);
    }
  }, []);
  return null;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Register all webhooks for this shop on every app load.
  // Runs fast when already registered; creates missing subscriptions otherwise.
  registerWebhooks({ session }).catch((err) =>
    console.error("[app] webhook registration error:", err.message)
  );

  return { apiKey: process.env.SHOPIFY_API_KEY || "", shop: session.shop };
};

export default function App() {
  const { apiKey, shop } = useLoaderData();

  useEffect(() => {
    if (shop) {
      try { localStorage.setItem("shopify_shop", shop); } catch {}
    }
  }, [shop]);

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/rotation-groups">Rotation Groups</s-link>
        <s-link href="/app/rotation-logs">Rotation Logs</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  // Redirect responses (re-auth / OAuth) must exit the iframe before the browser follows them.
  if (error instanceof Response && error.status >= 300 && error.status < 400) {
    return <ExitIframeRedirect error={error} />;
  }
  return boundary.error(error);
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
