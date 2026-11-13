"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useWorkspace } from "./workspace-provider";
import { getBackend } from "@/lib/backend";
import { validPin } from "@/lib/attendance-input";
import type { Employee } from "@/lib/team";
export function EmployeePinPanel({
  employee,
  onSaved,
  court,
}: {
  employee: Employee;
  onSaved: () => Promise<void>;
  court?: string;
}) {
  const ws = useWorkspace(),
    [pin, setPin] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!validPin(pin) || pin !== confirmation) {
      setError("Enter the same six-digit PIN in both fields.");
      return;
    }
    setBusy(true);
    try {
      if (ws.mode === "demo") {
        setNotice("Sample only: no attendance PIN was stored or changed.");
      } else {
        const session = await getBackend()!.auth.getSession(),
          response = await fetch("/api/attendance/pin/", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.data.session?.access_token || ""}`,
            },
            body: JSON.stringify({ pin, confirmation }),
          }),
          data = await response.json();
        if (!response.ok) throw Error(data.message);
        setNotice(data.message);
        await onSaved();
      }
      setPin("");
      setConfirmation("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save your PIN.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel staff-welcome pin-setup">
      <div>
        <h2>Your attendance PIN</h2>
        <p>
          Sign in here once to choose a private PIN. At the court, scan the
          printed QR and use your code and PIN for Time In or Time Out.
        </p>
      </div>
      <div className="employee-code">
        <span>Your permanent employee code</span>
        <strong>{employee.employee_code || "Refresh to load your code"}</strong>
        <span>
          {employee.pin_configured
            ? "PIN configured. You can replace it below."
            : "Set your attendance PIN to enable code check-in."}
        </span>
      </div>
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span>New six-digit PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
              disabled={busy || !employee.active}
            />
          </label>
          <label className="field">
            <span>Confirm six-digit PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              required
              disabled={busy || !employee.active}
            />
          </label>
        </div>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <p className="setup-note" role="status">
            {notice}
          </p>
        )}
        <button className="button primary" disabled={busy || !employee.active}>
          {busy ? "Saving PIN…" : "Save attendance PIN"}
        </button>
      </form>
      <p>
        Only you choose your PIN. Account managers can revoke it but cannot read
        it. Your existing login is still used for requests and personal records.
      </p>
      {court && (
        <Link
          href={`/employee/scan/?court=${encodeURIComponent(court)}`}
          className="button secondary"
        >
          Return to court attendance
        </Link>
      )}
      <a href="/employee/" className="text-button">
        Back to employee portal
      </a>
    </section>
  );
}
