"use client";
import { useEffect, useState } from "react";
import { Download, FileText } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { getBackend } from "@/lib/backend";
import { displayDate, money, monthStart, monthEnd } from "@/lib/finance";
import {
  employeePeriod,
  payrollEnd,
  timeInManila,
  type TeamData,
} from "@/lib/team";
import {
  clockDuration,
  manilaDate,
  demoTimesheetReport,
  validateTimesheetRange,
  type TimesheetReport,
} from "@/lib/timesheets";
export function TimesheetsPanel({
  data,
  period,
  employeeId,
}: {
  data: TeamData;
  period: string;
  employeeId: string;
}) {
  const ws = useWorkspace(),
    [employee, setEmployee] = useState(employeeId || ""),
    [preset, setPreset] = useState("payroll"),
    [reference, setReference] = useState(period);
  const [from, setFrom] = useState(period),
    [to, setTo] = useState(payrollEnd(period)),
    [report, setReport] = useState<TimesheetReport | null>(null);
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const start =
      preset === "custom"
        ? from
        : preset === "month"
          ? monthStart(reference)
          : employeePeriod(reference),
    end =
      preset === "custom"
        ? to
        : preset === "month"
          ? monthEnd(reference)
          : payrollEnd(employeePeriod(reference));
  useEffect(() => {
    let active = true;
    setReport(null);
    setLoading(true);
    setError("");
    (async () => {
      try {
        validateTimesheetRange(start, end);
        let result: TimesheetReport;
        if (ws.mode === "demo")
          result = demoTimesheetReport(data, start, end, employee || null);
        else {
          const response = await getBackend()!.rpc("garden_timesheet_report", {
            p_start: start,
            p_end: end,
            p_employee: employee || null,
          });
          if (response.error)
            throw Error(
              "Unable to load the timesheet. Check your staff management access and refresh.",
            );
          result = response.data;
        }
        if (active) setReport(result);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Unable to load the timesheet.",
          );
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [start, end, employee, data, ws.mode]);
  async function exportPdf() {
    if (!report) return;
    setBusy(true);
    setError("");
    try {
      let blob: Blob;
      if (ws.mode === "demo") {
        const [{ createTimesheetPdf }, assets] = await Promise.all([
          import("@/lib/timesheet-pdf"),
          Promise.all(
            [
              "/fonts/NotoSerif-Regular.ttf",
              "/fonts/NotoSerif-Bold.ttf",
              "/brand/gardens-crest.jpg",
              "/brand/gardens-wordmark.png",
            ].map(async (url) => {
              const result = await fetch(url);
              if (!result.ok)
                throw Error("Unable to load the PDF branding assets.");
              return new Uint8Array(await result.arrayBuffer());
            }),
          ),
        ]);
        const bytes = await createTimesheetPdf(report, {
          regular: assets[0],
          bold: assets[1],
          crest: assets[2],
          wordmark: assets[3],
        });
        blob = new Blob([new Uint8Array(bytes).buffer], {
          type: "application/pdf",
        });
      } else {
        const session = await getBackend()!.auth.getSession(),
          query = new URLSearchParams({ start, end });
        if (employee) query.set("employee", employee);
        const response = await fetch(`/api/team/timesheets/?${query}`, {
          headers: {
            Authorization: `Bearer ${session.data.session?.access_token || ""}`,
          },
          cache: "no-store",
        });
        if (!response.ok) {
          const message = await response.json();
          throw Error(message.message || "The PDF could not be generated.");
        }
        blob = await response.blob();
      }
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `The-Gardens-Timesheet-${start}-${end}${ws.mode === "demo" ? "-SAMPLE" : ""}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The PDF could not be exported.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="timesheets-panel">
      <section className="panel timesheet-filters">
        <div className="panel-heading">
          <div>
            <h2>Timesheets</h2>
            <p>
              Attendance and earnings - exporting does not finalize payroll or
              record a payment.
            </p>
          </div>
          <button
            className="button primary"
            disabled={busy || loading || !report}
            onClick={() => void exportPdf()}
          >
            <Download size={16} />
            {busy ? "Preparing PDF…" : "Export timesheet PDF"}
          </button>
        </div>
        <div className="form-grid">
          <label className="field">
            <span>Employees</span>
            <select
              value={employee}
              onChange={(e) => setEmployee(e.target.value)}
              aria-label="Timesheet employee"
            >
              <option value="">All employees</option>
              {data.employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {!e.active ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Reporting period</span>
            <select
              value={preset}
              onChange={(e) => {
                setFrom(start);
                setTo(end);
                setPreset(e.target.value);
              }}
            >
              <option value="payroll">Semi-monthly payroll period</option>
              <option value="month">Calendar month</option>
              <option value="custom">Custom dates (up to 31 days)</option>
            </select>
          </label>
          {preset === "custom" ? (
            <>
              <label className="field">
                <span>Timesheet start date</span>
                <input
                  type="date"
                  value={from}
                  onInput={(e) => setFrom(e.currentTarget.value)}
                  onChange={(e) => setFrom(e.target.value)}
                  required
                />
              </label>
              <label className="field">
                <span>Timesheet end date</span>
                <input
                  type="date"
                  value={to}
                  onInput={(e) => setTo(e.currentTarget.value)}
                  onChange={(e) => setTo(e.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <label className="field">
              <span>Timesheet reference date</span>
              <input
                type="date"
                value={reference}
                onInput={(e) => {
                  if (e.currentTarget.value)
                    setReference(e.currentTarget.value);
                }}
                onChange={(e) => {
                  if (e.target.value) setReference(e.target.value);
                }}
              />
            </label>
          )}
        </div>
      </section>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <p className="empty-inline">Preparing the timesheet figures…</p>
      )}
      {report && (
        <>
          <p className="roi-note">
            <FileText size={15} /> {displayDate(start)} to {displayDate(end)} ·{" "}
            {report.employees.length} employee(s) · Times displayed in
            Asia/Manila. Draft figures may change; finalized figures use locked
            payroll snapshots.
          </p>
          {!report.employees.length && (
            <section className="panel staff-welcome">
              <p>No employees were employed during these reporting dates.</p>
            </section>
          )}
          {report.employees.map((e) => (
            <section className="panel" key={e.id}>
              <div className="panel-heading">
                <div>
                  <h2>
                    {e.name} · {e.employee_code}
                  </h2>
                  <p>
                    {e.periods.every((p) => p.finalized)
                      ? "Finalized payroll figures"
                      : e.periods.some((p) => p.finalized)
                        ? "Mixed finalized and draft periods"
                        : "Draft attendance and earnings"}
                  </p>
                </div>
                <strong>{money(e.totals.gross_cents)} gross earned</strong>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Work date</th>
                      <th>Scheduled shift</th>
                      <th>Time in</th>
                      <th>Time out</th>
                      <th>Recorded time</th>
                      <th>Late</th>
                      <th>Undertime</th>
                      <th>Recorded OT</th>
                      <th>Approved OT</th>
                      <th>Status</th>
                      <th>Gross earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.days.map((d) => (
                      <tr key={d.date}>
                        <td>{displayDate(d.date)}</td>
                        <td>{d.scheduled_shift}</td>
                        {[d.clock_in, d.clock_out].map((stamp, i) => (
                          <td key={i}>
                            {stamp && manilaDate(stamp) !== d.date && (
                              <small className="account-block">
                                {displayDate(manilaDate(stamp))}
                              </small>
                            )}
                            {timeInManila(stamp)}
                          </td>
                        ))}
                        <td>
                          {d.clock_in && !d.clock_out
                            ? "Open / missing time out"
                            : d.recorded_seconds === null
                              ? "—"
                              : clockDuration(d.recorded_seconds)}
                        </td>
                        <td>{clockDuration(d.late_seconds)}</td>
                        <td>{clockDuration(d.undertime_seconds)}</td>
                        <td>{clockDuration(d.overtime_seconds)}</td>
                        <td>
                          {clockDuration(d.approved_ot_seconds)}
                          {d.overtime_seconds > 0 && !d.ot_reviewed && (
                            <small className="account-block">
                              Pending review
                            </small>
                          )}
                        </td>
                        <td>
                          {d.status}
                          {!d.finalized && (
                            <small className="account-block">Draft</small>
                          )}
                        </td>
                        <td>{money(d.total_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details className="roi-monthly">
                <summary>Daily earnings breakdown</summary>
                <p>
                  Regular earnings already include missed-time deductions. Gross
                  earnings add approved overtime and paid leave.
                </p>
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Regular earned</th>
                        <th>Missed deduction (already applied)</th>
                        <th>Approved OT pay</th>
                        <th>Paid leave</th>
                        <th>Gross earned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.days.map((d) => (
                        <tr key={d.date}>
                          <td>{displayDate(d.date)}</td>
                          <td>{money(d.regular_cents)}</td>
                          <td>{money(d.deduction_cents)}</td>
                          <td>{money(d.ot_cents)}</td>
                          <td>{money(d.leave_cents)}</td>
                          <td>{money(d.total_cents)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
              <div className="roi-reconciliation">
                <span>
                  Regular earned<strong>{money(e.totals.regular_cents)}</strong>
                </span>
                <span>
                  Missed deduction (already applied)
                  <strong>{money(e.totals.deduction_cents)}</strong>
                </span>
                <span>
                  Approved OT pay<strong>{money(e.totals.ot_cents)}</strong>
                </span>
                <span>
                  Paid leave<strong>{money(e.totals.leave_cents)}</strong>
                </span>
              </div>
              {e.warnings.length > 0 && (
                <details className="roi-monthly">
                  <summary>
                    {e.warnings.length} item(s) need review before payroll
                    finalization
                  </summary>
                  <ul>
                    {e.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
