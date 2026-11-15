import { staffAuth, staffReply } from "@/lib/staff-server";
import { storedReport, downloadReport } from "@/lib/payroll-report-server";
import { reportFileName } from "@/lib/payroll-reports";
import { validUuid } from "@/lib/attendance-input";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  try {
    const { id } = await params;
    if (!validUuid(id)) return staffReply("Choose a report.");
    const r = await storedReport(id),
      bytes = await downloadReport(r);
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${reportFileName(r.data)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "frame-ancestors 'self'",
      },
    });
  } catch (e) {
    return staffReply(e instanceof Error ? e.message : "PDF unavailable.", 404);
  }
}
