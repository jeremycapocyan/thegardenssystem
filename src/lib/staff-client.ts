import { getBackend } from "./backend";
export async function staffFetch(path: string, options: RequestInit = {}) {
  const session = await getBackend()!.auth.getSession();
  return fetch(path, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${session.data.session?.access_token || ""}`,
    },
    cache: "no-store",
  });
}
