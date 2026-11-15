"use client";
import { useEffect, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { getBackend } from "@/lib/backend";
import { canManage } from "@/lib/access";
import { money, displayDate } from "@/lib/finance";
import { demoCutoffSummary, type CutoffSummary } from "@/lib/payroll-summary";
import type { TeamData } from "@/lib/team";
export function PayrollCutoffSummary({
  data,
  period,
  onEmployee,
}: {
  data: TeamData;
  period: string;
  onEmployee: (id: string) => void;
}) {
  const ws = useWorkspace(),
    [report, setReport] = useState<CutoffSummary | null>(null),
    [error, setError] = useState("");
  const allowed = canManage(ws.profile, "team");
  useEffect(() => {
    let active = true;
    setReport(null);
    setError("");
    if (!allowed) return;
    (async () => {
      try {
        let next: CutoffSummary;
        if (ws.mode === "demo") next = demoCutoffSummary(data, period);
        else {
          const result = await getBackend()!.rpc(
            "garden_payroll_cutoff_summary",
            { p_start: period },
          );
          if (result.error)
            throw Error(
              "Unable to load the cutoff total. Refresh the employee records.",
            );
          next = result.data;
        }
        if (active) setReport(next);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Unable to load payroll totals.",
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [data, period, allowed, ws.mode]);
  if (!allowed) return null;
  return (
    <section
      className="panel cutoff-summary"
      aria-label="All employee payroll total"
    >
      <div className="panel-heading">
        <div>
          <span className="eyebrow">HR ADMINS ONLY</span>
          <h2>Total payroll for this cutoff</h2>
          <p>
            {report
              ? `${displayDate(report.start)} - ${displayDate(report.end)}`
              : "Calculating all employee totals…"}
          </p>
        </div>
        {report && (
          <div className="cutoff-total">
            <span>Total salary payable</span>
            <strong>{money(report.totals.payable_cents)}</strong>
            <small>
              {report.totals.draft_count
                ? "Includes draft estimates"
                : "Finalized statements"}
            </small>
          </div>
        )}
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <div className="cutoff-metrics">
            {[
              ["Gross earnings", report.totals.gross_cents],
              ["Advance deductions", report.totals.recovery_cents],
              ["Actual salary paid", report.totals.paid_cents],
              ["Remaining balance", report.totals.balance_cents],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <span>{label}</span>
                <strong>{money(Number(value))}</strong>
              </div>
            ))}
          </div>
          <p className="cutoff-note">
            {report.employees.length} employees ·{" "}
            {report.totals.finalized_count} finalized ·{" "}
            {report.totals.draft_count} draft. Finalized salary payable:{" "}
            {money(report.totals.finalized_payable_cents)}. Draft earnings and
            advance deductions may change. Viewing this total does not finalize
            or pay salaries.
          </p>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Status</th>
                  <th>Gross earnings</th>
                  <th>Advance deduction</th>
                  <th>Salary payable</th>
                  <th>Paid</th>
                  <th>Remaining</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {report.employees.map((e) => (
                  <tr key={e.employee_id}>
                    <td>
                      <strong>{e.name}</strong>
                      <small className="account-block">
                        {e.employee_code}
                        {!e.active ? " · inactive" : ""}
                      </small>
                    </td>
                    <td>
                      <span
                        className={`badge ${e.finalized ? "success" : "warm"}`}
                      >
                        {e.finalized ? "Finalized" : "Draft"}
                      </span>
                      {e.blockers.length > 0 && (
                        <small className="account-block">
                          {e.blockers.length} items to review
                        </small>
                      )}
                    </td>
                    <td>{money(e.gross_cents)}</td>
                    <td>{money(e.recovery_cents)}</td>
                    <td>
                      <strong>{money(e.payable_cents)}</strong>
                    </td>
                    <td>{money(e.paid_cents)}</td>
                    <td>{money(e.balance_cents)}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => onEmployee(e.employee_id)}
                      >
                        View payroll
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2}>Cutoff total</th>
                  <td>{money(report.totals.gross_cents)}</td>
                  <td>{money(report.totals.recovery_cents)}</td>
                  <td>
                    <strong>{money(report.totals.payable_cents)}</strong>
                  </td>
                  <td>{money(report.totals.paid_cents)}</td>
                  <td>{money(report.totals.balance_cents)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {!report.employees.length && (
            <p className="cutoff-note">
              No employees were employed during this cutoff.
            </p>
          )}
        </>
      )}
    </section>
  );
}
