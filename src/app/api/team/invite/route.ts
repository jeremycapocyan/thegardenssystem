import "server-only";
import { createClient } from "@supabase/supabase-js";

export async function POST(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const service =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  const response = (message: string, status = 400) =>
    Response.json(
      { message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (!url || !key || !service)
    return response(
      "Employee invitations are not configured on the server.",
      503,
    );
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return response("Sign in first.", 401);
  const caller = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: auth, error: authError } = await caller.auth.getUser(token);
  if (authError || !auth.user) return response("Sign in again.", 401);
  const { data: profile } = await caller
    .from("garden_profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();
  if (profile?.role !== "admin")
    return response("Only Jeremy can invite employees.", 403);
  try {
    const { employee_id } = await request.json();
    if (
      typeof employee_id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(employee_id)
    )
      return response("Choose a saved employee.");
    const { data: employee, error } = await caller
      .from("garden_employees")
      .select("id,name,email,active,profile_id")
      .eq("id", employee_id)
      .single();
    if (error || !employee?.active)
      return response("Select an active employee.");
    const api = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const origin = process.env.APP_URL || "https://thegardenssystem.vercel.app";
    const redirectTo = new URL("/account/", origin).toString();
    let userId = employee.profile_id as string | null;
    if (!userId) {
      for (let page = 1; ; page++) {
        const users = await api.auth.admin.listUsers({ page, perPage: 1000 });
        if (users.error) throw Error("Unable to check employee accounts.");
        const existing = users.data.users.find(
          (u) => u.email?.toLowerCase() === employee.email.toLowerCase(),
        );
        if (existing) {
          userId = existing.id;
          break;
        }
        if (users.data.users.length < 1000) break;
      }
    }
    if (userId) {
      const role = await api
        .from("garden_profiles")
        .select("role")
        .eq("id", userId)
        .maybeSingle();
      if (role.data && role.data.role !== "employee")
        return response(
          "This address belongs to an owner or administrator. Use an employee email.",
        );
      const bound = await api.rpc("garden_bind_employee", {
        p_employee: employee.id,
        p_user: userId,
      });
      if (bound.error)
        throw Error(
          "Unable to link this account; it may already belong to another employee.",
        );
      const sent = await caller.auth.resetPasswordForEmail(employee.email, {
        redirectTo,
      });
      if (sent.error)
        throw Error(
          "Account is linked, but the setup email could not be sent. Retry Invite / resend.",
        );
    } else {
      const invite = await api.auth.admin.inviteUserByEmail(employee.email, {
        redirectTo,
        data: { display_name: employee.name },
      });
      if (invite.error)
        throw Error(
          "Unable to send the invitation. Verify the address and email delivery settings, then retry.",
        );
      const bound = await api.rpc("garden_bind_employee", {
        p_employee: employee.id,
        p_user: invite.data.user.id,
      });
      if (bound.error)
        throw Error(
          "Invitation sent, but membership could not be linked. Retry Invite / resend.",
        );
    }
    return response(
      "Account setup email sent. The employee chooses their own password.",
      200,
    );
  } catch (err) {
    return response(
      err instanceof Error ? err.message : "Unable to invite employee.",
    );
  }
}
