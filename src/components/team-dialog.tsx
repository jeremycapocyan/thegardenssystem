"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, LoaderCircle } from "lucide-react";
import { parseMoney, todayInManila, money } from "@/lib/finance";
import {
  manilaInput,
  fromManilaInput,
  type Employee,
  type PayrollDay,
  type Payroll,
  type StaffRequest,
  type RequestKind,
  type PayrollPreview,
  type Schedule,
} from "@/lib/team";
export interface TeamEditor {
  action:
    | "employee"
    | "request"
    | "decide"
    | "cancel_leave"
    | "correct"
    | "override"
    | "overtime"
    | "void"
    | "finalize"
    | "release"
    | "pay"
    | "qr";
  employee?: Employee;
  schedule?: Schedule;
  day?: PayrollDay;
  request?: StaffRequest;
  payroll?: Payroll;
  preview?: PayrollPreview;
  requestKind?: RequestKind;
  remaining?: number;
  period?: string;
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function TeamDialog({
  editor,
  onClose,
  onSubmit,
}: {
  editor: TeamEditor;
  onClose: () => void;
  onSubmit: (action: string, payload: Record<string, unknown>) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [id] = useState(() => crypto.randomUUID());
  const e = editor.employee;
  const r = editor.request;
  const day = editor.day;
  const a = editor.action;
  const [kind, setKind] = useState(editor.requestKind || "leave");
  const [allOt, setAllOt] = useState(true);
  const [decision, setDecision] = useState("approved");
  const titles = {
    employee: e ? "Edit employee & schedule" : "Add employee",
    request: "Submit a request",
    decide: "Review request",
    cancel_leave: "Cancel approved leave",
    correct: "Correct attendance",
    override: "Change a workday",
    overtime: "Review overtime",
    void: "Void incorrect attendance",
    finalize: "Finalize this payroll?",
    release: "Record advance release",
    pay: "Record salary payment",
    qr: "Replace the printed QR?",
  };
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const f = new FormData(event.currentTarget);
      const get = (name: string) => String(f.get(name) || "").trim();
      let p: Record<string, unknown> = { id, employee_id: e?.id };
      if (a === "employee") {
        const start = get("started_on");
        if (get("ended_on") && get("ended_on") < start)
          throw Error("End date must be on or after the start date.");
        p = {
          ...p,
          name: get("name"),
          email: get("email"),
          started_on: start,
          ended_on: get("ended_on") || null,
          active: f.has("active"),
          effective_from: get("effective_from"),
          weekdays: f.getAll("weekday").map(Number),
        };
      }
      if (a === "request") {
        if (kind !== "advance" && get("end_date") < get("start_date"))
          throw Error("End date must be on or after the start date.");
        p = {
          ...p,
          kind,
          reason: get("reason"),
          start_date: kind === "advance" ? null : get("start_date"),
          end_date: kind === "advance" ? null : get("end_date"),
          amount_cents: kind === "advance" ? parseMoney(get("amount")) : null,
        };
      }
      if (a === "decide" || a === "cancel_leave")
        p = {
          ...p,
          request_id: r!.id,
          status: get("decision"),
          paid_leave: get("paid_leave") === "true",
          note: get("reason"),
        };
      if (a === "correct")
        p = {
          ...p,
          date: get("date"),
          clock_in: fromManilaInput(get("clock_in")),
          clock_out: get("clock_out")
            ? fromManilaInput(get("clock_out"))
            : null,
          reason: get("reason"),
        };
      if (a === "override")
        p = {
          ...p,
          date: get("date"),
          working: get("working") === "true",
          reason: get("reason"),
        };
      if (a === "overtime")
        p = {
          ...p,
          attendance_id: day!.attendance_id,
          seconds: allOt ? day!.overtime_seconds : Number(get("minutes")) * 60,
        };
      if (a === "void")
        p = { ...p, attendance_id: day!.attendance_id, reason: get("reason") };
      if (a === "finalize") p = { ...p, period_start: editor.period };
      if (a === "pay" || a === "release")
        p = {
          ...p,
          paid_on: get("paid_on"),
          amount_cents: parseMoney(get("amount")),
          reference: get("reference"),
          ...(a === "release"
            ? { request_id: r!.id }
            : { payroll_id: editor.payroll!.id }),
        };
      await onSubmit(a, p);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save.");
    } finally {
      setPending(false);
    }
  }
  return (
    <dialog
      className="record-dialog team-dialog"
      ref={ref}
      onCancel={() => {
        if (!pending) onClose();
      }}
      aria-labelledby="team-dialog-title"
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">THE GARDENS · EMPLOYEE RECORDS</span>
          <h2 id="team-dialog-title">{titles[a]}</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Close form"
          onClick={onClose}
          disabled={pending}
        >
          <X size={20} />
        </button>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid">
          {a === "employee" && (
            <>
              <Field label="Full name">
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={e?.name}
                />
              </Field>
              <Field
                label="Employee email"
                hint={
                  e?.profile_id
                    ? "Linked login email is fixed. Contact Jeremy for an account change."
                    : "Save first, then choose Invite / resend."
                }
              >
                <input
                  type="email"
                  name="email"
                  required
                  maxLength={254}
                  defaultValue={e?.email}
                  readOnly={!!e?.profile_id}
                />
              </Field>
              <Field label="Employment start">
                <input
                  type="date"
                  name="started_on"
                  required
                  defaultValue={e?.started_on || todayInManila()}
                />
              </Field>
              <Field label="Employment end (optional)">
                <input
                  type="date"
                  name="ended_on"
                  defaultValue={e?.ended_on || ""}
                />
              </Field>
              <Field
                label="Schedule effective from"
                hint="Changes apply from this date. Finalized payroll stays locked."
              >
                <input
                  type="date"
                  name="effective_from"
                  required
                  defaultValue={e ? todayInManila() : todayInManila()}
                />
              </Field>
              <label className="team-check">
                <input
                  type="checkbox"
                  name="active"
                  defaultChecked={e?.active ?? true}
                />
                Active employee
              </label>
              <fieldset className="weekday-field field wide">
                <legend>Recurring workdays · 3:30–11:30 PM</legend>
                <div>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                    (label, i) => (
                      <label key={label}>
                        <input
                          type="checkbox"
                          name="weekday"
                          value={i}
                          defaultChecked={
                            editor.schedule
                              ? editor.schedule.weekdays.includes(i)
                              : false
                          }
                        />
                        {label}
                      </label>
                    ),
                  )}
                </div>
                <small>
                  Unchecked days are rest days. An empty week means no recurring
                  shifts.
                </small>
              </fieldset>
            </>
          )}
          {a === "request" && (
            <>
              <Field label="Request type">
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as RequestKind)
                  }
                >
                  <option value="leave">Leave</option>
                  <option value="sick">Sick leave</option>
                  <option value="advance">Salary advance</option>
                </select>
              </Field>
              {kind === "advance" ? (
                <Field label="Amount (₱)">
                  <input
                    name="amount"
                    inputMode="decimal"
                    placeholder="0.00"
                    required
                  />
                </Field>
              ) : (
                <>
                  <Field label="Start date">
                    <input
                      name="start_date"
                      type="date"
                      required
                      defaultValue={todayInManila()}
                    />
                  </Field>
                  <Field label="End date">
                    <input
                      name="end_date"
                      type="date"
                      required
                      defaultValue={todayInManila()}
                    />
                  </Field>
                </>
              )}
            </>
          )}
          {a === "decide" && (
            <>
              <div className="field wide">
                <strong>
                  {r?.kind === "advance"
                    ? "Salary advance"
                    : r?.kind === "sick"
                      ? "Sick leave"
                      : "Leave"}{" "}
                  ·{" "}
                  {r?.amount_cents
                    ? money(r.amount_cents)
                    : `${r?.start_date} to ${r?.end_date}`}
                </strong>
                <p>{r?.reason}</p>
              </div>
              <Field label="Decision">
                <select
                  name="decision"
                  value={decision}
                  onChange={(event) => setDecision(event.target.value)}
                >
                  <option value="approved">Approve</option>
                  <option value="rejected">Reject</option>
                </select>
              </Field>
              {r?.kind !== "advance" && decision === "approved" && (
                <Field label="Leave pay">
                  <select name="paid_leave" required defaultValue="">
                    <option value="" disabled>
                      Choose paid or unpaid
                    </option>
                    <option value="true">Paid leave</option>
                    <option value="false">Unpaid leave</option>
                  </select>
                </Field>
              )}
            </>
          )}
          {(a === "correct" || a === "override") && (
            <Field label="Work date">
              <input
                name="date"
                type="date"
                required
                defaultValue={day?.date || todayInManila()}
              />
            </Field>
          )}
          {a === "correct" && (
            <>
              <Field label="Time in · Manila">
                <input
                  name="clock_in"
                  type="datetime-local"
                  required
                  defaultValue={
                    day?.clock_in
                      ? manilaInput(day.clock_in)
                      : `${day?.date || todayInManila()}T15:30`
                  }
                />
              </Field>
              <Field label="Time out · Manila (optional)">
                <input
                  name="clock_out"
                  type="datetime-local"
                  defaultValue={
                    day?.clock_out ? manilaInput(day.clock_out) : ""
                  }
                />
              </Field>
            </>
          )}
          {a === "override" && (
            <Field label="Schedule for this date">
              <select
                name="working"
                defaultValue={day?.scheduled ? "false" : "true"}
              >
                <option value="true">Working · 3:30–11:30 PM</option>
                <option value="false">Rest day</option>
              </select>
            </Field>
          )}
          {a === "overtime" && (
            <>
              <label className="team-check wide">
                <input
                  type="checkbox"
                  checked={allOt}
                  onChange={(event) => setAllOt(event.target.checked)}
                />
                Approve all recorded overtime (
                {(day!.overtime_seconds / 60).toFixed(2)} minutes)
              </label>
              <Field
                label="Approved overtime minutes"
                hint="Uncheck Approve all to enter a smaller amount. Enter 0 to reject overtime."
              >
                <input
                  name="minutes"
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={allOt}
                  required={!allOt}
                  defaultValue={
                    Math.floor((day!.overtime_seconds / 60) * 100) / 100
                  }
                />
              </Field>
            </>
          )}
          {(a === "pay" || a === "release") && (
            <>
              <p className="field wide">
                Record cash actually paid. Remaining:{" "}
                <strong>{money(editor.remaining || 0)}</strong>. One linked
                Wages expense is created automatically.
              </p>
              <Field label="Payment date">
                <input
                  name="paid_on"
                  type="date"
                  max={todayInManila()}
                  required
                  defaultValue={todayInManila()}
                />
              </Field>
              <Field label="Amount (₱)">
                <input
                  name="amount"
                  inputMode="decimal"
                  required
                  defaultValue={((editor.remaining || 0) / 100).toFixed(2)}
                />
              </Field>
              <Field label="Receipt / transfer reference">
                <input name="reference" maxLength={120} />
              </Field>
            </>
          )}
          {a === "finalize" && (
            <p className="field wide">
              Finalize {editor.preview?.period_start} to{" "}
              {editor.preview?.period_end}: earnings{" "}
              <strong>{money(editor.preview?.gross_cents || 0)}</strong>,
              advance recovery{" "}
              <strong>{money(editor.preview?.recovery_cents || 0)}</strong>,
              salary payable{" "}
              <strong>{money(editor.preview?.payable_cents || 0)}</strong>. This
              freezes the statement and allocates advance deductions. It does
              not record a cash payment.
            </p>
          )}
          {a === "qr" && (
            <p className="field wide">
              The old printed QR will stop working. Print and display the
              replacement before employees use it.
            </p>
          )}
          {a === "void" && (
            <p className="field wide">
              Remove this incorrect attendance from payroll calculations. The
              original record and correction reason remain in the audit history.
            </p>
          )}
          {[
            "request",
            "decide",
            "cancel_leave",
            "correct",
            "override",
            "void",
          ].includes(a) && (
            <label className="field wide">
              <span>
                {a === "decide" ? "Decision note (optional)" : "Reason"}
              </span>
              <textarea
                name="reason"
                required={a !== "decide"}
                maxLength={1000}
                rows={3}
              />
            </label>
          )}
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button className="button primary" disabled={pending}>
            {pending && <LoaderCircle className="spin" size={16} />}{" "}
            {pending
              ? "Saving…"
              : a === "request"
                ? "Submit request"
                : a === "finalize"
                  ? "Finalize payroll"
                  : a === "qr"
                    ? "Replace QR"
                    : "Save record"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
