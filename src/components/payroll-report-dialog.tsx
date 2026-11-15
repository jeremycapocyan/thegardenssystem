"use client";
import { useEffect, useRef, useState } from "react";
import { X, Download, Mail, RefreshCw } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { staffFetch } from "@/lib/staff-client";
import {
  demoPayrollReport,
  type PayrollReportVersion,
  type PayrollReportData,
} from "@/lib/payroll-reports";
import type { TeamData } from "@/lib/team";
import { displayDate, money } from "@/lib/finance";
export function PayrollReportDialog({
  payrollId,
  data,
  onClose,
}: {
  payrollId: string;
  data: TeamData;
  onClose: () => void;
}) {
  const ws = useWorkspace(),
    dialog = useRef<HTMLDialogElement>(null),
    mounted = useRef(true),
    started = useRef(false),
    previewRequest = useRef(0),
    generation = useRef<string | null>(null),
    sendNonce = useRef(new Map<string, string>()),
    demoFiles = useRef(
      new Map<string, { data: PayrollReportData; bytes: Uint8Array }>(),
    ),
    urlRef = useRef("");
  const [history, setHistory] = useState<PayrollReportVersion[]>([]),
    [selected, setSelected] = useState<string>(""),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [reviewed, setReviewed] = useState(false),
    [ack, setAck] = useState(false),
    [mailReady, setMailReady] = useState(false);
  const version = history.find((r) => r.id === selected),
    previous = version?.deliveries || [],
    uncertain = previous.some((d) => d.status === "unconfirmed"),
    sent = previous.some((d) => d.status === "sent"),
    inProgress = previous.some((d) =>
      ["reserved", "sending"].includes(d.status),
    ),
    statement = data.payroll.find((p) => p.id === payrollId),
    employee = data.employees.find((e) => e.id === statement?.employee_id);
  async function loadHistory() {
    if (ws.mode === "demo") return;
    const r = await staffFetch(
      `/api/team/payroll-reports/?payroll_id=${payrollId}`,
    );
    if (!r.ok) throw Error("Unable to load report history.");
    const items = await r.json();
    if (mounted.current) setHistory(items);
    return items as PayrollReportVersion[];
  }
  async function preview(id: string) {
    const request = ++previewRequest.current;
    setError("");
    setReviewed(false);
    setAck(false);
    setSelected(id);
    setUrl("");
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = "";
    try {
      let blob: Blob;
      if (ws.mode === "demo") {
        const file = demoFiles.current.get(id);
        if (!file) throw Error("Generate a sample version first.");
        blob = new Blob([new Uint8Array(file.bytes).buffer], {
          type: "application/pdf",
        });
      } else {
        const r = await staffFetch(`/api/team/payroll-reports/${id}/pdf/`);
        if (!r.ok) {
          const b = await r.json();
          throw Error(b.message);
        }
        blob = await r.blob();
      }
      if (mounted.current && request === previewRequest.current) {
        const local = URL.createObjectURL(blob);
        urlRef.current = local;
        setUrl(local);
      }
    } catch (e) {
      if (mounted.current && request === previewRequest.current)
        setError(e instanceof Error ? e.message : "PDF preview unavailable.");
    }
  }
  async function generate() {
    setBusy(true);
    setError("");
    setNotice("");
    generation.current ??= crypto.randomUUID();
    const id = generation.current;
    try {
      if (ws.mode === "demo") {
        const payload = demoPayrollReport(data, payrollId, id),
          [{ createPayrollReportPdf }, assets] = await Promise.all([
            import("@/lib/payroll-report-pdf"),
            Promise.all(
              [
                "/fonts/NotoSerif-Regular.ttf",
                "/fonts/NotoSerif-Bold.ttf",
                "/brand/gardens-crest.jpg",
                "/brand/gardens-wordmark.png",
              ].map(async (path) => {
                const r = await fetch(path);
                if (!r.ok) throw Error("PDF assets unavailable.");
                return new Uint8Array(await r.arrayBuffer());
              }),
            ),
          ]);
        const bytes = await createPayrollReportPdf(payload, {
          regular: assets[0],
          bold: assets[1],
          crest: assets[2],
          wordmark: assets[3],
        });
        demoFiles.current.set(id, { data: payload, bytes });
        if (mounted.current)
          setHistory((h) => [
            {
              id,
              payroll_id: payrollId,
              created_at: payload.generated_at,
              state: "ready",
              recipient: payload.employee.email,
              payment_status: payload.payment_status,
              paid_cents: payload.paid_cents,
              balance_cents: payload.balance_cents,
              deliveries: [],
            },
            ...h.filter((r) => r.id !== id),
          ]);
        generation.current = null;
        await preview(id);
      } else {
        const r = await staffFetch("/api/team/payroll-reports/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, payroll_id: payrollId }),
          }),
          b = await r.json();
        if (!r.ok) throw Error(b.message);
        await loadHistory();
        if (b.state === "ready") {
          generation.current = null;
          await preview(id);
        } else
          setNotice(
            "This version is being prepared. Refresh history; retry the same generation after ninety seconds if needed.",
          );
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error
            ? e.message
            : "Report generation was not confirmed. Retry the same generation.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    if (!started.current) {
      started.current = true;
      void generate();
      if (ws.mode !== "demo")
        void staffFetch("/api/team/payroll-mail/")
          .then((r) => r.json())
          .then((s) => {
            if (mounted.current) setMailReady(s.connected === true);
          })
          .catch(() => {});
    }
    return () => {
      mounted.current = false;
      previewRequest.current++;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);
  useEffect(() => {
    if (
      ws.mode === "demo" ||
      !history.some(
        (r) =>
          r.state === "creating" ||
          r.deliveries.some(
            (d) => d.status === "sending" || d.status === "reserved",
          ),
      )
    )
      return;
    const timer = setInterval(() => void loadHistory().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [history, ws.mode]);
  async function send() {
    if (!version || !reviewed) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (uncertain && !ack)
        throw Error(
          "Check Gmail Sent and acknowledge the duplicate risk first.",
        );
      const resend = sent || uncertain;
      let id = sendNonce.current.get(version.id);
      if (!id || resend) {
        id = crypto.randomUUID();
        sendNonce.current.set(version.id, id);
      }
      const r = await staffFetch(
          `/api/team/payroll-reports/${version.id}/send/`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, resend, acknowledge_uncertain: ack }),
          },
        ),
        b = await r.json();
      await loadHistory();
      if (!r.ok) throw Error(b.message);
      if (!["reserved", "sending", "unconfirmed"].includes(b.status))
        sendNonce.current.delete(version.id);
      setReviewed(false);
      setNotice(
        b.status === "sent"
          ? "Sent via Gmail. Gmail accepted this message."
          : b.status === "unconfirmed"
            ? "Unconfirmed. Check Gmail Sent before explicitly resending."
            : b.status === "failed"
              ? "Gmail rejected the send. Check the connection or sending limit before retrying."
              : "Sending is in progress. Refresh history before taking another action.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Send confirmation was lost. Refresh history before taking another action.",
      );
      void loadHistory().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const timestamp = (s: string) =>
    new Intl.DateTimeFormat("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila",
    }).format(new Date(s));
  return (
    <dialog
      ref={dialog}
      className="record-dialog payroll-report-dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      aria-labelledby="payroll-report-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">FINALIZED EMPLOYEE REPORT</span>
          <h2 id="payroll-report-title">
            {employee?.name || "Employee payroll"}
          </h2>
          <p>
            {statement &&
              `${displayDate(statement.period_start)} - ${displayDate(statement.period_end)}`}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="Close payroll report"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="report-controls">
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void generate()}
        >
          {busy
            ? "Preparing…"
            : generation.current
              ? "Retry same generation"
              : "Generate new version"}
        </button>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void loadHistory().catch((e) => setError(e.message))}
        >
          <RefreshCw size={15} />
          Refresh history
        </button>
      </div>
      {ws.mode === "demo" && (
        <p className="setup-note">
          Fictional demonstration. Reports stay in this window and no emails are
          sent.
        </p>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="setup-note" role="status">
          {notice}
        </p>
      )}
      <div className="report-version-list">
        {history.map((r, i) => (
          <button
            key={r.id}
            className={`report-version ${selected === r.id ? "selected" : ""}`}
            disabled={busy || (r.state !== "ready" && !r.can_retry)}
            onClick={() => {
              if (r.state === "creating") {
                generation.current = r.id;
                void generate();
              } else void preview(r.id);
            }}
          >
            <strong>
              {i === 0 ? "Latest version" : "Previous version"} ·{" "}
              {timestamp(r.created_at)} Manila
            </strong>
            <span>
              {r.state === "ready"
                ? `${r.payment_status} · Balance ${money(r.balance_cents)}`
                : r.can_retry
                  ? "Generation not confirmed - click to retry this version"
                  : "Preparing PDF"}
            </span>
            <small>
              {r.deliveries[0]
                ? `Email: ${r.deliveries[0].status}`
                : "Not emailed"}
            </small>
          </button>
        ))}
      </div>
      {version && url && (
        <>
          <div className="report-review">
            <p>
              <strong>Recipient:</strong> {version.recipient}
            </p>
            <p>
              <strong>Payment status:</strong> {version.payment_status} · Paid{" "}
              {money(version.paid_cents)} · Balance{" "}
              {money(version.balance_cents)} as of{" "}
              {timestamp(version.created_at)} Manila.
            </p>
            <p>
              This saved version keeps the figures you reviewed. Generate a new
              version after recording additional payments.
            </p>
            <a
              className="button secondary"
              href={url}
              download={`The-Gardens-Finalized-Payroll-${employee?.employee_code || "employee"}-${statement?.period_start}-${version.id.slice(0, 8)}.pdf`}
            >
              <Download size={16} />
              Download this PDF
            </a>{" "}
            <a
              className="text-button"
              href={url}
              target="_blank"
              rel="noreferrer"
            >
              Open PDF preview
            </a>
          </div>
          <iframe
            title="Finalized payroll PDF preview"
            className="payroll-pdf-preview"
            src={url}
          />
          <div className="report-send">
            <p>
              <strong>From:</strong> theplaymakers2026@gmail.com
            </p>
            {!mailReady && (
              <p>
                Sending is disabled until Jeremy connects Gmail in Payroll
                settings. You can download this PDF now.
              </p>
            )}
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />
              I reviewed this PDF and confirm sending it to {version.recipient}.
            </label>
            {uncertain && (
              <label className="checkbox-line">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                I checked Gmail Sent and understand resending may duplicate a
                previously accepted email.
              </label>
            )}
            <button
              className="button primary"
              disabled={
                busy ||
                !mailReady ||
                !reviewed ||
                inProgress ||
                (uncertain && !ack) ||
                ws.mode === "demo"
              }
              onClick={() => void send()}
            >
              <Mail size={16} />
              {sent || uncertain
                ? "Explicitly resend this report"
                : "Send this report"}
            </button>
          </div>
          {!!previous.length && (
            <details open>
              <summary>Email attempt history</summary>
              <ul>
                {previous.map((d) => (
                  <li key={d.id}>
                    {timestamp(d.created_at)} Manila · {d.status} ·{" "}
                    {d.recipient}
                    {d.error_code
                      ? ` · ${d.error_code.replaceAll("_", " ")}`
                      : ""}
                  </li>
                ))}
              </ul>
              <p>
                Sent means Gmail accepted the message. Unconfirmed attempts
                require checking Gmail Sent before resending.
              </p>
            </details>
          )}
        </>
      )}
    </dialog>
  );
}
