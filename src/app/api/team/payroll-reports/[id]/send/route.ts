import { staffAuth, staffReply, staffService } from "@/lib/staff-server";
import { validUuid } from "@/lib/attendance-input";
import {
  downloadReport,
  type StoredPayrollReport,
} from "@/lib/payroll-report-server";
import { gmailAccess } from "@/lib/payroll-mail-server";
import {
  payrollMime,
  postPayrollGmail,
  validReportEmail,
} from "@/lib/payroll-mail";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  const api = staffService();
  let attempt: string | null = null,
    dispatching = false;
  try {
    const { id } = await params,
      b = await request.json();
    if (!validUuid(id) || !validUuid(b.id))
      return staffReply("Choose a report and valid delivery reference.");
    const reserved = await api.rpc("garden_begin_report_delivery", {
      p_actor: ctx.profile.id,
      p_report: id,
      p_id: b.id,
      p_resend: b.resend === true,
      p_ack: b.acknowledge_uncertain === true,
    });
    if (reserved.error) return staffReply(reserved.error.message, 409);
    if (!reserved.data.claimed)
      return Response.json(
        { status: reserved.data.delivery.status },
        { headers: { "Cache-Control": "no-store" } },
      );
    attempt = b.id;
    const r = reserved.data.report as StoredPayrollReport;
    if (!validReportEmail(r.data.employee.email))
      throw Error(
        "The registered employee email must be corrected before sending.",
      );
    const [bytes, connection] = await Promise.all([
      downloadReport(r),
      gmailAccess(),
    ]);
    const mime = payrollMime(r.data, bytes, attempt!);
    const start = await api.rpc("garden_dispatch_report_delivery", {
      p_id: attempt,
      p_connection: connection.version,
    });
    if (start.error) throw Error(start.error.message);
    dispatching = true;
    const result = await postPayrollGmail(connection.accessToken, mime);
    const saved = await api.rpc("garden_finish_report_delivery", {
      p_id: attempt,
      p_status: result.status,
      p_message: result.messageId,
      p_error: result.error,
    });
    if (saved.error)
      return staffReply(
        "Gmail confirmation could not be saved. Refresh history and check Gmail Sent before resending.",
        503,
      );
    return Response.json(
      { status: result.status },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    if (attempt)
      await api.rpc("garden_finish_report_delivery", {
        p_id: attempt,
        p_status: dispatching ? "unconfirmed" : "failed",
        p_message: null,
        p_error: dispatching
          ? "gmail_confirmation_unknown"
          : "preflight_failed",
      });
    return staffReply(
      dispatching
        ? "Sending could not be confirmed. Check Gmail Sent before explicitly resending."
        : e instanceof Error
          ? e.message
          : "Sending is unavailable.",
      dispatching ? 503 : 409,
    );
  }
}
