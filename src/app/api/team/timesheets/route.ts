import { staffAuth, staffReply } from "@/lib/staff-server";
import { validUuid } from "@/lib/attendance-pin";
import { validateTimesheetRange, type TimesheetReport } from "@/lib/timesheets";
import { createTimesheetPdf } from "@/lib/timesheet-pdf";
import { loadTimesheetPdfAssets } from "@/lib/timesheet-pdf-assets";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  try {
    const query = new URL(request.url).searchParams,
      start = query.get("start") || "",
      end = query.get("end") || "",
      employee = query.get("employee") || null;
    validateTimesheetRange(start, end);
    if (employee && !validUuid(employee))
      return staffReply("Choose a saved employee.");
    const result = await ctx.caller.rpc("garden_timesheet_report", {
      p_start: start,
      p_end: end,
      p_employee: employee,
    });
    if (result.error)
      return staffReply(
        "The timesheet could not be loaded. Refresh the employee records and retry.",
        result.error.code === "42501" ? 403 : 400,
      );
    const pdf = await createTimesheetPdf(
      result.data as TimesheetReport,
      await loadTimesheetPdfAssets(),
    );
    return new Response(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="The-Gardens-Timesheet-${start}-${end}.pdf"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return staffReply(
      e instanceof Error && /date|range/i.test(e.message)
        ? "Choose a valid date range of up to 31 days."
        : "The PDF could not be generated. Try again.",
      400,
    );
  }
}
