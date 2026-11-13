"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Clock, LogIn, LogOut, ShieldCheck } from "lucide-react";
import { CourtMark } from "./finance-app";
import {
  normalizeEmployeeCode,
  validPin,
  validUuid,
} from "@/lib/attendance-input";
import { demoTeam, TEAM_DEMO_STORE, type TeamData } from "@/lib/team";
import { demoPinPunch, type DemoPinEvent } from "@/lib/demo-pin-clock";
const demoEvents = "gardens.pin.sample.events.v1";
export function PinClock() {
  const [court, setCourt] = useState(""),
    [code, setCode] = useState(""),
    [pin, setPin] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState<{
      name: string;
      action: string;
      at: string;
    } | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null),
    nonce = useRef<{
      id: string;
      action: "clock_in" | "clock_out";
      code: string;
    } | null>(null);
  useEffect(() => {
    setCourt(new URLSearchParams(window.location.search).get("court") || "");
  }, []);
  const sample = court === "demo-court-qr",
    validCourt = sample || validUuid(court),
    fallback = `/employee/?clock=1&court=${encodeURIComponent(court)}`,
    setup = `/employee/?setup=pin&court=${encodeURIComponent(court)}`;
  async function clock(action: "clock_in" | "clock_out") {
    setError("");
    setResult(null);
    const employeeCode = normalizeEmployeeCode(code);
    if (!employeeCode || !validPin(pin)) {
      setError("Enter your employee code and six-digit PIN.");
      return;
    }
    if (
      nonce.current &&
      (nonce.current.action !== action || nonce.current.code !== employeeCode)
    ) {
      setError(
        "Retry the same employee and action until the previous punch is confirmed.",
      );
      return;
    }
    nonce.current ??= { id: crypto.randomUUID(), action, code: employeeCode };
    setBusy(true);
    setPendingAction(action);
    try {
      let recorded: { name: string; action: string; at: string };
      if (sample) {
        let data: TeamData = demoTeam();
        try {
          const saved = JSON.parse(
            localStorage.getItem(TEAM_DEMO_STORE) || "null",
          );
          if (
            saved &&
            Array.isArray(saved.employees) &&
            Array.isArray(saved.attendance)
          )
            data = saved;
        } catch {}
        let events: DemoPinEvent[] = [];
        try {
          events = JSON.parse(localStorage.getItem(demoEvents) || "[]");
        } catch {}
        const changed = demoPinPunch(
          data,
          events,
          employeeCode,
          pin,
          action,
          nonce.current.id,
        );
        localStorage.setItem(TEAM_DEMO_STORE, JSON.stringify(changed.data));
        localStorage.setItem(demoEvents, JSON.stringify(changed.events));
        recorded = changed.result;
      } else {
        const response = await fetch("/api/attendance/clock/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            court,
            employee_code: employeeCode,
            pin,
            action,
            idempotency_key: nonce.current.id,
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          if (response.status < 500) {
            nonce.current = null;
            setPendingAction(null);
          }
          throw Error(
            body.message ||
              "Attendance was not confirmed. Retry the same action.",
          );
        }
        recorded = body;
      }
      setResult(recorded);
      setPin("");
      nonce.current = null;
      setPendingAction(null);
    } catch (e) {
      if (sample) {
        nonce.current = null;
        setPendingAction(null);
      }
      setError(
        e instanceof Error
          ? e.message
          : "Attendance was not confirmed. Retry the same action.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="pin-clock-page" id="main-content">
      <section className="panel pin-clock-card">
        <CourtMark size={70} />
        <span className="eyebrow">THE GARDENS · COURT ATTENDANCE</span>
        <h1>Time In / Time Out</h1>
        <p>
          Enter your employee code and private PIN, then choose your action.
          Scanning alone does not record attendance.
        </p>
        {sample && (
          <p className="setup-note">
            Fictional example only. Code: <strong>TG-0001</strong> · PIN:{" "}
            <strong>123456</strong>. No real attendance is recorded.
          </p>
        )}
        {!validCourt && (
          <p className="error-box">
            Scan the printed court QR to open attendance.
          </p>
        )}
        <form onSubmit={(e) => e.preventDefault()}>
          <label className="field">
            <span>Employee code</span>
            <input
              name="employee_code"
              autoComplete="username"
              maxLength={40}
              placeholder="TG-0001"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={busy}
              autoCapitalize="characters"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Six-digit attendance PIN</span>
            <input
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              pattern="[0-9]{6}"
              minLength={6}
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              disabled={busy}
            />
          </label>
          <div className="pin-clock-actions">
            <button
              type="button"
              className="button primary"
              disabled={
                busy ||
                !validCourt ||
                (!!pendingAction && pendingAction !== "clock_in")
              }
              onClick={() => void clock("clock_in")}
            >
              <LogIn size={20} />
              {pendingAction === "clock_in" && !busy
                ? "Retry Time In"
                : "Time In"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={
                busy ||
                !validCourt ||
                (!!pendingAction && pendingAction !== "clock_out")
              }
              onClick={() => void clock("clock_out")}
            >
              <LogOut size={20} />
              {pendingAction === "clock_out" && !busy
                ? "Retry Time Out"
                : "Time Out"}
            </button>
          </div>
        </form>
        {busy && <p role="status">Confirming attendance…</p>}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div className="pin-confirmation" role="status">
            <ShieldCheck size={24} />
            <strong>
              {result.name}:{" "}
              {result.action === "clock_in" ? "Time In" : "Time Out"} recorded
            </strong>
            <span>
              {new Intl.DateTimeFormat("en-PH", {
                dateStyle: "medium",
                timeStyle: "medium",
                timeZone: "Asia/Manila",
              }).format(new Date(result.at))}{" "}
              · Asia/Manila
            </span>
          </div>
        )}
        <div className="pin-clock-links">
          <Link href={setup}>
            First time or forgotten PIN? Sign in to set your PIN
          </Link>
          <Link href={fallback}>Use employee email sign-in instead</Link>
          <Link href="/employee/">Employee requests and personal records</Link>
        </div>
        <p className="pin-clock-note">
          <Clock size={14} />
          PIN check-in gives clock access only. Requests and personal records
          require your existing employee login.
        </p>
      </section>
    </main>
  );
}
