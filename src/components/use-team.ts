"use client";
import { useCallback, useEffect, useState } from "react";
import { getBackend, friendlyError } from "@/lib/backend";
import { todayInManila } from "@/lib/finance";
import {
  demoTeam,
  emptyTeam,
  previewPayroll,
  TEAM_DEMO_STORE,
  type TeamData,
  type PayrollPreview,
  type Employee,
  type StaffRequest,
  type Attendance,
  type Payroll,
  type StaffCash,
} from "@/lib/team";
import { useWorkspace } from "./workspace-provider";
import { canManage } from "@/lib/access";

export function useTeam() {
  const ws = useWorkspace();
  const [data, setData] = useState<TeamData>(emptyTeam);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const allowed =
    canManage(ws.profile, "team") || ws.profile?.role === "employee";
  const refresh = useCallback(async () => {
    if (ws.mode === "demo") return;
    if (ws.mode !== "live" || !allowed) {
      setLoading(false);
      setData(emptyTeam());
      return;
    }
    const result = await getBackend()!.rpc("garden_team_snapshot");
    if (result.error) {
      setError("Unable to load employee records. Please refresh.");
      setLoading(false);
      return;
    }
    setData(result.data as TeamData);
    setError("");
    setLoading(false);
  }, [ws.mode, allowed, ws.profile?.id]);
  useEffect(() => {
    if (ws.mode === "demo") {
      let initial = demoTeam();
      try {
        const stored = JSON.parse(
          localStorage.getItem(TEAM_DEMO_STORE) || "null",
        );
        if (
          stored &&
          Array.isArray(stored.employees) &&
          Array.isArray(stored.recoveries)
        )
          initial = stored;
      } catch {}
      setData(initial);
      setLoading(false);
      setError("");
      const reset = () => setData(demoTeam());
      window.addEventListener("gardens-demo-reset", reset);
      return () => window.removeEventListener("gardens-demo-reset", reset);
    }
    void refresh();
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30000);
    return () => {
      window.removeEventListener("focus", focus);
      clearInterval(timer);
    };
  }, [refresh, ws.mode]);
  function commit(next: TeamData) {
    localStorage.setItem(TEAM_DEMO_STORE, JSON.stringify(next));
    setData(next);
  }
  async function command(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    setError("");
    if (ws.mode === "live") {
      if (!navigator.onLine)
        throw Error("Reconnect before recording attendance or payments.");
      const result = await getBackend()!.rpc("garden_team_command", {
        p_action: action,
        p_payload: payload,
      });
      if (result.error) throw Error(friendlyError(result.error));
      await refresh();
      if (action === "release" || action === "pay") await ws.refresh();
      return result.data;
    }
    if (ws.mode !== "demo") throw Error("Sign in first.");
    const admin = ws.profile?.role === "admin";
    if (
      !admin &&
      !["clock_in", "clock_out", "request", "withdraw"].includes(action)
    )
      throw Error("Only Jeremy can manage employee records.");
    const next = structuredClone(data);
    const id = String(payload.id || crypto.randomUUID());
    const eid = String(
      payload.employee_id ||
        next.employees.find((e) => e.profile_id === ws.profile?.id)?.id ||
        "",
    );
    const now = new Date().toISOString();
    const employee = next.employees.find((e) => e.id === eid);
    const checkLocked = (date: string) => {
      if (
        next.payroll.some(
          (p) =>
            p.employee_id === eid &&
            date >= p.period_start &&
            date <= p.period_end,
        )
      )
        throw Error("Finalized payroll is locked.");
    };
    if (action === "employee") {
      const item = {
        id: eid || id,
        profile_id: employee?.profile_id || null,
        name: String(payload.name),
        email: String(payload.email),
        started_on: String(payload.started_on),
        ended_on: payload.ended_on ? String(payload.ended_on) : null,
        active: payload.active !== false,
      } as Employee;
      const effective = String(payload.effective_from);
      checkLocked(effective);
      next.employees = next.employees
        .filter((e) => e.id !== item.id)
        .concat(item);
      next.schedules = next.schedules
        .filter(
          (s) => !(s.employee_id === item.id && s.effective_from === effective),
        )
        .concat({
          id,
          employee_id: item.id,
          effective_from: effective,
          weekdays: payload.weekdays as number[],
        });
    } else if (action === "qr") next.qr = { id: crypto.randomUUID() };
    else if (action === "settings")
      next.settings = { wages_category_id: String(payload.category_id) };
    else if (action === "override") {
      checkLocked(String(payload.date));
      next.overrides = next.overrides
        .filter((o) => !(o.employee_id === eid && o.work_date === payload.date))
        .concat({
          id,
          employee_id: eid,
          work_date: String(payload.date),
          working: payload.working === true,
          reason: String(payload.reason),
        });
    } else if (action === "correct") {
      checkLocked(String(payload.date));
      next.attendance = next.attendance
        .filter((a) => !(a.employee_id === eid && a.work_date === payload.date))
        .concat({
          id,
          employee_id: eid,
          work_date: String(payload.date),
          clock_in: String(payload.clock_in),
          clock_out: payload.clock_out ? String(payload.clock_out) : null,
          approved_ot_seconds: null,
          ot_reviewed: false,
          correction_reason: String(payload.reason),
        });
    } else if (action === "void" || action === "overtime") {
      const item = next.attendance.find((a) => a.id === payload.attendance_id);
      if (!item) throw Error("Attendance not found.");
      checkLocked(item.work_date);
      if (action === "void")
        next.attendance = next.attendance.filter((a) => a.id !== item.id);
      else {
        item.approved_ot_seconds = Number(payload.seconds);
        item.ot_reviewed = true;
      }
    } else if (action === "request") {
      if (!employee?.active) throw Error("Employee account is inactive.");
      if (payload.start_date) checkLocked(String(payload.start_date));
      next.requests.push({
        id,
        employee_id: eid,
        kind: payload.kind as StaffRequest["kind"],
        start_date: payload.start_date ? String(payload.start_date) : null,
        end_date: payload.end_date ? String(payload.end_date) : null,
        amount_cents: payload.amount_cents
          ? Number(payload.amount_cents)
          : null,
        reason: String(payload.reason),
        status: "pending",
        paid_leave: null,
        decision_note: "",
        created_at: now,
      });
    } else if (["withdraw", "decide", "cancel_leave"].includes(action)) {
      const r = next.requests.find((r) => r.id === payload.request_id);
      if (!r) throw Error("Request not found.");
      if (
        action === "withdraw" &&
        (r.status !== "pending" || r.employee_id !== eid)
      )
        throw Error("Only your pending requests can be withdrawn.");
      if (r.start_date) checkLocked(r.start_date);
      if (
        action === "decide" &&
        payload.status === "approved" &&
        r.kind !== "advance" &&
        next.requests.some(
          (other) =>
            other.id !== r.id &&
            other.employee_id === r.employee_id &&
            other.kind !== "advance" &&
            other.status === "approved" &&
            other.start_date! <= r.end_date! &&
            other.end_date! >= r.start_date!,
        )
      )
        throw Error("Approved leave cannot overlap.");
      r.status =
        action === "decide"
          ? (payload.status as StaffRequest["status"])
          : "withdrawn";
      r.paid_leave = r.kind === "advance" ? null : payload.paid_leave === true;
      r.decision_note = String(payload.note || "");
    } else if (action === "clock_in" || action === "clock_out") {
      if (!employee?.active) throw Error("Employee account is inactive.");
      if (next.qr?.id !== payload.qr) throw Error("Scan the current court QR.");
      const open = next.attendance.find(
        (a) => a.employee_id === eid && !a.clock_out,
      );
      if (action === "clock_in") {
        if (open) throw Error("Already timed in.");
        if (
          next.attendance.some(
            (a) => a.employee_id === eid && a.work_date === todayInManila(),
          )
        )
          throw Error("Attendance is already recorded today.");
        next.attendance.push({
          id,
          employee_id: eid,
          work_date: todayInManila(),
          clock_in: now,
          clock_out: null,
          approved_ot_seconds: null,
          ot_reviewed: false,
          correction_reason: "",
        });
      } else {
        if (!open) throw Error("No open time-in.");
        if (Date.now() - new Date(open.clock_in).valueOf() < 60000)
          throw Error("Wait one minute before timing out.");
        open.clock_out = now;
      }
    } else if (action === "finalize") {
      const p = previewPayroll(next, eid, String(payload.period_start));
      if (p.blockers.length)
        throw Error(
          "Resolve all attendance, schedule and approval issues first.",
        );
      if (
        next.payroll.some(
          (r) => r.employee_id === eid && r.period_start === p.period_start,
        )
      )
        throw Error("Already finalized.");
      const statement: Payroll = {
        id,
        employee_id: eid,
        period_start: p.period_start,
        period_end: p.period_end,
        snapshot: p,
        gross_cents: p.gross_cents,
        recovery_cents: p.recovery_cents,
        payable_cents: p.payable_cents,
        finalized_at: now,
      };
      next.payroll.push(statement);
      let remaining = p.recovery_cents;
      for (const cash of next.cash
        .filter((c) => c.employee_id === eid && c.kind === "advance")
        .sort((a, b) => a.paid_on.localeCompare(b.paid_on))) {
        const available =
          cash.amount_cents -
          next.recoveries
            .filter((r) => r.cash_id === cash.id)
            .reduce((n, r) => n + r.amount_cents, 0);
        const amount = Math.min(remaining, available);
        if (amount > 0)
          next.recoveries.push({
            id: crypto.randomUUID(),
            employee_id: eid,
            cash_id: cash.id,
            payroll_id: id,
            amount_cents: amount,
          });
        remaining -= amount;
      }
    } else if (action === "pay" || action === "release") {
      const request = next.requests.find((r) => r.id === payload.request_id),
        payroll = next.payroll.find((p) => p.id === payload.payroll_id);
      const payable =
        action === "release" && request?.status === "approved"
          ? request.amount_cents || 0
          : action === "pay"
            ? payroll?.payable_cents || 0
            : 0;
      const already = next.cash
        .filter((c) =>
          action === "release"
            ? c.request_id === payload.request_id
            : c.payroll_id === payload.payroll_id,
        )
        .reduce((n, c) => n + c.amount_cents, 0);
      const amount = Number(payload.amount_cents);
      if (amount <= 0 || amount > payable - already)
        throw Error("Payment cannot exceed the remaining amount.");
      if (String(payload.paid_on) > todayInManila())
        throw Error("Record actual payments on or before today.");
      const personId = request?.employee_id || payroll?.employee_id || eid;
      const cash: StaffCash = {
        id,
        employee_id: personId,
        kind: action === "release" ? "advance" : "salary",
        request_id: request?.id || null,
        payroll_id: payroll?.id || null,
        amount_cents: amount,
        paid_on: String(payload.paid_on),
        reference: String(payload.reference || ""),
        created_at: now,
      };
      next.cash.push(cash);
      const cat =
        next.settings?.wages_category_id ||
        ws.data.categories.find(
          (c) => c.kind === "expense" && c.name === "Wages",
        )?.id;
      if (!cat) throw Error("Choose a wages category.");
      await ws.save("expenses", {
        id,
        paid_on: cash.paid_on,
        category_id: cat,
        payment_kind: "operating",
        amount_cents: amount,
        reference: cash.reference,
        notes:
          action === "release"
            ? "Employee salary advance"
            : "Payroll settlement",
        fixed_bill_id: null,
        installment_id: null,
        due_month: null,
        staff_payment_id: id,
      });
    } else throw Error("Unknown employee action.");
    commit(next);
    return { saved: true };
  }
  async function preview(eid: string, start: string): Promise<PayrollPreview> {
    if (ws.mode === "demo") return previewPayroll(data, eid, start);
    const result = await getBackend()!.rpc("garden_payroll_preview", {
      p_employee: eid,
      p_start: start,
    });
    if (result.error) throw Error(friendlyError(result.error));
    return result.data;
  }
  return { data, loading, error, refresh, command, preview };
}
