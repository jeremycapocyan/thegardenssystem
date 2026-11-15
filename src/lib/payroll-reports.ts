import type { Payroll, TeamData } from "./team";
export interface PayrollReportData {
  id: string;
  employee: { id: string; name: string; employee_code: string; email: string };
  statement: Payroll;
  payments: { paid_on: string; amount_cents: number; reference: string }[];
  paid_cents: number;
  balance_cents: number;
  payment_status: "Paid" | "Partially paid" | "Unpaid";
  generated_at: string;
  prepared_by: string;
}
export interface ReportDelivery {
  id: string;
  recipient: string;
  status: "reserved" | "sending" | "sent" | "failed" | "unconfirmed";
  created_at: string;
  updated_at: string;
  error_code: string | null;
}
export interface PayrollReportVersion {
  id: string;
  payroll_id: string;
  created_at: string;
  state: "creating" | "ready";
  can_retry?: boolean;
  recipient: string;
  payment_status: string;
  paid_cents: number;
  balance_cents: number;
  deliveries: ReportDelivery[];
}
export const reportFileName = (r: PayrollReportData) =>
  `The-Gardens-Payroll-${r.employee.employee_code}-${r.statement.period_start}-${r.statement.period_end}-${r.id.slice(0, 8)}.pdf`;
export function demoPayrollReport(
  data: TeamData,
  payrollId: string,
  id: string,
  now = new Date(),
): PayrollReportData {
  const p = data.payroll.find((p) => p.id === payrollId);
  if (!p) throw Error("Finalize payroll before generating this report.");
  const e = data.employees.find((e) => e.id === p.employee_id)!;
  const payments = data.cash
    .filter((c) => c.kind === "salary" && c.payroll_id === p.id)
    .map((c) => ({
      paid_on: c.paid_on,
      amount_cents: c.amount_cents,
      reference: c.reference,
    }));
  const paid = payments.reduce((s, c) => s + c.amount_cents, 0);
  return structuredClone({
    id,
    employee: {
      id: e.id,
      name: e.name,
      employee_code: e.employee_code || "SAMPLE",
      email: e.email,
    },
    statement: p,
    payments,
    paid_cents: paid,
    balance_cents: p.payable_cents - paid,
    payment_status:
      paid >= p.payable_cents ? "Paid" : paid > 0 ? "Partially paid" : "Unpaid",
    generated_at: now.toISOString(),
    prepared_by: "Jeremy (sample workspace)",
  });
}
