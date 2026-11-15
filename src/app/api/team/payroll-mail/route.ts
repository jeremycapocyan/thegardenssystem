import { randomBytes, randomUUID } from "node:crypto";
import { staffAuth, staffReply, staffService } from "@/lib/staff-server";
import {
  gmailConfigured,
  gmailConnection,
  mailClient,
  mailKey,
  mailOrigin,
} from "@/lib/payroll-mail-server";
import {
  PAYROLL_SENDER,
  sealMailSecret,
  openMailSecret,
  sha256,
} from "@/lib/payroll-mail";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  try {
    const c = await gmailConnection();
    return Response.json(
      {
        configured: gmailConfigured(),
        connected: gmailConfigured() && !!c?.connected,
        sender: PAYROLL_SENDER,
        owner: ctx.profile.is_owner === true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return staffReply("Gmail status unavailable.", 503);
  }
}
export async function POST(request: Request) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  if (!ctx.profile.is_owner)
    return staffReply(
      "Only the workspace owner can manage the Gmail connection.",
      403,
    );
  try {
    const body = await request.json(),
      api = staffService();
    if (body.action === "disconnect") {
      const disabled = await api.rpc("garden_disconnect_payroll_mail", {
        p_actor: ctx.profile.id,
      });
      if (disabled.error) throw Error("Disconnect could not be saved. Retry.");
      const c = disabled.data;
      let revoked = true;
      if (c && gmailConfigured()) {
        try {
          await mailClient().revokeToken(
            openMailSecret(c.encrypted_token, mailKey()),
          );
        } catch {
          revoked = false;
        }
      }
      return staffReply(
        revoked
          ? "Payroll Gmail disconnected."
          : "Sending is disabled. Also remove The Gardens connection in your Google Account to finish revocation.",
        200,
      );
    }
    if (body.action !== "connect")
      return staffReply("Choose Connect Gmail or Disconnect Gmail.");
    if (!gmailConfigured())
      return staffReply(
        "Complete the Google Cloud OAuth setup shown in Payroll settings first.",
        409,
      );
    const state = randomBytes(32).toString("hex"),
      verifier = randomBytes(48).toString("base64url"),
      nonce = randomUUID();
    await api
      .from("garden_payroll_oauth_state")
      .delete()
      .lt("expires_at", new Date().toISOString());
    const saved = await api.from("garden_payroll_oauth_state").insert({
      state_hash: sha256(state),
      actor_id: ctx.profile.id,
      encrypted_verifier: sealMailSecret(
        JSON.stringify({ verifier, nonce }),
        mailKey(),
      ),
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });
    if (saved.error) throw Error("Unable to start Gmail authorization.");
    const url = mailClient().generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      login_hint: PAYROLL_SENDER,
      scope: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"],
      state,
      nonce,
      code_challenge: Buffer.from(sha256(verifier), "hex").toString(
        "base64url",
      ),
      code_challenge_method: "S256" as never,
    });
    return Response.json(
      { url },
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Set-Cookie": `gardens_payroll_oauth=${state}; HttpOnly; SameSite=Lax; Path=/api/team/payroll-mail/callback/; Max-Age=600${mailOrigin().startsWith("https:") ? "; Secure" : ""}`,
        },
      },
    );
  } catch {
    return staffReply(
      "Gmail connection could not be changed. Retry or check the owner setup.",
      503,
    );
  }
}
