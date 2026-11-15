import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { PayrollReportData } from "./payroll-reports";
import { reportFileName } from "./payroll-reports";
export const PAYROLL_SENDER = "theplaymakers2026@gmail.com";
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function sealMailSecret(value: string, keyHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex))
    throw Error("Payroll mail encryption is not configured.");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    ciphertext.toString("hex"),
  ].join(".");
}
export function openMailSecret(value: string, keyHex: string) {
  if (!/^[a-f0-9]{64}$/i.test(keyHex))
    throw Error("Payroll mail encryption is not configured.");
  const [iv, tag, ciphertext] = value.split(".");
  if (!iv || !tag || !ciphertext)
    throw Error("Gmail connection requires reconnection.");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(iv, "hex"),
  );
  cipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    cipher.update(Buffer.from(ciphertext, "hex")),
    cipher.final(),
  ]).toString("utf8");
}
export function validReportEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(
      value,
    ) &&
    !value.includes("..")
  );
}
const b64 = (value: Uint8Array | string) =>
  Buffer.from(value)
    .toString("base64")
    .match(/.{1,76}/g)
    ?.join("\r\n") || "";
export function payrollMime(
  report: PayrollReportData,
  pdf: Uint8Array,
  attempt: string,
) {
  if (
    !validReportEmail(report.employee.email) ||
    !/^[-a-f0-9]{36}$/i.test(attempt)
  )
    throw Error("Check the employee email before sending.");
  const boundary = `gardens_${attempt.replaceAll("-", "")}`;
  const body = `Hello ${report.employee.name.replace(/[\r\n]/g, " ")},\n\nAttached is your finalized cutoff payroll report for ${report.statement.period_start} to ${report.statement.period_end}.\n\nPayment status: ${report.payment_status}. Payment details are shown as of the generation time printed on the report.\n\nFor questions, please contact Jeremy.\n\nThe Gardens Pickleball Courts`;
  return [
    "From: The Gardens Payroll <" + PAYROLL_SENDER + ">",
    "To: <" + report.employee.email + ">",
    `Subject: The Gardens - Finalized payroll ${report.statement.period_start} to ${report.statement.period_end}`,
    `Message-ID: <${attempt}@thegardenssystem.vercel.app>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(body),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${reportFileName(report)}"`,
    `Content-Disposition: attachment; filename="${reportFileName(report)}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(pdf),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
// Gmail has no send idempotency key: retry uncertain transport outcomes only after human review.
export async function postPayrollGmail(
  accessToken: string,
  mime: string,
  sendFetch: typeof fetch = fetch,
) {
  try {
    const response = await sendFetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: Buffer.from(mime).toString("base64url") }),
        signal: AbortSignal.timeout(20000),
      },
    );
    if (response.ok) {
      const body = await response.json();
      return typeof body.id === "string"
        ? { status: "sent" as const, messageId: body.id, error: null }
        : {
            status: "unconfirmed" as const,
            messageId: null,
            error: "missing_confirmation",
          };
    }
    if (response.status >= 400 && response.status < 500)
      return {
        status: "failed" as const,
        messageId: null,
        error:
          response.status === 401
            ? "gmail_reconnect_required"
            : response.status === 429
              ? "gmail_limit"
              : "gmail_rejected",
      };
    return {
      status: "unconfirmed" as const,
      messageId: null,
      error: "gmail_confirmation_unknown",
    };
  } catch {
    return {
      status: "unconfirmed" as const,
      messageId: null,
      error: "gmail_confirmation_unknown",
    };
  }
}
