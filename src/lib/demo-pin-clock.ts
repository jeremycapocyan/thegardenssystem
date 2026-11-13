import { DEMO_EMPLOYEE, type TeamData } from "./team";
import { normalizeEmployeeCode } from "./attendance-input";
import { manilaDate } from "./timesheets";
export interface DemoPinEvent {
  nonce: string;
  action: "clock_in" | "clock_out";
  at: string;
  name: string;
}
export function demoPinPunch(
  data: TeamData,
  events: DemoPinEvent[],
  code: string,
  pin: string,
  action: "clock_in" | "clock_out",
  nonce: string,
  now = new Date(),
) {
  if (normalizeEmployeeCode(code) !== "TG-0001" || pin !== "123456")
    throw Error("Sample credentials are TG-0001 and 123456.");
  if (data.qr?.id !== "demo-court-qr")
    throw Error(
      "The sample QR was replaced. Restore the samples to use this example.",
    );
  const employee = data.employees.find((e) => e.id === DEMO_EMPLOYEE);
  if (!employee?.active) throw Error("The sample employee is inactive.");
  const prior = events.find((e) => e.nonce === nonce && e.action === action);
  if (prior) return { data, events, result: prior };
  const next = structuredClone(data),
    open = next.attendance.find(
      (a) => a.employee_id === DEMO_EMPLOYEE && !a.clock_out && !a.voided,
    ),
    today = manilaDate(now.toISOString());
  if (action === "clock_in") {
    if (open) throw Error("You are already timed in.");
    if (
      next.attendance.some(
        (a) =>
          a.employee_id === DEMO_EMPLOYEE && a.work_date === today && !a.voided,
      )
    )
      throw Error(
        "Attendance is already recorded for today. Ask the manager to review it.",
      );
    if (
      today < employee.started_on ||
      (employee.ended_on && today > employee.ended_on)
    )
      throw Error("This date is outside the sample employment dates.");
    if (
      next.payroll.some(
        (p) =>
          p.employee_id === employee.id &&
          today >= p.period_start &&
          today <= p.period_end,
      )
    )
      throw Error("This sample payroll period is finalized.");
    next.attendance.push({
      id: nonce,
      employee_id: employee.id,
      work_date: today,
      clock_in: now.toISOString(),
      clock_out: null,
      approved_ot_seconds: null,
      ot_reviewed: false,
      correction_reason: "",
    });
  } else {
    if (!open) throw Error("You have no open time-in.");
    if (now.valueOf() - new Date(open.clock_in).valueOf() < 60000)
      throw Error(
        "Time in was just recorded. Wait one minute before timing out.",
      );
    open.clock_out = now.toISOString();
  }
  const result = { nonce, action, at: now.toISOString(), name: employee.name };
  return { data: next, events: [...events, result], result };
}
