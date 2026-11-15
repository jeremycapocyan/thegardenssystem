import "server-only";
import { OAuth2Client } from "google-auth-library";
import { staffService } from "./staff-server";
import { openMailSecret, PAYROLL_SENDER } from "./payroll-mail";
export const gmailConfigured = () =>
  !!(
    process.env.GMAIL_OAUTH_CLIENT_ID &&
    process.env.GMAIL_OAUTH_CLIENT_SECRET &&
    /^[a-f0-9]{64}$/i.test(process.env.PAYROLL_MAIL_ENCRYPTION_KEY || "")
  );
export const mailKey = () => process.env.PAYROLL_MAIL_ENCRYPTION_KEY || "";
export const mailOrigin = () =>
  process.env.APP_URL || "https://thegardenssystem.vercel.app";
export const mailClient = () =>
  new OAuth2Client(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET,
    `${mailOrigin()}/api/team/payroll-mail/callback/`,
  );
export async function gmailConnection() {
  const result = await staffService()
    .from("garden_payroll_mail_connection")
    .select("*")
    .eq("id", true)
    .maybeSingle();
  if (result.error) throw Error("Gmail connection status is unavailable.");
  return result.data as {
    version: string;
    sender: string;
    encrypted_token: string;
    connected: boolean;
  } | null;
}
export async function gmailAccess() {
  if (!gmailConfigured())
    throw Error("The owner must finish Gmail setup before sending payroll.");
  const connection = await gmailConnection();
  if (!connection?.connected || connection.sender !== PAYROLL_SENDER)
    throw Error("Reconnect the payroll Gmail sender first.");
  const refreshToken = openMailSecret(connection.encrypted_token, mailKey());
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GMAIL_OAUTH_CLIENT_ID!,
        client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || !result.access_token) {
      if (result.error === "invalid_grant")
        await staffService()
          .from("garden_payroll_mail_connection")
          .update({ connected: false })
          .eq("version", connection.version);
      throw Error(
        "Gmail authorization is unavailable. The owner may need to reconnect.",
      );
    }
    return {
      accessToken: result.access_token as string,
      version: connection.version,
    };
  } catch {
    throw Error(
      "Gmail authorization is unavailable. The owner may need to reconnect.",
    );
  }
}
