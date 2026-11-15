import { timingSafeEqual } from "node:crypto";
import { staffService } from "@/lib/staff-server";
import {
  gmailConfigured,
  mailClient,
  mailKey,
  mailOrigin,
} from "@/lib/payroll-mail-server";
import {
  sha256,
  sealMailSecret,
  openMailSecret,
  PAYROLL_SENDER,
} from "@/lib/payroll-mail";
export const runtime = "nodejs";
export async function GET(request: Request) {
  let outcome = "failed";
  let issuedToken: string | undefined;
  try {
    if (!gmailConfigured()) throw Error("setup");
    const q = new URL(request.url).searchParams,
      state = q.get("state") || "",
      cookie =
        (request.headers.get("cookie") || "")
          .split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith("gardens_payroll_oauth="))
          ?.split("=")[1] || "";
    if (
      !/^[a-f0-9]{64}$/.test(state) ||
      cookie.length !== state.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(cookie))
    )
      throw Error("state");
    const api = staffService();
    // Claim once but retain the state so Disconnect can invalidate an in-flight callback.
    const pending = await api
      .from("garden_payroll_oauth_state")
      .update({ used: true })
      .eq("state_hash", sha256(state))
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .select("*")
      .single();
    if (pending.error || !pending.data) throw Error("expired");
    const actor = await api
      .from("garden_profiles")
      .select("is_owner,active,role")
      .eq("id", pending.data.actor_id)
      .single();
    if (
      actor.error ||
      !actor.data.is_owner ||
      !actor.data.active ||
      actor.data.role !== "admin"
    )
      throw Error("owner");
    if (q.get("error") || !q.get("code")) throw Error("cancelled");
    const { verifier, nonce } = JSON.parse(
        openMailSecret(pending.data.encrypted_verifier, mailKey()),
      ),
      client = mailClient();
    const { tokens } = await client.getToken({
      code: q.get("code")!,
      codeVerifier: verifier,
    });
    issuedToken = tokens.refresh_token || undefined;
    if (
      !tokens.id_token ||
      !tokens.refresh_token ||
      !tokens.scope
        ?.split(" ")
        .includes("https://www.googleapis.com/auth/gmail.send")
    )
      throw Error("scope");
    const verified = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GMAIL_OAUTH_CLIENT_ID,
    });
    const identity = verified.getPayload();
    if (
      !identity?.email_verified ||
      identity.email?.toLowerCase() !== PAYROLL_SENDER ||
      identity.nonce !== nonce
    ) {
      outcome = "wrong_sender";
      throw Error("sender");
    }
    // Recheck state and owner under the same lock used by Disconnect.
    const saved = await api.rpc("garden_connect_payroll_mail", {
      p_state: sha256(state),
      p_encrypted: sealMailSecret(tokens.refresh_token, mailKey()),
    });
    if (saved.error) throw Error("save");
    issuedToken = undefined;
    outcome = "connected";
  } catch {
    if (issuedToken)
      await mailClient()
        .revokeToken(issuedToken)
        .catch(() => {});
    /* Never log codes, refresh tokens, or provider responses. */
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: `${mailOrigin()}/team/?mail=${outcome}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": `gardens_payroll_oauth=; HttpOnly; SameSite=Lax; Path=/api/team/payroll-mail/callback/; Max-Age=0${mailOrigin().startsWith("https:") ? "; Secure" : ""}`,
    },
  });
}
