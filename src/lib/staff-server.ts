import "server-only";
import { createClient } from "@supabase/supabase-js";
import { canManage } from "./access";
import type { Profile } from "./types";
export const staffReply = (message: string, status = 400) =>
  Response.json(
    { message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
export async function staffAuth(request: Request, scope: "team" | "employee") {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    return staffReply("The shared workspace is not configured.", 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return staffReply("Sign in first.", 401);
  const caller = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const user = await caller.auth.getUser(token);
  if (user.error || !user.data.user) return staffReply("Sign in again.", 401);
  const profile = await caller
    .from("garden_profiles")
    .select("*")
    .eq("id", user.data.user.id)
    .single();
  if (
    profile.error ||
    !profile.data.active ||
    (scope === "employee"
      ? profile.data.role !== "employee"
      : !canManage(profile.data as Profile, "team"))
  )
    return staffReply(
      scope === "employee"
        ? "An active employee login is required."
        : "Employee and payroll management permission required.",
      403,
    );
  return { caller, profile: profile.data as Profile };
}
export function staffService() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw Error("Attendance is not configured on the server.");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
