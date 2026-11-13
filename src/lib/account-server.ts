import "server-only";
import { createClient } from "@supabase/supabase-js";
import { accountInput, canManage } from "./access";
import type { Profile } from "./types";

const reply = (message: string, status = 400) =>
  Response.json(
    { message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
async function context(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secret =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key || !secret)
    return reply("Account invitations are not configured on the server.", 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return reply("Sign in first.", 401);
  const caller = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const auth = await caller.auth.getUser(token);
  if (auth.error || !auth.data.user) return reply("Sign in again.", 401);
  const profile = await caller
    .from("garden_profiles")
    .select("*")
    .eq("id", auth.data.user.id)
    .single();
  if (profile.error || !canManage(profile.data as Profile, "accounts"))
    return reply("Account management permission required.", 403);
  const api = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { api, caller, actor: profile.data as Profile };
}
export async function listAccounts(request: Request) {
  const ctx = await context(request);
  if (ctx instanceof Response) return ctx;
  try {
    const { api } = ctx;
    const profiles = await api
      .from("garden_profiles")
      .select("*")
      .order("display_name");
    const employees = await api
      .from("garden_employees")
      .select("id,name,email,profile_id,active")
      .order("name");
    if (profiles.error || employees.error)
      throw Error("Unable to load accounts. Try Refresh.");
    const emails = new Map<string, string>();
    for (let page = 1; ; page++) {
      const users = await api.auth.admin.listUsers({ page, perPage: 1000 });
      if (users.error) throw Error("Unable to load account email addresses.");
      for (const user of users.data.users)
        emails.set(user.id, user.email || "");
      if (users.data.users.length < 1000) break;
    }
    return Response.json(
      {
        accounts: profiles.data.map((p) => ({
          ...p,
          email: emails.get(p.id) || "",
        })),
        employees: employees.data,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return reply(e instanceof Error ? e.message : "Unable to load accounts.");
  }
}
export async function changeAccount(request: Request) {
  const ctx = await context(request);
  if (ctx instanceof Response) return ctx;
  try {
    const { api, caller, actor } = ctx,
      body = await request.json();
    const action = body.action || (body.employee_id ? "invite_employee" : "");
    const redirectTo = new URL(
      "/account/",
      process.env.APP_URL || "https://thegardenssystem.vercel.app",
    ).toString();
    async function save(
      userId: string,
      values: {
        display_name: string;
        role: string;
        finance_access: boolean;
        team_access: boolean;
        manage_accounts: boolean;
        active: boolean;
      },
    ) {
      const result = await api.rpc("garden_manage_account", {
        p_actor: actor.id,
        p_user: userId,
        p_name: values.display_name,
        p_role: values.role,
        p_finance: values.finance_access,
        p_team: values.team_access,
        p_accounts: values.manage_accounts,
        p_active: values.active,
      });
      if (result.error) throw Error(result.error.message);
    }
    async function findUser(email: string) {
      for (let page = 1; ; page++) {
        const users = await api.auth.admin.listUsers({ page, perPage: 1000 });
        if (users.error) throw Error("Unable to check existing accounts.");
        const user = users.data.users.find(
          (u) => u.email?.toLowerCase() === email.toLowerCase(),
        );
        if (user) return user;
        if (users.data.users.length < 1000) return null;
      }
    }
    async function setupEmail(email: string) {
      const result = await api.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      if (result.error)
        throw Error(
          "Account saved, but the setup email could not be sent. Use Resend setup email to retry.",
        );
    }
    function withinScope(values: {
      finance_access: boolean;
      team_access: boolean;
      manage_accounts: boolean;
    }) {
      if (
        !actor.is_owner &&
        ((values.finance_access && !canManage(actor, "finance")) ||
          (values.team_access && !canManage(actor, "team")) ||
          (values.manage_accounts && !canManage(actor, "accounts")))
      )
        throw Error(
          "You can only grant or manage permissions within your own access.",
        );
    }
    if (action === "create") {
      const values = accountInput(body);
      withinScope(values);
      const employee = await api
        .from("garden_employees")
        .select("id")
        .ilike("email", values.email)
        .maybeSingle();
      if (employee.error)
        throw Error("Unable to check employee registrations.");
      if (employee.data)
        throw Error(
          "This email is registered to an employee. Use Invite employee instead, or a different email for an admin.",
        );
      const found = await findUser(values.email);
      let userId = found?.id;
      if (userId) {
        const existing = await api
          .from("garden_profiles")
          .select("id")
          .eq("id", userId)
          .maybeSingle();
        if (existing.error || existing.data)
          throw Error(
            "This account already exists. Edit its permissions or resend its setup email.",
          );
      } else {
        const created = await api.auth.admin.createUser({
          email: values.email,
          user_metadata: { display_name: values.display_name },
          email_confirm: true,
        });
        if (created.error)
          throw Error(
            "Unable to create this account. Check the email and retry.",
          );
        userId = created.data.user.id;
      }
      await save(userId, values);
      await setupEmail(values.email);
      return reply(
        "Account created. A secure setup email was sent; the recipient chooses their password.",
        200,
      );
    }
    if (action === "invite_employee") {
      if (!uuid(body.employee_id)) throw Error("Choose a registered employee.");
      const employee = await api
        .from("garden_employees")
        .select("id,name,email,active,profile_id")
        .eq("id", body.employee_id)
        .single();
      if (employee.error || !employee.data.active)
        throw Error("Choose an active registered employee.");
      const e = employee.data,
        found = await findUser(e.email);
      let userId = e.profile_id || found?.id;
      if (userId) {
        const profile = await api
          .from("garden_profiles")
          .select("role,active")
          .eq("id", userId)
          .maybeSingle();
        if (profile.error) throw Error("Unable to check account access.");
        if (profile.data && profile.data.role !== "employee")
          throw Error(
            "This address belongs to an administrator or finance viewer. Use a separate employee email.",
          );
        if (profile.data?.active === false)
          throw Error(
            "This employee account is disabled. Re-enable it before resending setup.",
          );
      } else {
        const created = await api.auth.admin.createUser({
          email: e.email,
          email_confirm: true,
          user_metadata: { display_name: e.name },
        });
        if (created.error)
          throw Error("Unable to create this employee account.");
        userId = created.data.user.id;
      }
      const bound = await api.rpc("garden_provision_employee", {
        p_actor: actor.id,
        p_employee: e.id,
        p_user: userId,
      });
      if (bound.error) throw Error(bound.error.message);
      await setupEmail(e.email);
      return reply(
        "Employee account linked. A secure password setup email was sent.",
        200,
      );
    }
    if (!uuid(body.id)) throw Error("Choose a saved account.");
    const target = await api
      .from("garden_profiles")
      .select("*")
      .eq("id", body.id)
      .single();
    if (target.error) throw Error("Account not found.");
    if (target.data.is_owner || target.data.id === actor.id)
      throw Error("Your own account and the workspace owner are protected.");
    withinScope({
      finance_access:
        target.data.role === "viewer" ||
        (target.data.role === "admin" && target.data.finance_access),
      team_access: target.data.role === "admin" && target.data.team_access,
      manage_accounts:
        target.data.role === "admin" && target.data.manage_accounts,
    });
    if (action === "revoke_pin") {
      if (target.data.role !== "employee")
        throw Error("Choose an employee account.");
      const employee = await api
        .from("garden_employees")
        .select("id")
        .eq("profile_id", body.id)
        .single();
      if (employee.error) throw Error("Employee account is not linked.");
      const revoked = await caller.rpc("garden_revoke_attendance_pin", {
        p_employee: employee.data.id,
      });
      if (revoked.error)
        throw Error(
          "Unable to revoke the attendance PIN. Check your account management permission.",
        );
      return reply(
        "Attendance PIN revoked. The employee must sign in to choose a new PIN.",
        200,
      );
    }
    if (action === "resend") {
      if (!target.data.active)
        throw Error("Re-enable this account before sending a setup email.");
      const user = await api.auth.admin.getUserById(body.id);
      if (user.error || !user.data.user.email)
        throw Error("Unable to find this account's email.");
      await setupEmail(user.data.user.email);
      return reply(
        "Password setup email sent. The recipient chooses their own password.",
        200,
      );
    }
    if (action !== "update") throw Error("Choose a valid account action.");
    const values =
      target.data.role === "employee"
        ? { ...target.data, active: body.active }
        : accountInput({
            ...body,
            email: body.email || "unused@example.invalid",
          });
    if (typeof values.active !== "boolean")
      throw Error("Choose an account status.");
    await save(body.id, values);
    return reply(
      values.active
        ? "Account permissions saved."
        : "Account disabled. Existing sessions can no longer access workspace records.",
      200,
    );
  } catch (e) {
    return reply(e instanceof Error ? e.message : "Unable to save account.");
  }
}
