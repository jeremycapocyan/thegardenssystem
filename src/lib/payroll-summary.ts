import { payrollEnd, previewPayroll, type TeamData } from "./team";
export interface CutoffEmployee {
  employee_id: string;
  name: string;
  employee_code: string;
  active: boolean;
  finalized: boolean;
  blockers: string[];
  gross_cents: number;
  recovery_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
}
export interface CutoffTotals {
  gross_cents: number;
  recovery_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  finalized_payable_cents: number;
  finalized_count: number;
  draft_count: number;
}
export interface CutoffSummary {
  start: string;
  end: string;
  employees: CutoffEmployee[];
  totals: CutoffTotals;
}
export function sumCutoffEmployees(people: CutoffEmployee[]): CutoffTotals {
  const totals: CutoffTotals = {
    gross_cents: 0,
    recovery_cents: 0,
    payable_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
    finalized_payable_cents: 0,
    finalized_count: 0,
    draft_count: 0,
  };
  for (const e of people) {
    for (const key of [
      "gross_cents",
      "recovery_cents",
      "payable_cents",
      "paid_cents",
      "balance_cents",
    ] as const)
      totals[key] += e[key];
    if (e.finalized) {
      totals.finalized_count++;
      totals.finalized_payable_cents += e.payable_cents;
    } else totals.draft_count++;
  }
  return totals;
}
export function demoCutoffSummary(
  data: TeamData,
  start: string,
  now = new Date(),
): CutoffSummary {
  const end = payrollEnd(start, data.cutoff_rules);
  const employees = data.employees
    .filter(
      (e) =>
        (e.started_on <= end && (!e.ended_on || e.ended_on >= start)) ||
        data.payroll.some(
          (p) => p.employee_id === e.id && p.period_start === start,
        ),
    )
    .map((e) => {
      const frozen = data.payroll.find(
          (p) => p.employee_id === e.id && p.period_start === start,
        ),
        preview = frozen?.snapshot || previewPayroll(data, e.id, start, now);
      const gross = frozen?.gross_cents ?? preview.gross_cents,
        recovery = frozen?.recovery_cents ?? preview.recovery_cents;
      const paid = frozen
        ? data.cash
            .filter((c) => c.kind === "salary" && c.payroll_id === frozen.id)
            .reduce((s, c) => s + c.amount_cents, 0)
        : 0;
      return {
        employee_id: e.id,
        name: e.name,
        employee_code: e.employee_code || "",
        active: e.active,
        finalized: !!frozen,
        blockers: frozen ? [] : preview.blockers,
        gross_cents: gross,
        recovery_cents: recovery,
        payable_cents: gross - recovery,
        paid_cents: paid,
        balance_cents: gross - recovery - paid,
      };
    });
  return { start, end, employees, totals: sumCutoffEmployees(employees) };
}
