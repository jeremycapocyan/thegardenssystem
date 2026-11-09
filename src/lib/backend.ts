import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { canViewFinance } from "./access";
import {
  EMPTY_DATA,
  type Collection,
  type Dataset,
  type Profile,
} from "./types";

let client: SupabaseClient | null = null;
export function getBackend(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  if (!client)
    client = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  return client;
}
export async function loadWorkspace(): Promise<{
  profile: Profile;
  data: Dataset;
}> {
  const api = getBackend();
  if (!api) throw new Error("The shared workspace has not been configured.");
  const { data: auth, error: authError } = await api.auth.getUser();
  if (authError || !auth.user) throw new Error("Please sign in again.");
  const { data: profile, error: profileError } = await api
    .from("garden_profiles")
    .select(
      "id, display_name, role, active, is_owner, finance_access, team_access, manage_accounts",
    )
    .eq("id", auth.user.id)
    .maybeSingle();
  if (profileError)
    throw new Error("Unable to check your workspace access. Please try again.");
  if (!profile)
    throw new Error(
      "Your account does not have access to The Gardens workspace. Ask Jeremy to add your account.",
    );
  if (!profile.active)
    throw new Error(
      "Your account does not have access because it is disabled. Ask an account administrator.",
    );
  if (!canViewFinance(profile as Profile))
    return { profile: profile as Profile, data: EMPTY_DATA };
  const { data, error } = await api.rpc("garden_snapshot");
  if (error)
    throw new Error(
      "Unable to load records. Check the connection and try Refresh.",
    );
  return { profile: profile as Profile, data: data as Dataset };
}
export const tables: Record<Collection, string> = {
  categories: "garden_categories",
  income: "garden_income",
  expenses: "garden_expenses",
  installments: "garden_installments",
  payouts: "garden_payouts",
};
export function friendlyError(error: {
  message?: string;
  code?: string;
}): string {
  if (error.code === "23505")
    return "This record already exists. For daily income, edit the existing date and category entry.";
  if (error.code === "23503")
    return "This item is linked to other records. Keep the agreement or category so its payment history stays intact.";
  if (error.code === "23P01")
    return "Bill terms overlap. Use Change terms to start a new monthly amount.";
  if (error.code === "42501")
    return "Your account can view records but cannot change them.";
  if (error.code === "PGRST116")
    return "The record is no longer available, or your access changed. Refresh the workspace.";
  return error.message || "The change could not be saved. Please try again.";
}
