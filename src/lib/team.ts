import { addDays, monthEnd, todayInManila, toDate } from "./finance";

export interface Employee {
  id: string;
  profile_id: string | null;
  name: string;
  email: string;
  started_on: string;
  ended_on: string | null;
  active: boolean;
  employee_code?: string;
  pin_configured?: boolean;
}
export interface Schedule {
  id: string;
  employee_id: string;
  effective_from: string;
  weekdays: number[];
}
export interface ScheduleOverride {
  id: string;
  employee_id: string;
  work_date: string;
  working: boolean;
  reason: string;
}
export interface Attendance {
  id: string;
  employee_id: string;
  work_date: string;
  clock_in: string;
  clock_out: string | null;
  approved_ot_seconds: number | null;
  ot_reviewed: boolean;
  correction_reason: string;
  voided?: boolean;
}
export type RequestKind = "leave" | "sick" | "advance";
export interface StaffRequest {
  id: string;
  employee_id: string;
  kind: RequestKind;
  start_date: string | null;
  end_date: string | null;
  amount_cents: number | null;
  reason: string;
  status: "pending" | "approved" | "rejected" | "withdrawn";
  paid_leave: boolean | null;
  decision_note: string;
  created_at: string;
}
export interface StaffCash {
  id: string;
  employee_id: string;
  kind: "advance" | "salary";
  request_id: string | null;
  payroll_id: string | null;
  amount_cents: number;
  paid_on: string;
  reference: string;
  created_at: string;
}
export interface Recovery {
  id: string;
  employee_id: string;
  cash_id: string;
  payroll_id: string;
  amount_cents: number;
}
export interface PayrollDay {
  date: string;
  status: string;
  scheduled: boolean;
  attendance_id: string | null;
  clock_in: string | null;
  clock_out: string | null;
  late_seconds: number;
  undertime_seconds: number;
  regular_seconds: number;
  overtime_seconds: number;
  approved_ot_seconds: number;
  ot_reviewed: boolean | null;
  deduction_cents: number;
  regular_cents: number;
  ot_cents: number;
  leave_cents: number;
  total_cents: number;
}
export interface PayrollPreview {
  employee_id: string;
  period_start: string;
  period_end: string;
  days: PayrollDay[];
  blockers: string[];
  regular_cents: number;
  deduction_cents: number;
  ot_cents: number;
  leave_cents: number;
  gross_cents: number;
  advance_balance_cents: number;
  recovery_cents: number;
  payable_cents: number;
  daily_cents: number;
  hourly_cents: number;
}
export interface Payroll {
  id: string;
  employee_id: string;
  period_start: string;
  period_end: string;
  snapshot: PayrollPreview;
  gross_cents: number;
  recovery_cents: number;
  payable_cents: number;
  finalized_at: string;
}
export interface TeamData {
  employees: Employee[];
  schedules: Schedule[];
  overrides: ScheduleOverride[];
  attendance: Attendance[];
  requests: StaffRequest[];
  payroll: Payroll[];
  cash: StaffCash[];
  recoveries: Recovery[];
  qr: { id: string } | null;
  settings: { wages_category_id: string } | null;
}
export const emptyTeam = (): TeamData => ({
  employees: [],
  schedules: [],
  overrides: [],
  attendance: [],
  requests: [],
  payroll: [],
  cash: [],
  recoveries: [],
  qr: null,
  settings: null,
});
export const TEAM_DEMO_STORE = "gardens.team.sample.v1";
export const DEMO_EMPLOYEE = "a1000000-0000-4000-8000-000000000001";
export const employeePeriod = (date: string) =>
  `${date.slice(0, 7)}-${Number(date.slice(8)) <= 15 ? "01" : "16"}`;
export const payrollEnd = (start: string) =>
  start.slice(8) === "01" ? `${start.slice(0, 7)}-15` : monthEnd(start);
export const manilaInput = (timestamp: string) =>
  new Date(new Date(timestamp).valueOf() + 8 * 3600000)
    .toISOString()
    .slice(0, 16);
export const fromManilaInput = (input: string) =>
  new Date(`${input}:00+08:00`).toISOString();
export const timeInManila = (timestamp: string | null) =>
  timestamp
    ? new Intl.DateTimeFormat("en-PH", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "Asia/Manila",
      }).format(new Date(timestamp))
    : "—";
export const duration = (seconds: number) =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m${Math.floor(seconds % 60) ? ` ${Math.floor(seconds % 60)}s` : ""}`;
export function workingOn(data: TeamData, employee: Employee, date: string) {
  const override = data.overrides.find(
    (o) => o.employee_id === employee.id && o.work_date === date,
  );
  const schedule = data.schedules
    .filter((s) => s.employee_id === employee.id && s.effective_from <= date)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  return (
    date >= employee.started_on &&
    (!employee.ended_on || date <= employee.ended_on) &&
    (override?.working ??
      schedule?.weekdays.includes(toDate(date).getUTCDay()) ??
      false)
  );
}
// Demo estimates mirror the database. Live payroll is always computed by PostgreSQL.
export function previewPayroll(
  data: TeamData,
  eid: string,
  start: string,
  now = new Date(),
): PayrollPreview {
  const employee = data.employees.find((e) => e.id === eid);
  if (!employee) throw Error("Select an employee.");
  const end = payrollEnd(start);
  const days: PayrollDay[] = [];
  const blockers: string[] = [];
  if (
    !data.schedules.some(
      (s) =>
        s.employee_id === eid &&
        s.effective_from <=
          (employee.started_on > start ? employee.started_on : start),
    )
  )
    blockers.push("Add an effective weekly work schedule.");
  for (let date = start; date <= end; date = addDays(date, 1)) {
    const scheduled = workingOn(data, employee, date);
    const a = data.attendance.find(
      (a) => a.employee_id === eid && a.work_date === date && !a.voided,
    );
    const leave = data.requests.find(
      (r) =>
        r.employee_id === eid &&
        r.kind !== "advance" &&
        r.status === "approved" &&
        r.start_date! <= date &&
        r.end_date! >= date,
    );
    const shiftStart = new Date(`${date}T15:30:00+08:00`).valueOf(),
      shiftEnd = shiftStart + 28800000;
    let status = scheduled ? "Upcoming" : "Rest day",
      regular_seconds = 0,
      overtime_seconds = 0,
      approved_ot_seconds = 0,
      deduction_cents = 0,
      regular_cents = 0,
      ot_cents = 0,
      leave_cents = 0;
    if (scheduled && shiftEnd > now.valueOf())
      blockers.push(`${date}: scheduled shift has not finished.`);
    if (a && !scheduled) {
      status = "Unscheduled work";
      blockers.push(`${date}: add a workday override or correct this punch.`);
    }
    if (a && leave && scheduled) {
      status = "Leave conflict";
      blockers.push(`${date}: approved leave overlaps attendance.`);
    } else if (a && scheduled) {
      if (!a.clock_out) {
        status = shiftEnd > now.valueOf() ? "Timed in" : "Missing time out";
        blockers.push(`${date}: missing time out.`);
      } else {
        const punchIn = new Date(a.clock_in).valueOf(),
          punchOut = new Date(a.clock_out).valueOf();
        regular_seconds = Math.min(
          28800,
          Math.max(
            0,
            (Math.min(punchOut, shiftEnd) - Math.max(punchIn, shiftStart)) /
              1000,
          ),
        );
        deduction_cents = Math.round(
          (65000 * (28800 - regular_seconds)) / 28800,
        );
        regular_cents = 65000 - deduction_cents;
        overtime_seconds = Math.max(
          0,
          (punchOut - Math.max(punchIn, shiftEnd)) / 1000,
        );
        approved_ot_seconds = Math.min(
          overtime_seconds,
          a.approved_ot_seconds || 0,
        );
        ot_cents = Math.round((65000 * approved_ot_seconds) / 28800);
        if (overtime_seconds && !a.ot_reviewed)
          blockers.push(`${date}: overtime needs approval or rejection.`);
        status =
          punchIn > shiftStart
            ? punchOut < shiftEnd
              ? "Late / undertime"
              : "Late"
            : punchOut < shiftEnd
              ? "Undertime"
              : "Present";
      }
    } else if (scheduled && leave) {
      leave_cents = leave.paid_leave ? 65000 : 0;
      status = `${leave.kind === "sick" ? "Sick leave" : "Leave"} · ${leave.paid_leave ? "paid" : "unpaid"}`;
    } else if (scheduled && shiftEnd <= now.valueOf()) {
      status = "Absent";
      deduction_cents = 65000;
    }
    if (
      scheduled &&
      data.requests.some(
        (r) =>
          r.employee_id === eid &&
          r.kind !== "advance" &&
          r.status === "pending" &&
          r.start_date! <= date &&
          r.end_date! >= date,
      )
    )
      blockers.push(`${date}: pending leave request.`);
    days.push({
      date,
      status,
      scheduled,
      attendance_id: a?.id || null,
      clock_in: a?.clock_in || null,
      clock_out: a?.clock_out || null,
      late_seconds:
        a && scheduled
          ? Math.max(0, (new Date(a.clock_in).valueOf() - shiftStart) / 1000)
          : 0,
      undertime_seconds:
        a?.clock_out && scheduled
          ? Math.max(0, (shiftEnd - new Date(a.clock_out).valueOf()) / 1000)
          : 0,
      regular_seconds,
      overtime_seconds,
      approved_ot_seconds,
      ot_reviewed: a?.ot_reviewed ?? null,
      deduction_cents,
      regular_cents,
      ot_cents,
      leave_cents,
      total_cents: regular_cents + ot_cents + leave_cents,
    });
  }
  const sum = (
    key:
      | "regular_cents"
      | "deduction_cents"
      | "ot_cents"
      | "leave_cents"
      | "total_cents",
  ) => days.reduce((n, d) => n + d[key], 0);
  const advance_balance_cents = Math.max(
    0,
    data.cash
      .filter((c) => c.employee_id === eid && c.kind === "advance")
      .reduce((n, c) => n + c.amount_cents, 0) -
      data.recoveries
        .filter((r) => r.employee_id === eid)
        .reduce((n, r) => n + r.amount_cents, 0),
  );
  const gross_cents = sum("total_cents"),
    recovery_cents = Math.min(gross_cents, advance_balance_cents);
  return {
    employee_id: eid,
    period_start: start,
    period_end: end,
    days,
    blockers,
    regular_cents: sum("regular_cents"),
    deduction_cents: sum("deduction_cents"),
    ot_cents: sum("ot_cents"),
    leave_cents: sum("leave_cents"),
    gross_cents,
    advance_balance_cents,
    recovery_cents,
    payable_cents: gross_cents - recovery_cents,
    daily_cents: 65000,
    hourly_cents: 8125,
  };
}
export function demoTeam(): TeamData {
  const data = emptyTeam();
  const today = todayInManila();
  const start = employeePeriod(today);
  const lastPeriod =
    Number(start.slice(8)) === 16
      ? `${start.slice(0, 7)}-01`
      : employeePeriod(addDays(start, -1));
  data.employees = [
    {
      id: DEMO_EMPLOYEE,
      profile_id: "sample-employee",
      name: "Alex Reyes",
      employee_code: "TG-0001",
      pin_configured: false,
      email: "alex@example.invalid",
      started_on: lastPeriod,
      ended_on: null,
      active: true,
    },
    {
      id: "a1000000-0000-4000-8000-000000000002",
      profile_id: null,
      name: "Sam Santos",
      employee_code: "TG-0002",
      pin_configured: false,
      email: "sam@example.invalid",
      started_on: lastPeriod,
      ended_on: null,
      active: true,
    },
  ];
  data.schedules = data.employees.map((e, i) => ({
    id: `schedule-${i}`,
    employee_id: e.id,
    effective_from: lastPeriod,
    weekdays: [1, 2, 3, 4, 5, 6],
  }));
  const workDays = Array.from({ length: 15 }, (_, i) =>
    addDays(lastPeriod, i),
  ).filter((d) => d <= payrollEnd(lastPeriod) && toDate(d).getUTCDay() !== 0);
  data.attendance = workDays.slice(0, 3).map((d, i) => ({
    id: `att-${i}`,
    employee_id: DEMO_EMPLOYEE,
    work_date: d,
    clock_in: new Date(
      `${d}T${i === 1 ? "16:00" : "15:30"}:00+08:00`,
    ).toISOString(),
    clock_out: new Date(
      new Date(`${d}T23:30:00+08:00`).valueOf() + (i === 2 ? 3600000 : 0),
    ).toISOString(),
    approved_ot_seconds: null,
    ot_reviewed: false,
    correction_reason: "",
  }));
  data.requests = [
    {
      id: "request-advance",
      employee_id: DEMO_EMPLOYEE,
      kind: "advance",
      start_date: null,
      end_date: null,
      amount_cents: 100000,
      reason: "Fictional salary advance example",
      status: "pending",
      paid_leave: null,
      decision_note: "",
      created_at: new Date().toISOString(),
    },
    {
      id: "request-sick",
      employee_id: DEMO_EMPLOYEE,
      kind: "sick",
      start_date: workDays[3],
      end_date: workDays[3],
      amount_cents: null,
      reason: "Fictional sick leave example",
      status: "pending",
      paid_leave: null,
      decision_note: "",
      created_at: new Date().toISOString(),
    },
  ];
  data.qr = { id: "demo-court-qr" };
  return data;
}
