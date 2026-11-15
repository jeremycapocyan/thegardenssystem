import { staffAuth, staffReply } from "@/lib/staff-server";
import { validUuid } from "@/lib/attendance-input";
import { generatePayrollReport } from "@/lib/payroll-report-server";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function GET(request: Request) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  const id = new URL(request.url).searchParams.get("payroll_id");
  if (!validUuid(id))
    return staffReply("Choose a finalized payroll statement.");
  const result = await ctx.caller.rpc("garden_payroll_report_history", {
    p_payroll: id,
  });
  if (result.error) return staffReply("Unable to load report history.", 503);
  return Response.json(result.data, {
    headers: { "Cache-Control": "no-store" },
  });
}
export async function POST(request: Request) {
  const ctx = await staffAuth(request, "team");
  if (ctx instanceof Response) return ctx;
  try {
    const b = await request.json();
    if (!validUuid(b.payroll_id) || !validUuid(b.id))
      return staffReply(
        "Choose a finalized payroll statement and a valid report reference.",
      );
    return Response.json(
      await generatePayrollReport(ctx.profile.id, b.payroll_id, b.id),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return staffReply(
      e instanceof Error
        ? e.message
        : "Report creation could not be confirmed.",
      409,
    );
  }
}
