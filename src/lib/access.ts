import type { Profile } from "./types";

export type Scope = "finance" | "team" | "accounts";
export function canManage(profile: Profile | null, scope: Scope): boolean {
  if (!profile || profile.active === false || profile.role !== "admin")
    return false;
  if (profile.is_owner) return true;
  // Older fictional fixtures retain their original finance/team permissions.
  return scope === "finance"
    ? profile.finance_access !== false
    : scope === "team"
      ? profile.team_access !== false
      : profile.manage_accounts === true;
}
export function canViewFinance(profile: Profile | null): boolean {
  return (
    !!profile &&
    profile.active !== false &&
    (profile.role === "viewer" || canManage(profile, "finance"))
  );
}
export function accountInput(value: unknown) {
  if (!value || typeof value !== "object")
    throw Error("Enter account details.");
  const v = value as Record<string, unknown>;
  const name = typeof v.display_name === "string" ? v.display_name.trim() : "";
  const email = typeof v.email === "string" ? v.email.trim().toLowerCase() : "";
  if (!name || name.length > 100)
    throw Error("Enter a name up to 100 characters.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    throw Error("Enter a valid email address.");
  if (!["admin", "viewer"].includes(String(v.role)))
    throw Error("Choose administrator or finance viewer.");
  for (const key of [
    "finance_access",
    "team_access",
    "manage_accounts",
    "active",
  ])
    if (typeof v[key] !== "boolean")
      throw Error("Choose explicit account permissions.");
  const role = v.role as "admin" | "viewer";
  const finance_access = role === "viewer" || v.finance_access === true;
  const team_access = role === "admin" && v.team_access === true;
  const manage_accounts = role === "admin" && v.manage_accounts === true;
  if (role === "admin" && !finance_access && !team_access && !manage_accounts)
    throw Error("Choose at least one administrator permission.");
  return {
    display_name: name,
    email,
    role,
    finance_access,
    team_access,
    manage_accounts,
    active: v.active as boolean,
  };
}
