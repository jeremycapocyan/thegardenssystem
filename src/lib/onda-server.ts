import "server-only";
import { buildOndaAccountPreview, ondaEntryAccount } from "./onda-accounts";
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { canManage } from "./access";
import { staffService } from "./staff-server";
import {
  resolvedOndaAmount,
  ONDA_MAX_BYTES,
  type OndaContext,
  type OndaPreview,
  type OndaReport,
  type OndaResolution,
} from "./onda";
import { parseOndaPdf } from "./onda-pdf";
import type { Profile } from "./types";
const BUCKET = "garden-income-imports";
export const ondaReply = (message: string, status = 400) =>
  Response.json(
    { message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
export const ondaUuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export interface StoredOndaImport {
  id: string;
  sha256: string;
  filename: string;
  file_bytes: number;
  actor_id: string;
  parsed: OndaReport;
  plan: OndaPreview;
  snapshot_hash: string;
  state: "preview" | "confirmed";
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  result: {
    import_id: string;
    inserted: number;
    updated: number;
    unchanged: number;
    change_cents: number;
    source_net_cents: number;
    already_imported?: boolean;
  } | null;
}
export async function ondaAuth(request: Request) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    return ondaReply("The shared workspace is not configured.", 503);
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return ondaReply("Sign in first.", 401);
  const caller = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const auth = await caller.auth.getUser(token);
  if (auth.error || !auth.data.user) return ondaReply("Sign in again.", 401);
  const profile = await caller
    .from("garden_profiles")
    .select("*")
    .eq("id", auth.data.user.id)
    .single();
  if (profile.error || !canManage(profile.data as Profile, "finance"))
    return ondaReply("Finance management permission required.", 403);
  return { actor: auth.data.user.id };
}
export function ondaError(e: unknown) {
  const message =
    e instanceof Error
      ? e.message
      : "The import could not be completed. Retry or refresh the preview.";
  return ondaReply(
    message,
    /permission/i.test(message)
      ? 403
      : /changed|expired|already|removed/i.test(message)
        ? 409
        : 400,
  );
}
export async function ondaContext(actor: string): Promise<OndaContext> {
  const r = await staffService().rpc("garden_onda_context", { p_actor: actor });
  if (r.error) throw Error(r.error.message);
  return r.data as OndaContext;
}
export async function storedOnda(id: string) {
  const r = await staffService()
    .from("garden_onda_imports")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (r.error || !r.data) throw Error("Import not found.");
  return r.data as StoredOndaImport;
}
export function ondaPresentation(r: StoredOndaImport) {
  return {
    id: r.id,
    filename: r.filename,
    state: r.state,
    expires_at: r.expires_at,
    created_at: r.created_at,
    confirmed_at: r.confirmed_at,
    preview: r.plan,
    result: r.result,
  };
}
export async function prepareOnda(request: Request, actor: string) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > ONDA_MAX_BYTES + 100000)
    throw Error("Choose one PDF no larger than 4 MB.");
  const form = await request.formData(),
    file = form.get("file"),
    id = form.get("id");
  if (
    !ondaUuid(id) ||
    !(file instanceof File) ||
    form.getAll("file").length !== 1
  )
    throw Error("Choose one Onda PDF.");
  if (
    !file.size ||
    file.size > ONDA_MAX_BYTES ||
    !file.name.toLowerCase().endsWith(".pdf")
  )
    throw Error("Choose one PDF no larger than 4 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    hash = createHash("sha256").update(bytes).digest("hex"),
    api = staffService();
  const existing = await api
    .from("garden_onda_imports")
    .select("*")
    .eq("sha256", hash)
    .eq("encoding_version", 2)
    .eq("state", "confirmed")
    .maybeSingle();
  if (existing.error) throw Error("Unable to check import history. Retry.");
  if (existing.data)
    return {
      ...ondaPresentation(existing.data as StoredOndaImport),
      already_imported: true,
    };
  const prior = await api
    .from("garden_onda_imports")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (prior.error) throw Error("Unable to check the upload reference.");
  if (prior.data) {
    if (prior.data.actor_id !== actor || prior.data.sha256 !== hash)
      throw Error("This upload reference belongs to another file.");
    return ondaPresentation(prior.data as StoredOndaImport);
  }
  const parsed = await parseOndaPdf(bytes),
    context = await ondaContext(actor),
    plan = buildOndaAccountPreview(parsed, context);
  const upload = await api.storage.from(BUCKET).upload(`${id}.pdf`, bytes, {
    contentType: "application/pdf",
    cacheControl: "0",
    upsert: false,
  });
  if (upload.error) {
    const saved = await api.storage.from(BUCKET).download(`${id}.pdf`);
    if (
      saved.error ||
      createHash("sha256")
        .update(new Uint8Array(await saved.data.arrayBuffer()))
        .digest("hex") !== hash
    )
      throw Error("The PDF upload could not be verified. Retry the same file.");
  }
  const prepared = await api.rpc("garden_onda_prepare", {
    p_actor: actor,
    p_id: id,
    p_hash: hash,
    p_name: file.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 200),
    p_bytes: bytes.length,
    p_parsed: parsed,
    p_plan: plan,
    p_snapshot: context.fingerprint,
  });
  if (prepared.error) throw Error(prepared.error.message);
  return ondaPresentation(prepared.data as StoredOndaImport);
}
export async function refreshOnda(actor: string, id: string) {
  const r = await storedOnda(id);
  if (r.actor_id !== actor)
    throw Error(
      "This preview belongs to another admin. Upload the file under your account.",
    );
  if (r.state === "confirmed") return ondaPresentation(r);
  const context = await ondaContext(actor),
    plan = buildOndaAccountPreview(r.parsed, context);
  const updated = await staffService().rpc("garden_onda_refresh", {
    p_actor: actor,
    p_id: id,
    p_plan: plan,
    p_snapshot: context.fingerprint,
  });
  if (updated.error) throw Error(updated.error.message);
  return ondaPresentation(updated.data as StoredOndaImport);
}
export async function confirmOnda(actor: string, id: string, body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw Error("Choose reconciliation decisions.");
  const choices = (body as Record<string, unknown>).resolutions;
  if (!choices || typeof choices !== "object" || Array.isArray(choices))
    throw Error("Choose reconciliation decisions.");
  const r = await storedOnda(id);
  if (r.actor_id !== actor)
    throw Error("This preview belongs to another admin.");
  const resolutions = choices as Record<string, OndaResolution>;
  for (const key of Object.keys(resolutions)) {
    const choice = resolutions[key];
    if (
      !r.plan.proposals.some((p) => p.key === key) ||
      !choice ||
      typeof choice !== "object" ||
      (choice.replace_notes !== undefined &&
        typeof choice.replace_notes !== "boolean")
    )
      throw Error("Invalid reconciliation choices.");
  }
  if (r.state !== "confirmed") {
    if (r.plan.blockers.length)
      throw Error("Resolve the blocking report warnings first.");
    for (const p of r.plan.proposals) resolvedOndaAmount(p, resolutions[p.key]);
  }
  const transactional = r.plan.encoding_version === 2;
  const accounts = ((body as Record<string, unknown>).accounts || {}) as Record<
    string,
    "cash" | "bank" | "booking"
  >;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts))
    throw Error("Choose valid transaction accounts.");
  if (transactional && r.state !== "confirmed")
    for (const entry of r.plan.entries || []) ondaEntryAccount(entry, accounts);
  const result = await staffService().rpc(
    transactional ? "garden_onda_confirm_transactions" : "garden_onda_confirm",
    {
      p_actor: actor,
      p_id: id,
      p_resolutions: resolutions,
      ...(transactional
        ? {
            p_accounts: accounts,
            p_replace_allocations:
              (body as Record<string, unknown>).replace_allocations === true,
          }
        : {}),
    },
  );
  if (result.error) throw Error(result.error.message);
  return result.data;
}
export async function downloadOnda(id: string) {
  const r = await storedOnda(id),
    file = await staffService().storage.from(BUCKET).download(`${id}.pdf`);
  if (file.error) throw Error("The original PDF is temporarily unavailable.");
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== r.sha256)
    throw Error("The original PDF could not be verified.");
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Onda-${r.id}.pdf"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
