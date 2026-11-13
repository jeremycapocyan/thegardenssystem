// Fictional, local-only PDF fixture. Never connects to Supabase.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { demoTeam } from "../src/lib/team";
import { demoTimesheetReport } from "../src/lib/timesheets";
import { createTimesheetPdf } from "../src/lib/timesheet-pdf";
import { loadTimesheetPdfAssets } from "../src/lib/timesheet-pdf-assets";
const data = demoTeam();
data.requests = [];
data.attendance = [];
data.payroll = [];
for (const e of data.employees) e.started_on = "2026-11-01";
data.schedules = data.employees.map((e, i) => ({
  id: `s${i}`,
  employee_id: e.id,
  effective_from: "2026-11-01",
  weekdays: [1, 2, 3, 4, 5, 6],
}));
data.employees[0].name = "Alex Peña Reyes (fictional sample)";
data.employees[1].name = "María de los Ángeles Santos (fictional sample)";
for (const e of data.employees)
  for (const day of ["02", "03", "04"])
    data.attendance.push({
      id: `${e.id}-${day}`,
      employee_id: e.id,
      work_date: `2026-11-${day}`,
      clock_in: `2026-11-${day}T${day === "03" ? "08:00" : "07:30"}:00Z`,
      clock_out: `2026-11-${day}T${day === "04" ? "16:30" : "15:30"}:00Z`,
      ot_reviewed: true,
      approved_ot_seconds: day === "04" ? 3600 : 0,
      correction_reason: "",
    });
data.attendance.push({
  id: "open",
  employee_id: data.employees[0].id,
  work_date: "2026-11-05",
  clock_in: "2026-11-05T07:30:00Z",
  clock_out: null,
  ot_reviewed: false,
  approved_ot_seconds: null,
  correction_reason: "",
});
data.requests.push({
  id: "leave",
  employee_id: data.employees[1].id,
  kind: "sick",
  start_date: "2026-11-05",
  end_date: "2026-11-05",
  amount_cents: null,
  reason: "Fictional approved leave",
  status: "approved",
  paid_leave: true,
  decision_note: "Sample",
  created_at: "2026-11-01T00:00:00Z",
});
const assets = await loadTimesheetPdfAssets();
const root = path.resolve("..", "output", "pdf");
await mkdir(root, { recursive: true });
const report = demoTimesheetReport(
  data,
  "2026-11-01",
  "2026-11-07",
  null,
  new Date("2026-11-06T08:00:00Z"),
);
report.prepared_by = "SAMPLE WORKSPACE - no real employee records";
const sample = path.join(root, "The Gardens - Sample Timesheet.pdf");
await writeFile(sample, await createTimesheetPdf(report, assets));
const tmp = path.resolve("..", "tmp", "pdfs");
await mkdir(tmp, { recursive: true });
data.employees[1].name =
  "María de los Ángeles Peña Villanueva de la Cruz Santos - Long Name Layout Example";
const stress = demoTimesheetReport(
  data,
  "2026-11-01",
  "2026-12-01",
  null,
  new Date("2026-11-06T08:00:00Z"),
);
stress.prepared_by = report.prepared_by;
await writeFile(
  path.join(tmp, "stress-timesheet.pdf"),
  await createTimesheetPdf(stress, assets),
);
console.log("Created fictional PDF fixtures:", sample);
