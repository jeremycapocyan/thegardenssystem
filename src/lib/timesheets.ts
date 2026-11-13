import { addMonths, monthStart, toDate } from "./finance";
import {
  employeePeriod,
  previewPayroll,
  payrollEnd,
  type TeamData,
  type PayrollDay,
} from "./team";
export interface TimesheetDay extends PayrollDay {
  finalized: boolean;
  scheduled_shift: string;
  recorded_seconds: number | null;
}
export interface TimesheetTotals {
  regular_cents: number;
  deduction_cents: number;
  ot_cents: number;
  leave_cents: number;
  gross_cents: number;
  recorded_seconds: number;
  late_seconds: number;
  undertime_seconds: number;
  overtime_seconds: number;
  approved_ot_seconds: number;
}
export interface TimesheetEmployee {
  id: string;
  name: string;
  employee_code: string;
  days: TimesheetDay[];
  periods: { start: string; end: string; finalized: boolean }[];
  warnings: string[];
  totals: TimesheetTotals;
}
export interface TimesheetReport {
  start: string;
  end: string;
  generated_at: string;
  prepared_by: string;
  employees: TimesheetEmployee[];
}
export function validateTimesheetRange(start: string, end: string) {
  const first = toDate(start),
    last = toDate(end),
    length = (last.valueOf() - first.valueOf()) / 86400000 + 1;
  if (length < 1 || length > 31 || start < "2000-01-01" || end > "2100-12-31")
    throw Error("Choose a valid date range of up to 31 days.");
}
export function sumTimesheetDays(days: TimesheetDay[]): TimesheetTotals {
  const sums: TimesheetTotals = {
    regular_cents: 0,
    deduction_cents: 0,
    ot_cents: 0,
    leave_cents: 0,
    gross_cents: 0,
    recorded_seconds: 0,
    late_seconds: 0,
    undertime_seconds: 0,
    overtime_seconds: 0,
    approved_ot_seconds: 0,
  };
  for (const day of days)
    for (const key of Object.keys(sums) as (keyof TimesheetTotals)[])
      sums[key] += Number(
        key === "gross_cents" ? day.total_cents : day[key] || 0,
      );
  return sums;
}
// Sample mode only. Live reports are assembled in one stable PostgreSQL snapshot.
export function demoTimesheetReport(
  data: TeamData,
  start: string,
  end: string,
  employeeId: string | null = null,
  now = new Date(),
): TimesheetReport {
  validateTimesheetRange(start, end);
  return {
    start,
    end,
    generated_at: now.toISOString(),
    prepared_by: "Jeremy (sample)",
    employees: data.employees
      .filter(
        (e) =>
          (!employeeId || e.id === employeeId) &&
          e.started_on <= end &&
          (!e.ended_on || e.ended_on >= start),
      )
      .map((e, index) => {
        const days: TimesheetDay[] = [],
          periods: TimesheetEmployee["periods"] = [],
          warnings: string[] = [];
        for (
          let cutoff = employeePeriod(start);
          cutoff <= end;
          cutoff = cutoff.endsWith("-01")
            ? `${cutoff.slice(0, 7)}-16`
            : addMonths(monthStart(cutoff), 1)
        ) {
          const frozen = data.payroll.find(
              (p) => p.employee_id === e.id && p.period_start === cutoff,
            ),
            snapshot =
              frozen?.snapshot || previewPayroll(data, e.id, cutoff, now);
          periods.push({
            start: cutoff,
            end: payrollEnd(cutoff),
            finalized: !!frozen,
          });
          for (const day of snapshot.days)
            if (
              day.date >= start &&
              day.date <= end &&
              day.date >= e.started_on &&
              (!e.ended_on || day.date <= e.ended_on)
            )
              days.push({
                ...day,
                finalized: !!frozen,
                scheduled_shift: day.scheduled ? "15:30 - 23:30" : "Rest day",
                recorded_seconds:
                  day.clock_in && day.clock_out
                    ? Math.max(
                        0,
                        (new Date(day.clock_out).valueOf() -
                          new Date(day.clock_in).valueOf()) /
                          1000,
                      )
                    : null,
              });
          if (!frozen)
            warnings.push(
              ...snapshot.blockers.filter(
                (b) =>
                  !/^\d{4}-\d{2}-\d{2}:/.test(b) ||
                  (b.slice(0, 10) >= start && b.slice(0, 10) <= end),
              ),
            );
        }
        return {
          id: e.id,
          name: e.name,
          employee_code:
            e.employee_code || `TG-${String(index + 1).padStart(4, "0")}`,
          days,
          periods,
          warnings,
          totals: sumTimesheetDays(days),
        };
      }),
  };
}
export const manilaDate = (stamp: string) =>
  new Date(new Date(stamp).valueOf() + 8 * 3600000).toISOString().slice(0, 10);
export function clockDuration(seconds: number | null) {
  if (seconds === null) return "Open";
  const n = Math.floor(seconds);
  return `${Math.floor(n / 3600)}:${String(Math.floor((n % 3600) / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}
