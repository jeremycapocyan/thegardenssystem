"use client";
import { useEffect, useRef, useState } from "react";
import { Download, FileText, LoaderCircle, X } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { canViewFinance } from "@/lib/access";
import { getBackend } from "@/lib/backend";
import { money, periodRange } from "@/lib/finance";
import { demoRoi, type RoiData } from "@/lib/roi";
import {
  buildFinanceReport,
  financeReportFileName,
  validateFinanceReportRange,
  type FinanceReport,
  type FinanceReportOptions,
  type FinanceReportSource,
} from "@/lib/finance-report";

export function FinanceReportDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace(),
    dialog = useRef<HTMLDialogElement>(null),
    running = useRef(false),
    mounted = useRef(true),
    urlRef = useRef("");
  const initial = periodRange(ws.period, ws.reference);
  const [view, setView] = useState<FinanceReportOptions["period"]>(ws.period),
    [reference, setReference] = useState(ws.reference),
    [start, setStart] = useState(initial.start),
    [end, setEnd] = useState(initial.end),
    [asOf, setAsOf] = useState(ws.asOf);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ready, setReady] = useState<{
      report: FinanceReport;
      url: string;
      pages: number;
    } | null>(null);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);
  function clear() {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
    setReady(null);
    setError("");
  }
  function period(next: FinanceReportOptions["period"], date = reference) {
    setView(next);
    setReference(date);
    clear();
    if (next !== "custom" && date) {
      const r = periodRange(next, date);
      setStart(r.start);
      setEnd(r.end);
    }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    clear();
    try {
      if (!canViewFinance(ws.profile))
        throw Error("Finance viewing permission is required.");
      const options = { start, end, asOf, period: view };
      validateFinanceReportRange(options);
      let source: FinanceReportSource;
      if (ws.mode === "demo") {
        let roi: RoiData = demoRoi();
        const saved = JSON.parse(
          localStorage.getItem("gardens.roi.sample.v1") || "null",
        );
        if (
          saved &&
          Array.isArray(saved.capital) &&
          Array.isArray(saved.exclusions)
        )
          roi = saved;
        source = {
          finance: structuredClone(ws.data),
          roi: structuredClone(roi),
          generated_at: new Date().toISOString(),
          prepared_by: ws.profile?.display_name || "Sample workspace",
        };
        const savedBalances = JSON.parse(
          localStorage.getItem("gardens.balances.sample.v1") || "null",
        );
        if (
          savedBalances &&
          Array.isArray(savedBalances.allocations) &&
          Array.isArray(savedBalances.movements)
        )
          source.balances = savedBalances;
      } else {
        if (ws.mode !== "live" || !navigator.onLine)
          throw Error(
            "Connect to the shared workspace before generating a live report.",
          );
        const api = getBackend()!,
          auth = await api.auth.getUser();
        if (auth.error || !auth.data.user)
          throw Error("Sign in again before generating a report.");
        const result = await api.rpc("garden_finance_report_snapshot");
        if (result.error)
          throw Error(
            result.error.code === "42501"
              ? "Finance viewing permission is required."
              : "Unable to load a fresh finance report. Check the connection and try again.",
          );
        source = result.data;
      }
      const report = buildFinanceReport(source, options, ws.mode === "demo");
      const [{ createFinanceReportPdf }, assets, { PDFDocument }] =
        await Promise.all([
          import("@/lib/finance-report-pdf"),
          Promise.all(
            [
              "/fonts/NotoSerif-Regular.ttf",
              "/fonts/NotoSerif-Bold.ttf",
              "/brand/gardens-crest.jpg",
              "/brand/gardens-wordmark.png",
            ].map(async (path) => {
              const response = await fetch(path);
              if (!response.ok)
                throw Error(
                  "The branded PDF assets could not be loaded. Retry.",
                );
              return new Uint8Array(await response.arrayBuffer());
            }),
          ),
          import("pdf-lib"),
        ]);
      const bytes = await createFinanceReportPdf(report, {
        regular: assets[0],
        bold: assets[1],
        crest: assets[2],
        wordmark: assets[3],
      });
      const pages = (await PDFDocument.load(bytes)).getPageCount();
      if (mounted.current) {
        const url = URL.createObjectURL(
          new Blob([new Uint8Array(bytes).buffer], { type: "application/pdf" }),
        );
        urlRef.current = url;
        setReady({ report, url, pages });
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "The finance report could not be generated.",
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="record-dialog finance-report-dialog"
      aria-labelledby="finance-report-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">THE GARDENS · FINANCE</span>
          <h2 id="finance-report-title">Generate PDF report</h2>
          <p>A complete report with summaries and supporting records.</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close finance report"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <form onSubmit={(event) => void generate(event)}>
        <fieldset disabled={busy} className="finance-report-fields">
          <legend className="sr-only">Finance report dates</legend>
          <label className="field">
            <span>Reporting period</span>
            <select
              value={view}
              onChange={(e) =>
                period(e.target.value as FinanceReportOptions["period"])
              }
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly · Monday to Sunday</option>
              <option value="monthly">Calendar month</option>
              <option value="custom">Custom dates · up to 366 days</option>
            </select>
          </label>
          {view !== "custom" && (
            <label className="field">
              <span>Reference date</span>
              <input
                type="date"
                required
                value={reference}
                onChange={(e) => period(view, e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span>Report start</span>
            <input
              type="date"
              required
              value={start}
              readOnly={view !== "custom"}
              onChange={(e) => {
                setStart(e.target.value);
                clear();
              }}
            />
          </label>
          <label className="field">
            <span>Report end</span>
            <input
              type="date"
              required
              value={end}
              readOnly={view !== "custom"}
              onChange={(e) => {
                setEnd(e.target.value);
                clear();
              }}
            />
          </label>
          <label className="field">
            <span>Balances as of</span>
            <input
              type="date"
              required
              value={asOf}
              onChange={(e) => {
                setAsOf(e.target.value);
                clear();
              }}
            />
          </label>
        </fieldset>
        <div className="finance-report-coverage">
          <strong>Included in the PDF</strong>
          <p>
            Income, expenses, net income, owner shares, charts, category totals,
            daily cash movement, complete income and payment ledgers, fixed
            bills, installments, owner settlements, capital and ROI.
          </p>
          <p>
            All categories are included. Screen search and category filters do
            not limit this report. Bill, installment, ROI and settlement payment
            balances use the as-of date.
          </p>
          <p>
            Monthly owner entitlements use each entire calendar month. Linked
            wages are included once as cash expenses; private HR and payslip
            records are excluded.
          </p>
        </div>
        {ws.mode === "demo" && (
          <p className="setup-note">
            Fictional sample workspace. No live transactions are created or
            changed.
          </p>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {ready && (
          <section
            className="finance-report-ready"
            aria-label="Finance PDF ready"
            role="status"
          >
            <strong>Your {ready.pages}-page PDF is ready</strong>
            <p>
              {ready.report.options.start} to {ready.report.options.end} · All
              amounts in Philippine pesos
            </p>
            <div className="finance-report-totals">
              <span>
                Income <b>{money(ready.report.cash.income)}</b>
              </span>
              <span>
                Expenses <b>{money(ready.report.cash.expense)}</b>
              </span>
              <span>
                Net income <b>{money(ready.report.cash.net)}</b>
              </span>
            </div>
            <div className="finance-report-links">
              <a
                className="button primary"
                href={ready.url}
                download={financeReportFileName(ready.report)}
              >
                <Download size={16} />
                Download PDF
              </a>
              <a
                className="button secondary"
                href={ready.url}
                target="_blank"
                rel="noreferrer"
              >
                <FileText size={16} />
                Open PDF preview
              </a>
            </div>
            {ready.report.warnings.length > 0 && (
              <p>
                {ready.report.warnings.length} item(s) to review are listed at
                the end of the PDF. Every recorded transaction remains included.
              </p>
            )}
          </section>
        )}
        <div className="dialog-footer">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={busy || !canViewFinance(ws.profile)}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <FileText size={16} />
            )}{" "}
            {busy
              ? "Generating report…"
              : ready
                ? "Generate fresh version"
                : "Generate report"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
