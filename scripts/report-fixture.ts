import { demoTeam, previewPayroll } from "../src/lib/team";
import { demoPayrollReport } from "../src/lib/payroll-reports";
export function payrollReportFixture() {
  const data = demoTeam(),
    e = data.employees[0];
  data.employees = [e];
  e.name = "María de los Ángeles Peña Santos (fictional sample)";
  e.started_on = "2026-11-01";
  data.schedules = [
    {
      id: "s",
      employee_id: e.id,
      effective_from: e.started_on,
      weekdays: [1, 2, 3, 4, 5, 6],
    },
  ];
  data.overrides = [];
  data.attendance = [];
  data.payroll = [];
  data.requests = [];
  data.recoveries = [];
  for (const day of ["02", "03", "04", "07", "09"])
    data.attendance.push({
      id: `a-${day}`,
      employee_id: e.id,
      work_date: `2026-11-${day}`,
      clock_in: `2026-11-${day}T${day === "03" ? "08:00" : "07:30"}:00Z`,
      clock_out: `2026-11-${day}T${day === "04" ? "16:30" : day === "07" ? "14:30" : "15:30"}:00Z`,
      ot_reviewed: true,
      approved_ot_seconds: day === "04" ? 3600 : 0,
      correction_reason: "Fictional example",
    });
  for (const [day, kind, paid] of [
    ["05", "sick", true],
    ["06", "leave", false],
  ] as const)
    data.requests.push({
      id: day,
      employee_id: e.id,
      kind,
      start_date: `2026-11-${day}`,
      end_date: `2026-11-${day}`,
      amount_cents: null,
      reason: "Fictional example",
      status: "approved",
      paid_leave: paid,
      decision_note: "",
      created_at: "2026-11-01T00:00:00Z",
    });
  data.cash = [
    {
      id: "advance",
      employee_id: e.id,
      kind: "advance",
      request_id: "advance-request",
      payroll_id: null,
      amount_cents: 100000,
      paid_on: "2026-11-03",
      reference: "Fictional advance",
      created_at: "2026-11-03T00:00:00Z",
    },
  ];
  const snapshot = previewPayroll(
    data,
    e.id,
    "2026-11-01",
    new Date("2026-11-13T00:00:00Z"),
  );
  data.payroll = [
    {
      id: "b1000000-0000-4000-8000-000000000001",
      employee_id: e.id,
      period_start: snapshot.period_start,
      period_end: snapshot.period_end,
      snapshot,
      gross_cents: snapshot.gross_cents,
      recovery_cents: snapshot.recovery_cents,
      payable_cents: snapshot.payable_cents,
      finalized_at: "2026-11-13T01:00:00Z",
    },
  ];
  data.cash.push({
    id: "salary",
    employee_id: e.id,
    kind: "salary",
    request_id: null,
    payroll_id: data.payroll[0].id,
    amount_cents: 100000,
    paid_on: "2026-11-13",
    reference: "Fictional partial salary payment",
    created_at: "2026-11-13T01:30:00Z",
  });
  const report = demoPayrollReport(
    data,
    data.payroll[0].id,
    "c1000000-0000-4000-8000-000000000001",
    new Date("2026-11-13T02:00:00Z"),
  );
  report.prepared_by = "SAMPLE WORKSPACE - no real payroll records";
  return { data, report };
}
