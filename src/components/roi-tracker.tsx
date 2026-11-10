"use client";
import { useRef, useEffect, useState, type FormEvent } from "react";
import { Plus, Download, RefreshCw, TrendingUp, X } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { useRoi } from "./use-roi";
import { canManage } from "@/lib/access";
import {
  money,
  parseMoney,
  displayDate,
  displayMonth,
  csv,
  todayInManila,
  toDate,
} from "@/lib/finance";
import {
  roiSummary,
  roiTrend,
  type Capital,
  type CapitalExclusion,
} from "@/lib/roi";
import { OWNERS, type Owner } from "@/lib/types";

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <section className="stat">
      <span className="stat-top">{label}</span>
      <strong>{value}</strong>
      <span className="stat-note">{note}</span>
    </section>
  );
}
function RoiChart({ points }: { points: ReturnType<typeof roiTrend> }) {
  if (!points.length)
    return (
      <p className="empty-inline">
        Add a capital contribution to start your recovery chart.
      </p>
    );
  const width = 900,
    height = 280,
    left = 70,
    right = 25,
    top = 20,
    bottom = 40;
  const max = Math.max(
      10000,
      ...points.flatMap((p) => [p.invested, p.returned]),
    ),
    min = Math.min(0, ...points.map((p) => p.returned));
  const x = (i: number) =>
      points.length === 1
        ? width / 2
        : left + (i * (width - left - right)) / (points.length - 1),
    y = (v: number) =>
      top + ((max - v) / (max - min)) * (height - top - bottom);
  const line = (key: "invested" | "returned") =>
    points.map((p, i) => `${x(i)},${y(p[key])}`).join(" ");
  return (
    <div className="roi-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Cumulative capital and cash return toward recovery by month"
      >
        <title>Capital invested compared with cumulative cash return</title>
        {Array.from({ length: 5 }, (_, i) => {
          const value = max - ((max - min) * i) / 4;
          return (
            <g key={i}>
              <line
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--line)"
                strokeDasharray="3 5"
              />
              <text
                x={left - 10}
                y={y(value) + 4}
                textAnchor="end"
                className="chart-tick"
              >
                {new Intl.NumberFormat("en-PH", {
                  notation: "compact",
                  maximumFractionDigits: 1,
                }).format(value / 100)}
              </text>
            </g>
          );
        })}
        <text x={left} y={11} className="chart-tick">
          PHP
        </text>
        <polyline
          points={line("invested")}
          fill="none"
          stroke="var(--gold)"
          strokeWidth="3"
          strokeDasharray="7 4"
        />
        <polyline
          points={line("returned")}
          fill="none"
          stroke="var(--burgundy)"
          strokeWidth="3"
        />
        {points.map((p, i) => (
          <g key={p.month}>
            <circle cx={x(i)} cy={y(p.returned)} r="4" fill="var(--burgundy)">
              <title>
                {displayMonth(p.month)}: capital {money(p.invested)}, return{" "}
                {money(p.returned)}
              </title>
            </circle>
            <circle cx={x(i)} cy={y(p.invested)} r="3" fill="var(--gold)" />
            {(i % 2 === 0 || i === points.length - 1) && (
              <text
                x={x(i)}
                y={height - 12}
                textAnchor="middle"
                className="chart-tick"
              >
                {p.month.slice(2)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="roi-legend">
        <span>
          <i style={{ background: "var(--gold)" }} />
          Capital invested
        </span>
        <span>
          <i style={{ background: "var(--burgundy)" }} />
          Cash return toward recovery
        </span>
      </div>
    </div>
  );
}
type Editor =
  | { kind: "capital"; record?: Capital }
  | { kind: "exclusions"; record?: CapitalExclusion };
export function RoiTracker() {
  const ws = useWorkspace(),
    roi = useRoi(),
    admin = canManage(ws.profile, "finance");
  const [asOf, setAsOf] = useState(ws.asOf),
    [editor, setEditor] = useState<Editor | null>(null),
    [deleting, setDeleting] = useState<{
      kind: "capital" | "exclusions";
      id: string;
    } | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const report = roiSummary(ws.data, roi.data, asOf),
    points = roiTrend(ws.data, roi.data, asOf);
  const shownCapital = roi.data.capital
    .filter((c) => c.invested_on <= asOf)
    .sort((a, b) => b.invested_on.localeCompare(a.invested_on));
  const percent = (value: number | null) =>
    value === null ? "—" : `${value.toFixed(2)}%`;
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      await roi.remove(deleting.kind, deleting.id);
      setDeleting(null);
      setNotice(
        "ROI record removed. Business income and expenses are unchanged.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to remove record.");
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const rows: (string | number)[][] = [
      ["The Gardens · Cash ROI report"],
      ["As of", asOf],
      ["Tracking starts", report.start || "No capital recorded"],
      ["Capital invested", report.invested / 100],
      ["Income", report.income / 100],
      ["Actual expenses", report.expense / 100],
      ["Cash net income", report.net / 100],
      ["Marked capital purchases added back", report.capitalCosts / 100],
      ["Cash return toward recovery", report.returned / 100],
      ["Business cash ROI (%)", report.percent ?? ""],
      ["Capital still to recover", report.remaining / 100],
      [],
      [
        "Owner",
        "Capital contributed",
        "Actual payouts received",
        "Capital still to recover",
        "Cash recovered (%)",
      ],
      ...report.owners.map((o) => [
        o.owner,
        o.contribution / 100,
        o.paid / 100,
        o.remaining / 100,
        o.percent ?? "",
      ]),
      [],
      ["Date", "Owner", "Contribution", "Reference", "Notes"],
      ...shownCapital.map((c) => [
        c.invested_on,
        c.owner,
        c.amount_cents / 100,
        c.reference,
        c.notes,
      ]),
      [],
      ["Month", "Cumulative capital", "Cumulative cash return"],
      ...points.map((p) => [p.month, p.invested / 100, p.returned / 100]),
    ];
    const url = URL.createObjectURL(
      new Blob([csv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `The-Gardens-ROI-${asOf}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="roi-tracker">
      <section
        className="period-bar roi-controls"
        aria-label="ROI reporting controls"
      >
        <label className="date-control">
          <span>As of</span>
          <input
            type="date"
            aria-label="ROI as-of date"
            value={asOf}
            onChange={(e) => {
              if (e.target.value) setAsOf(e.target.value);
            }}
          />
        </label>
        <span className="muted">
          {report.start
            ? `Cumulative since ${displayDate(report.start)}`
            : "Record the original contribution date to begin."}
        </span>
        <div className="account-actions">
          <button
            className="button secondary"
            onClick={() => void roi.refresh()}
            disabled={roi.loading}
          >
            <RefreshCw size={15} />
            Refresh ROI
          </button>
          <button
            className="button secondary"
            onClick={download}
            disabled={roi.loading}
          >
            <Download size={15} />
            Export ROI CSV
          </button>
          {admin && (
            <button
              className="button primary"
              onClick={() => {
                setError("");
                setEditor({ kind: "capital" });
              }}
            >
              <Plus size={16} />
              Record capital
            </button>
          )}
        </div>
      </section>
      {(error || roi.error) && (
        <div className="error-box" role="alert">
          {error || roi.error}
        </div>
      )}
      {notice && (
        <p className="setup-note" role="status">
          {notice}
        </p>
      )}
      {!report.start && (
        <section className="panel roi-empty">
          <TrendingUp size={30} />
          <h2>Start with your capital investment.</h2>
          <p>
            Record what Genesis, Ken, and Jeremy actually contributed, including
            any additional capital. Contributions do not create income or
            expense entries.
          </p>
          {!admin && (
            <p>A finance administrator can enter the initial capital.</p>
          )}
        </section>
      )}
      <div className="roi-metrics">
        <Metric
          label="Total capital invested"
          value={money(report.invested)}
          note="Actual contributions through the selected date"
        />
        <Metric
          label="Cash return toward recovery"
          value={money(report.returned)}
          note="Cash net income plus marked capital purchases"
        />
        <Metric
          label="Business cash ROI"
          value={percent(report.percent)}
          note="Cumulative cash return ÷ capital invested"
        />
        <Metric
          label="Capital still to recover"
          value={report.start ? money(report.remaining) : "—"}
          note={
            report.surplus
              ? `${money(report.surplus)} beyond the recorded capital`
              : report.returned < 0
                ? "Losses increase the amount still to recover"
                : "100% cash ROI means capital-equivalent cash earned"
          }
        />
      </div>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Capital recovery over time</h2>
            <p>
              Latest 12 months · each point includes all earlier records from
              the first contribution.
            </p>
          </div>
        </div>
        <RoiChart points={points} />
        {!!points.length && (
          <details className="roi-monthly">
            <summary>View monthly figures</summary>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Month ending</th>
                    <th>Cumulative capital</th>
                    <th>Cumulative cash return</th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p) => (
                    <tr key={p.month}>
                      <td>{displayDate(p.date)}</td>
                      <td>{money(p.invested)}</td>
                      <td>{money(p.returned)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Owner cash recovery</h2>
            <p>
              Actual payouts received, compared with each owner’s actual
              contributions. Funding is not assumed to follow the 40% / 40% /
              20% profit split.
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Owner</th>
                <th>Capital contributed</th>
                <th>Actual payouts received</th>
                <th>Cash recovered</th>
                <th>Still to recover</th>
              </tr>
            </thead>
            <tbody>
              {report.owners.map((o) => (
                <tr key={o.owner}>
                  <td>
                    <strong>{o.owner}</strong>
                  </td>
                  <td>{money(o.contribution)}</td>
                  <td>{money(o.paid)}</td>
                  <td>
                    {percent(o.percent)}
                    <progress
                      max="100"
                      value={Math.min(100, Math.max(0, o.percent || 0))}
                      aria-label={`${o.owner} capital recovery`}
                    />
                  </td>
                  <td>
                    {o.contribution > 0 ? money(o.remaining) : "—"}
                    {o.contribution === 0 && o.paid > 0 && (
                      <small className="account-block">
                        Record this owner’s capital to measure recovery.
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="roi-note">
          Owner payouts use their actual payment dates, even if they settle an
          earlier month. They do not reduce business cash ROI. These ratios
          track cash recovery, not the value of your ownership or assets.
        </p>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Capital contributions</h2>
            <p>
              Initial investment and additional funding · {shownCapital.length}{" "}
              entries through {displayDate(asOf)}
            </p>
          </div>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Owner</th>
                <th>Amount</th>
                <th>Reference / notes</th>
                {admin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {shownCapital.map((c) => (
                <tr key={c.id}>
                  <td>{displayDate(c.invested_on)}</td>
                  <td>{c.owner}</td>
                  <td>{money(c.amount_cents)}</td>
                  <td>
                    {c.reference || "—"}
                    <small className="account-block">{c.notes}</small>
                  </td>
                  {admin && (
                    <td>
                      <div className="account-actions">
                        <button
                          className="text-button"
                          onClick={() =>
                            setEditor({ kind: "capital", record: c })
                          }
                        >
                          Edit capital
                        </button>
                        <button
                          className="text-button"
                          onClick={() =>
                            setDeleting({ kind: "capital", id: c.id })
                          }
                        >
                          Remove capital
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!shownCapital.length && (
            <p className="empty-inline">
              No capital contributions recorded for this date.
            </p>
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Setup costs already in Expenses</h2>
            <p>
              Mark existing capital purchases only when they are part of the
              investment being recovered.
            </p>
          </div>
          {admin && (
            <button
              className="button secondary compact"
              onClick={() => setEditor({ kind: "exclusions" })}
            >
              <Plus size={14} />
              Mark capital purchase
            </button>
          )}
        </div>
        <p className="roi-note">
          Marked purchases are added back for this ROI report only. The original
          Expenses, net income, owner shares, and payroll remain unchanged.
          Regular bills and wages remain operating costs.
        </p>
        <div className="roi-reconciliation">
          <span>
            Cash net income <strong>{money(report.net)}</strong>
          </span>
          <span>
            + marked capital purchases{" "}
            <strong>{money(report.capitalCosts)}</strong>
          </span>
          <span>
            = cash return toward recovery{" "}
            <strong>{money(report.returned)}</strong>
          </span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Payment</th>
                <th>Amount</th>
                <th>Reason</th>
                {admin && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {roi.data.exclusions.map((mark) => {
                const expense = ws.data.expenses.find(
                  (e) => e.id === mark.expense_id,
                );
                return (
                  <tr key={mark.id}>
                    <td>
                      {expense
                        ? displayDate(expense.paid_on)
                        : "Payment unavailable"}
                      <small className="account-block">
                        {expense?.reference || expense?.notes}
                      </small>
                    </td>
                    <td>{expense ? money(expense.amount_cents) : "—"}</td>
                    <td>{mark.reason}</td>
                    {admin && (
                      <td>
                        <button
                          className="text-button"
                          onClick={() =>
                            setDeleting({ kind: "exclusions", id: mark.id })
                          }
                        >
                          Remove mark
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!roi.data.exclusions.length && (
            <p className="empty-inline">
              No capital purchases marked. If setup costs were recorded
              separately, leave this section empty.
            </p>
          )}
        </div>
      </section>
      <p className="roi-note">
        Amounts use Philippine pesos. Returns include losses and actual payments
        from the earliest recorded capital contribution through the selected
        date. Capital and owner payouts are not business income. No opening
        balances or estimated returns are assumed.
      </p>
      {editor && (
        <RoiEditor
          key={editor.record?.id || editor.kind}
          editor={editor}
          onClose={() => setEditor(null)}
          onSave={async (row) => {
            await roi.save(editor.kind, row);
            setEditor(null);
            setNotice(
              "ROI record saved. Business income and expenses are unchanged.",
            );
          }}
        />
      )}
      {deleting && (
        <ConfirmRemoval
          busy={busy}
          onClose={() => setDeleting(null)}
          onRemove={() => void remove()}
        />
      )}
    </div>
  );
}
function RoiEditor({
  editor,
  onClose,
  onSave,
}: {
  editor: Editor;
  onClose: () => void;
  onSave: (row: Capital | CapitalExclusion) => Promise<void>;
}) {
  const ws = useWorkspace(),
    dialog = useRef<HTMLDialogElement>(null),
    [id] = useState(editor.record?.id || crypto.randomUUID()),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const capital = editor.kind === "capital" ? editor.record : undefined,
    mark = editor.kind === "exclusions" ? editor.record : undefined;
  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const form = new FormData(event.currentTarget),
        get = (key: string) => String(form.get(key) || "").trim();
      if (editor.kind === "capital") {
        toDate(get("invested_on"));
        if (get("invested_on") > todayInManila())
          throw Error("Record only capital already contributed.");
        const amount = parseMoney(get("amount"));
        if (amount <= 0) throw Error("Enter a contribution greater than zero.");
        if (!OWNERS.includes(get("owner") as Owner))
          throw Error("Choose an owner.");
        await onSave({
          id,
          invested_on: get("invested_on"),
          owner: get("owner") as Owner,
          amount_cents: amount,
          reference: get("reference"),
          notes: get("notes"),
        });
      } else {
        if (!get("expense_id") || !get("reason"))
          throw Error(
            "Choose an existing capital purchase and explain the adjustment.",
          );
        await onSave({
          id,
          expense_id: get("expense_id"),
          reason: get("reason"),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="record-dialog"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
      aria-labelledby="roi-editor-title"
    >
      <form onSubmit={submit}>
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">ROI TRACKER</span>
            <h2 id="roi-editor-title">
              {editor.kind === "capital"
                ? capital
                  ? "Edit capital contribution"
                  : "Record capital contribution"
                : "Mark an existing capital purchase"}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close ROI form"
          >
            <X size={20} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="form-grid">
            {editor.kind === "capital" ? (
              <>
                <label className="field">
                  <span>Contribution date</span>
                  <input
                    type="date"
                    name="invested_on"
                    required
                    max={todayInManila()}
                    defaultValue={capital?.invested_on || todayInManila()}
                  />
                </label>
                <label className="field">
                  <span>Owner</span>
                  <select
                    name="owner"
                    defaultValue={capital?.owner || "Genesis"}
                  >
                    {OWNERS.map((owner) => (
                      <option key={owner}>{owner}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Capital contributed (₱)</span>
                  <input
                    name="amount"
                    inputMode="decimal"
                    required
                    placeholder="0.00"
                    defaultValue={
                      capital ? (capital.amount_cents / 100).toFixed(2) : ""
                    }
                  />
                </label>
                <label className="field">
                  <span>Reference</span>
                  <input
                    name="reference"
                    maxLength={120}
                    defaultValue={capital?.reference}
                  />
                </label>
                <label className="field wide">
                  <span>Notes</span>
                  <textarea
                    name="notes"
                    maxLength={1000}
                    defaultValue={capital?.notes}
                  />
                </label>
                <p className="field wide">
                  Use the original contribution date for initial capital. This
                  records funding and creates no income or expense.
                </p>
              </>
            ) : (
              <>
                <label className="field wide">
                  <span>Existing expense payment</span>
                  <select
                    name="expense_id"
                    required
                    defaultValue={mark?.expense_id || ""}
                  >
                    <option value="">Choose a setup or capital purchase</option>
                    {ws.data.expenses
                      .filter((e) => !e.staff_payment_id)
                      .map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.paid_on} · {money(e.amount_cents)} ·{" "}
                          {e.reference ||
                            e.notes ||
                            ws.data.categories.find(
                              (c) => c.id === e.category_id,
                            )?.name ||
                            "Payment"}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field wide">
                  <span>Why is this part of the capital investment?</span>
                  <textarea
                    name="reason"
                    required
                    maxLength={1000}
                    defaultValue={mark?.reason}
                  />
                </label>
                <p className="field wide">
                  This adds the payment back in ROI only. It does not edit the
                  original expense or owner entitlements.
                </p>
              </>
            )}
          </div>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save ROI record"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function ConfirmRemoval({
  busy,
  onClose,
  onRemove,
}: {
  busy: boolean;
  onClose: () => void;
  onRemove: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="record-dialog roi-confirm"
      aria-labelledby="roi-remove-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="roi-remove-title">Remove this ROI record?</h2>
      </div>
      <div className="dialog-body">
        <p>
          Capital recovery figures will be recalculated. Income, expense
          payments, and owner payouts are unchanged.
        </p>
      </div>
      <div className="dialog-footer">
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Keep record
        </button>
        <button className="button danger" disabled={busy} onClick={onRemove}>
          Remove ROI record
        </button>
      </div>
    </dialog>
  );
}
