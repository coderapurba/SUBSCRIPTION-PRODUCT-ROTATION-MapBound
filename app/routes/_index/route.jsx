import { redirect } from "react-router";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const params = url.searchParams.toString();
  throw redirect(params ? `/app?${params}` : "/app");
};

export default function App() {
  return null;
}
