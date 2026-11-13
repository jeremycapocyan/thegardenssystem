"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import QRCode from "qrcode";
import {
  Users,
  CalendarDays,
  ClipboardCheck,
  Wallet,
  QrCode,
  ArrowLeft,
  Plus,
  RefreshCw,
  Download,
  Printer,
  LogOut,
  Menu,
  X,
  ScanLine,
  Check,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { CourtMark, Login } from "./finance-app";
import { useWorkspace } from "./workspace-provider";
import { useTeam } from "./use-team";
import { TeamDialog, type TeamEditor } from "./team-dialog";
import { CourtScanner } from "./court-scanner";
import { TimesheetsPanel } from "./timesheets-panel";
import { EmployeePinPanel } from "./employee-pin-panel";
import { canManage, canViewFinance } from "@/lib/access";
import { csv, displayDate, money, todayInManila } from "@/lib/finance";
import {
  demoTeam,
  employeePeriod,
  payrollEnd,
  duration,
  timeInManila,
  type PayrollPreview,
  type StaffRequest,
} from "@/lib/team";

type Tab =
  | "overview"
  | "employees"
  | "attendance"
  | "requests"
  | "payroll"
  | "timesheets"
  | "pin"
  | "qr"
  | "scan";
function Tag({ children }: { children: ReactNode }) {
  const text = String(children);
  return (
    <span
      className={`badge ${/pending|Late|Absent|Missing|Unscheduled|conflict/i.test(text) ? "warm" : /approved|Present|Paid|Finalized/i.test(text) ? "success" : "neutral"}`}
    >
      {children}
    </span>
  );
}
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
      <div className="stat-top">{label}</div>
      <strong>{value}</strong>
      <span className="stat-note">{note}</span>
    </section>
  );
}
function Blank({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Users size={28} />
      <p>{children}</p>
    </div>
  );
}
export function TeamApp({ scan = false }: { scan?: boolean }) {
  const router = useRouter();
  const ws = useWorkspace(),
    team = useTeam();
  const admin = canManage(ws.profile, "team"),
    employeeRole = ws.profile?.role === "employee";
  const [tab, setTab] = useState<Tab>(scan ? "scan" : "overview");
  const [period, setPeriod] = useState(employeePeriod(todayInManila()));
  const [selected, setSelected] = useState("");
  const [pay, setPay] = useState<PayrollPreview | null>(null),
    [payLoading, setPayLoading] = useState(false);
  const [editor, setEditor] = useState<TeamEditor | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState(false),
    [scanner, setScanner] = useState(false),
    [allRequests, setAllRequests] = useState(true);
  const [court, setCourt] = useState(""),
    [svg, setSvg] = useState("");
  const clockNonce = useRef<{
    id: string;
    action: "clock_in" | "clock_out";
  } | null>(null);
  const data = team.data;
  const people = admin
    ? data.employees
    : data.employees.filter((e) => e.profile_id === ws.profile?.id);
  const eid = admin
    ? people.find((e) => e.id === selected)?.id || people[0]?.id || ""
    : people[0]?.id || "";
  const employee = people.find((e) => e.id === eid);
  const statement = data.payroll.find(
    (p) => p.employee_id === eid && p.period_start === period,
  );
  const report = statement?.snapshot || pay;
  const ownAttendance = data.attendance.filter(
    (a) => a.employee_id === eid && !a.voided,
  );
  const open = ownAttendance.find((a) => !a.clock_out);
  const advanceBalance = Math.max(
    0,
    data.cash
      .filter((c) => c.employee_id === eid && c.kind === "advance")
      .reduce((n, c) => n + c.amount_cents, 0) -
      data.recoveries
        .filter((r) => r.employee_id === eid)
        .reduce((n, r) => n + r.amount_cents, 0),
  );
  const paid = statement
    ? data.cash
        .filter((c) => c.payroll_id === statement.id)
        .reduce((n, c) => n + c.amount_cents, 0)
    : 0;
  const requests = data.requests.filter(
    (r) => (admin && allRequests) || r.employee_id === eid,
  );
  const pending = data.requests.filter((r) => r.status === "pending");
  const unlinked = data.employees.filter((e) => !e.profile_id).length;
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("court")) setCourt(query.get("court") || "");
    if (employeeRole && query.get("setup") === "pin") setTab("pin");
    else if (scan || query.get("clock") === "1") setTab("scan");
  }, [scan, employeeRole]);
  useEffect(() => {
    if (ws.mode === "demo")
      setPeriod(employeePeriod(demoTeam().attendance[0].work_date));
  }, [ws.mode]);
  useEffect(() => {
    if (
      employeeRole &&
      ![
        "overview",
        "attendance",
        "requests",
        "payroll",
        "scan",
        "pin",
      ].includes(tab)
    )
      setTab(scan ? "scan" : "overview");
  }, [employeeRole, tab, scan]);
  useEffect(() => {
    let active = true;
    setPay(null);
    if (!eid) return;
    setPayLoading(true);
    void team
      .preview(eid, period)
      .then((p) => {
        if (active) {
          setPay(p);
          setError("");
        }
      })
      .catch((err) => {
        if (active) setError(err.message);
      })
      .finally(() => {
        if (active) setPayLoading(false);
      });
    return () => {
      active = false;
    };
  }, [eid, period, team.data, ws.mode]);
  useEffect(() => {
    if (!data.qr) {
      setSvg("");
      return;
    }
    let alive = true;
    void QRCode.toString(
      `${window.location.origin}/employee/scan/?court=${encodeURIComponent(data.qr.id)}`,
      { type: "svg", width: 460, margin: 4, errorCorrectionLevel: "M" },
    ).then((value) => {
      if (alive) setSvg(value);
    });
    return () => {
      alive = false;
    };
  }, [data.qr?.id]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(id);
  }, [notice]);
  async function run(
    action: string,
    payload: Record<string, unknown>,
    message = "Record saved.",
  ) {
    setError("");
    await team.command(action, payload);
    setNotice(message);
  }
  async function quick(
    action: string,
    payload: Record<string, unknown>,
    message?: string,
  ) {
    setBusy(true);
    try {
      await run(action, payload, message);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save.");
    } finally {
      setBusy(false);
    }
  }
  async function invite(id: string) {
    if (ws.mode === "demo") {
      setNotice(
        "In the shared workspace, Invite sends an account setup email. No email is sent from this sample.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const api = (await import("@/lib/backend")).getBackend()!;
      const session = await api.auth.getSession();
      const response = await fetch("/api/team/invite/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.data.session?.access_token || ""}`,
        },
        body: JSON.stringify({ employee_id: id }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.message);
      setNotice(result.message);
      await team.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to invite.");
    } finally {
      setBusy(false);
    }
  }
  async function clock() {
    if (!court) return;
    clockNonce.current ??= {
      id: crypto.randomUUID(),
      action: open ? "clock_out" : "clock_in",
    };
    setBusy(true);
    setError("");
    try {
      await run(
        clockNonce.current.action,
        { id: clockNonce.current.id, qr: court },
        clockNonce.current.action === "clock_out"
          ? "Time out recorded."
          : "Time in recorded.",
      );
      clockNonce.current = null;
      setCourt("");
      setTab("overview");
      router.replace("/employee/");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Attendance was not confirmed. Refresh before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  function download(contents: string, type: string, name: string) {
    const url = URL.createObjectURL(new Blob([contents], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportPayroll() {
    if (!report) return;
    download(
      csv([
        [
          "Employee",
          "Period start",
          "Period end",
          "Regular (PHP)",
          "Missed time deduction (PHP)",
          "Overtime (PHP)",
          "Paid leave (PHP)",
          "Gross (PHP)",
          "Advance recovery (PHP)",
          "Salary payable (PHP)",
          "Paid (PHP)",
          "Status",
        ],
        [
          employee?.name || "",
          period,
          report.period_end,
          report.regular_cents / 100,
          report.deduction_cents / 100,
          report.ot_cents / 100,
          report.leave_cents / 100,
          report.gross_cents / 100,
          report.recovery_cents / 100,
          report.payable_cents / 100,
          paid / 100,
          statement ? "Finalized" : "Estimate",
        ],
        [],
        [
          "Date",
          "Status",
          "Time in (Manila)",
          "Time out (Manila)",
          "Late minutes",
          "Undertime minutes",
          "Approved OT minutes",
          "Regular (PHP)",
          "OT (PHP)",
          "Paid leave (PHP)",
          "Total (PHP)",
        ],
        ...report.days.map((d) => [
          d.date,
          d.status,
          timeInManila(d.clock_in),
          timeInManila(d.clock_out),
          (d.late_seconds / 60).toFixed(2),
          (d.undertime_seconds / 60).toFixed(2),
          (d.approved_ot_seconds / 60).toFixed(2),
          d.regular_cents / 100,
          d.ot_cents / 100,
          d.leave_cents / 100,
          d.total_cents / 100,
        ]),
      ]),
      "text/csv;charset=utf-8",
      `the-gardens-payroll-${employee?.name}-${period}.csv`,
    );
  }
  function nav(to: Tab) {
    setTab(to);
    setMenu(false);
    setError("");
  }
  const tabs = admin
    ? [
        { id: "overview", label: "Team overview", icon: Users },
        { id: "employees", label: "Employees", icon: Users },
        { id: "attendance", label: "Attendance", icon: CalendarDays },
        { id: "timesheets", label: "Timesheets", icon: ClipboardCheck },
        { id: "requests", label: "Requests & advances", icon: ClipboardCheck },
        { id: "payroll", label: "Payroll", icon: Wallet },
        { id: "qr", label: "Court QR & settings", icon: QrCode },
      ]
    : [
        { id: "overview", label: "My overview", icon: Users },
        { id: "attendance", label: "My attendance", icon: CalendarDays },
        { id: "requests", label: "My requests", icon: ClipboardCheck },
        { id: "payroll", label: "My payslips", icon: Wallet },
        { id: "pin", label: "Attendance PIN", icon: ShieldCheck },
      ];
  if (ws.mode !== "live" && ws.mode !== "demo") return <Login />;
  if (!admin && !employeeRole)
    return (
      <main className="account-page">
        <section className="account-card">
          <ShieldCheck size={36} />
          <h1>Employee records are private.</h1>
          <p>
            Your account does not have employee and payroll management
            permission.
          </p>
          <Link href="/" className="button primary">
            Open your workspace
          </Link>
          {canManage(ws.profile, "accounts") && (
            <Link href="/settings/" className="button secondary">
              Manage accounts
            </Link>
          )}
        </section>
      </main>
    );
  const editorBase = { employee };
  return (
    <div className="app-shell team-app">
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <Link href={admin ? "/team/" : "/employee/"} className="brand">
          <CourtMark size={40} />
          <span>
            THE GARDENS
            <small>{admin ? "People & payroll" : "Employee portal"}</small>
          </span>
        </Link>
        <div className="nav-label">{admin ? "YOUR TEAM" : "MY WORKSPACE"}</div>
        <nav aria-label="Employee navigation">
          {tabs.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`nav-item staff-nav ${tab === item.id ? "active" : ""}`}
                onClick={() => nav(item.id as Tab)}
                aria-current={tab === item.id ? "page" : undefined}
              >
                <Icon size={19} />
                {item.label}
              </button>
            );
          })}
          {canViewFinance(ws.profile) && (
            <Link className="nav-item" href="/">
              <ArrowLeft size={18} />
              Finance workspace
            </Link>
          )}
          {canManage(ws.profile, "accounts") && (
            <Link className="nav-item" href="/settings/">
              Accounts & permissions
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="split-note">
            <Clock size={21} />
            <strong>The daily shift</strong>
            <p>
              3:30 PM — 11:30 PM
              <br />
              ₱650 per complete shift
            </p>
            <small>
              Overtime · ₱81.25 / hour
              <br />
              Subject to Jeremy’s approval
            </small>
          </div>
          <div className="sidebar-profile">
            <span className="avatar">
              {ws.profile?.display_name.slice(0, 1)}
            </span>
            <span>
              <strong>{ws.profile?.display_name}</strong>
              <small>{admin ? "Workspace admin" : "Employee access"}</small>
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={() =>
                void ws.signOut().catch((err) => setError(err.message))
              }
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="menu-button icon-button"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={22} />
            </button>
            <span>The Gardens</span>
            <strong>{admin ? "People & payroll" : "Employee portal"}</strong>
          </div>
          <span className="role-tag">{admin ? "Admin" : "Employee"}</span>
        </header>
        {ws.mode === "demo" && (
          <div className="demo-banner">
            <span>
              <strong>Sample workspace.</strong> Fictional employee records; no
              invitations or real payments.
            </span>
            <div>
              <button
                onClick={() => ws.previewRole(admin ? "employee" : "admin")}
              >
                Preview {admin ? "employee" : "Jeremy"} view
              </button>
              <button onClick={() => void ws.signOut()}>Back to sign in</button>
            </div>
          </div>
        )}
        <main className="main-content" id="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {admin ? "PEOPLE BEHIND THE COURT" : "YOUR DAILY RECORD"}
              </span>
              <h1>
                {tab === "scan"
                  ? "Court attendance"
                  : admin
                    ? tabs.find((t) => t.id === tab)?.label
                    : `Hello, ${employee?.name.split(" ")[0] || ws.profile?.display_name}.`}
              </h1>
              <p>
                {admin
                  ? "Attendance, requests, and salaries, kept together."
                  : "Your attendance, requests, and pay in one place."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="button secondary"
                disabled={busy || team.loading}
                onClick={() => void team.refresh()}
              >
                <RefreshCw size={16} />
                Refresh
              </button>
              {!admin && (
                <button
                  className="button secondary"
                  onClick={() => nav("pin")}
                  disabled={!employee?.active}
                >
                  <ShieldCheck size={17} />
                  Attendance PIN
                </button>
              )}
              {!admin && (
                <button
                  className="button primary"
                  onClick={() => setScanner(true)}
                  disabled={!employee?.active}
                >
                  <ScanLine size={18} />
                  Scan court QR
                </button>
              )}
              {admin && tab === "employees" && (
                <button
                  className="button primary"
                  onClick={() => setEditor({ action: "employee" })}
                >
                  <Plus size={18} />
                  Add employee
                </button>
              )}
            </div>
          </div>
          {(error || team.error) && (
            <div className="error-box" role="alert">
              {error || team.error}
            </div>
          )}
          {employee && !employee.active && (
            <p className="error-box">
              Your account is inactive. You can view your history; contact
              Jeremy for attendance or request changes.
            </p>
          )}
          {team.loading ? (
            <Blank>Loading employee records…</Blank>
          ) : (
            <>
              {tab !== "employees" &&
                tab !== "qr" &&
                tab !== "scan" &&
                tab !== "timesheets" &&
                tab !== "pin" && (
                  <section className="staff-controls">
                    <label className="field">
                      <span>Payroll period</span>
                      <input
                        type="date"
                        aria-label="Payroll period reference"
                        value={period}
                        onChange={(event) => {
                          if (event.target.value)
                            setPeriod(employeePeriod(event.target.value));
                        }}
                      />
                    </label>
                    <span>
                      {displayDate(period)} — {displayDate(payrollEnd(period))}
                    </span>
                    {admin && (
                      <label className="field">
                        <span>Employee</span>
                        <select
                          aria-label="Select employee"
                          value={eid}
                          onChange={(event) => setSelected(event.target.value)}
                        >
                          {!people.length && (
                            <option value="">No employees yet</option>
                          )}
                          {people.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.name}
                              {!e.active ? " · inactive" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </section>
                )}
              {tab === "overview" && (
                <>
                  <div className="stats-grid">
                    <Metric
                      label={admin ? "Team members" : "Estimated earnings"}
                      value={
                        admin
                          ? String(
                              data.employees.filter((e) => e.active).length,
                            )
                          : money(report?.gross_cents || 0)
                      }
                      note={
                        admin
                          ? `${unlinked} accounts awaiting invitation`
                          : "Regular pay, approved overtime & paid leave"
                      }
                    />
                    <Metric
                      label={admin ? "Pending requests" : "Outstanding advance"}
                      value={
                        admin ? String(pending.length) : money(advanceBalance)
                      }
                      note={
                        admin
                          ? "Leave, sick leave & salary advances"
                          : "Recovered from your next finalized payroll"
                      }
                    />
                    <Metric
                      label={
                        admin ? "Selected salary payable" : "Attendance today"
                      }
                      value={
                        admin
                          ? money(report?.payable_cents || 0)
                          : open
                            ? "Timed in"
                            : "Not timed in"
                      }
                      note={
                        admin
                          ? "Estimated until this employee’s payroll is finalized"
                          : open
                            ? `Since ${timeInManila(open.clock_in)}`
                            : "Scan the printed QR at the court"
                      }
                    />
                  </div>
                  {!admin && (
                    <section className="panel staff-welcome">
                      <div>
                        <h2>Need to make a request?</h2>
                        <p>You can file a request without clocking in.</p>
                      </div>
                      <div className="staff-actions">
                        {(["leave", "sick", "advance"] as const).map((kind) => (
                          <button
                            key={kind}
                            className="button secondary"
                            disabled={!employee?.active}
                            onClick={() =>
                              setEditor({
                                ...editorBase,
                                action: "request",
                                requestKind: kind,
                              })
                            }
                          >
                            {kind === "leave"
                              ? "Leave request"
                              : kind === "sick"
                                ? "Sick leave"
                                : "Salary advance"}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                  {admin && !people.length ? (
                    <section className="panel">
                      <Blank>
                        Add your first employee, choose their workdays, then
                        send their invitation.
                      </Blank>
                      <div className="staff-panel-footer">
                        <button
                          className="button primary"
                          onClick={() => setEditor({ action: "employee" })}
                        >
                          Add employee
                        </button>
                      </div>
                    </section>
                  ) : (
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>{employee?.name} · this pay period</h2>
                          <p>
                            {statement
                              ? "Finalized payslip"
                              : "Live estimate · incomplete shifts and unapproved overtime are not payable yet"}
                          </p>
                        </div>
                        <button
                          className="text-button"
                          onClick={() => nav("payroll")}
                        >
                          View payroll →
                        </button>
                      </div>
                      <div className="staff-mini-grid">
                        <div>
                          <span>Regular pay after deductions</span>
                          <strong>{money(report?.regular_cents || 0)}</strong>
                        </div>
                        <div>
                          <span>Approved overtime</span>
                          <strong>{money(report?.ot_cents || 0)}</strong>
                        </div>
                        <div>
                          <span>Paid leave</span>
                          <strong>{money(report?.leave_cents || 0)}</strong>
                        </div>
                        <div>
                          <span>Missed-time deduction</span>
                          <strong>{money(report?.deduction_cents || 0)}</strong>
                        </div>
                      </div>
                      {report && report.blockers.length > 0 && !statement && (
                        <p className="staff-info">
                          {report.blockers.length} item(s) need attention before
                          payroll can be finalized.
                        </p>
                      )}
                    </section>
                  )}
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>Requests to follow up</h2>
                        <p>
                          {admin ? "Across your team" : "Your pending requests"}
                        </p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => nav("requests")}
                      >
                        View requests →
                      </button>
                    </div>
                    {!pending.length ? (
                      <Blank>No pending requests.</Blank>
                    ) : (
                      <div className="staff-list">
                        {pending
                          .filter((r) => admin || r.employee_id === eid)
                          .slice(0, 5)
                          .map((r) => (
                            <div key={r.id}>
                              <span>
                                <strong>
                                  {
                                    data.employees.find(
                                      (e) => e.id === r.employee_id,
                                    )?.name
                                  }
                                </strong>
                                <small>
                                  {r.kind === "advance"
                                    ? `Salary advance · ${money(r.amount_cents || 0)}`
                                    : `${r.kind === "sick" ? "Sick leave" : "Leave"} · ${r.start_date} to ${r.end_date}`}
                                </small>
                              </span>
                              {admin ? (
                                <button
                                  className="button secondary compact"
                                  onClick={() =>
                                    setEditor({ action: "decide", request: r })
                                  }
                                >
                                  Review
                                </button>
                              ) : (
                                <Tag>pending</Tag>
                              )}
                            </div>
                          ))}
                      </div>
                    )}
                  </section>
                </>
              )}
              {tab === "timesheets" && admin && (
                <TimesheetsPanel data={data} period={period} employeeId={eid} />
              )}
              {tab === "pin" && employeeRole && employee && (
                <EmployeePinPanel
                  employee={employee}
                  onSaved={team.refresh}
                  court={court}
                />
              )}
              {tab === "employees" && admin && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Employee register</h2>
                      <p>
                        Default pay: ₱650 · 3:30–11:30 PM. Workdays are
                        individual.
                      </p>
                    </div>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Employee</th>
                          <th>Workdays</th>
                          <th>Employment</th>
                          <th>Account</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {people.map((e) => {
                          const schedule = data.schedules
                            .filter(
                              (s) =>
                                s.employee_id === e.id &&
                                s.effective_from <= todayInManila(),
                            )
                            .sort((a, b) =>
                              b.effective_from.localeCompare(a.effective_from),
                            )[0];
                          return (
                            <tr key={e.id}>
                              <td>
                                <div className="cell-stack">
                                  <strong>{e.name}</strong>
                                  <small>{e.email}</small>
                                  <small>
                                    {e.employee_code ||
                                      "Code assigned on live registration"}{" "}
                                    ·{" "}
                                    {e.pin_configured
                                      ? "PIN ready"
                                      : "PIN setup needed"}
                                  </small>
                                </div>
                              </td>
                              <td>
                                {schedule?.weekdays
                                  .map(
                                    (d) =>
                                      [
                                        "Sun",
                                        "Mon",
                                        "Tue",
                                        "Wed",
                                        "Thu",
                                        "Fri",
                                        "Sat",
                                      ][d],
                                  )
                                  .join(", ") || "No workdays"}
                                <small className="staff-block">
                                  {schedule &&
                                    `From ${schedule.effective_from}`}
                                </small>
                              </td>
                              <td>
                                <Tag>{e.active ? "Active" : "Inactive"}</Tag>
                                <small className="staff-block">
                                  Since {e.started_on}
                                  {e.ended_on && ` · ended ${e.ended_on}`}
                                </small>
                              </td>
                              <td>
                                {e.profile_id ? "Linked" : "Invitation needed"}
                              </td>
                              <td>
                                <div className="staff-actions">
                                  <button
                                    className="button secondary compact"
                                    onClick={() =>
                                      setEditor({
                                        action: "employee",
                                        employee: e,
                                        schedule,
                                      })
                                    }
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="button secondary compact"
                                    disabled={
                                      busy ||
                                      !e.active ||
                                      !canManage(ws.profile, "accounts")
                                    }
                                    title={
                                      !canManage(ws.profile, "accounts")
                                        ? "Account management permission is required to send invitations."
                                        : undefined
                                    }
                                    onClick={() => void invite(e.id)}
                                  >
                                    Invite / resend
                                  </button>
                                  <button
                                    className="text-button"
                                    onClick={() => {
                                      setSelected(e.id);
                                      nav("attendance");
                                    }}
                                  >
                                    Attendance
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {!people.length && (
                      <Blank>
                        No employees yet. Add a person to get started.
                      </Blank>
                    )}
                  </div>
                </section>
              )}
              {(tab === "attendance" || tab === "payroll") &&
                (!employee ? (
                  <Blank>Select or add an employee first.</Blank>
                ) : payLoading && !report ? (
                  <Blank>Calculating this payroll period…</Blank>
                ) : (
                  report && (
                    <>
                      {tab === "payroll" && (
                        <>
                          <div className="stats-grid">
                            <Metric
                              label="Earned this period"
                              value={money(report.gross_cents)}
                              note={
                                statement
                                  ? "Finalized earnings"
                                  : "Estimate · approvals may change this amount"
                              }
                            />
                            <Metric
                              label="Advance recovery"
                              value={money(report.recovery_cents)}
                              note={`Current outstanding advance: ${money(advanceBalance)}`}
                            />
                            <Metric
                              label={
                                statement
                                  ? "Salary still unpaid"
                                  : "Salary payable"
                              }
                              value={money(
                                statement
                                  ? Math.max(0, statement.payable_cents - paid)
                                  : report.payable_cents,
                              )}
                              note={
                                statement
                                  ? `${money(paid)} paid so far`
                                  : "Cash payment is recorded separately"
                              }
                            />
                          </div>
                          <section className="panel">
                            <div className="panel-heading">
                              <div>
                                <h2>
                                  {statement
                                    ? "Finalized payslip"
                                    : "Payroll preview"}
                                </h2>
                                <p>
                                  {employee.name} · {period} to{" "}
                                  {report.period_end}
                                </p>
                              </div>
                              <div className="staff-actions">
                                <button
                                  className="button secondary compact"
                                  onClick={exportPayroll}
                                >
                                  <Download size={15} />
                                  Export CSV
                                </button>
                                {admin && !statement && (
                                  <button
                                    className="button primary compact"
                                    disabled={
                                      busy || report.blockers.length > 0
                                    }
                                    onClick={() =>
                                      setEditor({
                                        ...editorBase,
                                        action: "finalize",
                                        period,
                                        preview: report,
                                      })
                                    }
                                  >
                                    Finalize payroll
                                  </button>
                                )}
                                {admin &&
                                  statement &&
                                  statement.payable_cents > paid && (
                                    <button
                                      className="button primary compact"
                                      onClick={() =>
                                        setEditor({
                                          ...editorBase,
                                          action: "pay",
                                          payroll: statement,
                                          remaining:
                                            statement.payable_cents - paid,
                                        })
                                      }
                                    >
                                      Record salary payment
                                    </button>
                                  )}
                              </div>
                            </div>
                            <div className="staff-mini-grid">
                              <div>
                                <span>Regular pay after deductions</span>
                                <strong>{money(report.regular_cents)}</strong>
                              </div>
                              <div>
                                <span>Missed-time deduction</span>
                                <strong>{money(report.deduction_cents)}</strong>
                              </div>
                              <div>
                                <span>Approved overtime</span>
                                <strong>{money(report.ot_cents)}</strong>
                              </div>
                              <div>
                                <span>Paid leave</span>
                                <strong>{money(report.leave_cents)}</strong>
                              </div>
                            </div>
                            {statement ? (
                              <p className="staff-info">
                                Finalized{" "}
                                {new Date(
                                  statement.finalized_at,
                                ).toLocaleString("en-PH", {
                                  timeZone: "Asia/Manila",
                                })}
                                . Attendance and advance allocations are
                                preserved in this statement.
                              </p>
                            ) : (
                              report.blockers.length > 0 && (
                                <details className="staff-blockers" open>
                                  <summary>
                                    {report.blockers.length} items to resolve
                                    before finalizing
                                  </summary>
                                  <ul>
                                    {report.blockers.map((b, i) => (
                                      <li key={i}>{b}</li>
                                    ))}
                                  </ul>
                                </details>
                              )
                            )}
                          </section>
                        </>
                      )}
                      <section className="panel">
                        <div className="panel-heading">
                          <div>
                            <h2>Daily attendance & pay</h2>
                            <p className="attendance-counts">
                              Present{" "}
                              {
                                report.days.filter((d) =>
                                  [
                                    "Present",
                                    "Late",
                                    "Undertime",
                                    "Late / undertime",
                                  ].includes(d.status),
                                ).length
                              }{" "}
                              · Late{" "}
                              {
                                report.days.filter((d) =>
                                  d.status.includes("Late"),
                                ).length
                              }{" "}
                              · Absent{" "}
                              {
                                report.days.filter((d) => d.status === "Absent")
                                  .length
                              }{" "}
                              · Leave{" "}
                              {
                                report.days.filter((d) =>
                                  d.status.startsWith("Leave"),
                                ).length
                              }{" "}
                              · Sick{" "}
                              {
                                report.days.filter((d) =>
                                  d.status.startsWith("Sick"),
                                ).length
                              }
                            </p>
                            <p>
                              All times in Manila · no early-arrival overtime
                            </p>
                          </div>
                          {admin && !statement && (
                            <div className="staff-actions">
                              <button
                                className="button secondary compact"
                                onClick={() =>
                                  setEditor({
                                    ...editorBase,
                                    action: "correct",
                                  })
                                }
                              >
                                Add missed punch
                              </button>
                              <button
                                className="button secondary compact"
                                onClick={() =>
                                  setEditor({
                                    ...editorBase,
                                    action: "override",
                                  })
                                }
                              >
                                Workday override
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Work date</th>
                                <th>Time in / out</th>
                                <th>Status</th>
                                <th>Missed time</th>
                                <th>Overtime</th>
                                <th className="number">Earned</th>
                                {admin && <th>Actions</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {report.days.map((d) => (
                                <tr key={d.date}>
                                  <td>{displayDate(d.date)}</td>
                                  <td>
                                    <div className="cell-stack">
                                      <span>{timeInManila(d.clock_in)}</span>
                                      <small>
                                        {timeInManila(d.clock_out)}
                                        {d.clock_out &&
                                        new Date(
                                          d.clock_out,
                                        ).toLocaleDateString("en-CA", {
                                          timeZone: "Asia/Manila",
                                        }) !==
                                          new Date(
                                            `${d.date}T12:00:00+08:00`,
                                          ).toLocaleDateString("en-CA", {
                                            timeZone: "Asia/Manila",
                                          })
                                          ? " · next day"
                                          : ""}
                                      </small>
                                    </div>
                                  </td>
                                  <td>
                                    <Tag>{d.status}</Tag>
                                  </td>
                                  <td>
                                    {duration(
                                      d.status === "Absent"
                                        ? 28800
                                        : Math.min(
                                            28800,
                                            d.late_seconds +
                                              d.undertime_seconds,
                                          ),
                                    )}
                                  </td>
                                  <td>
                                    {duration(d.overtime_seconds)}
                                    {d.overtime_seconds > 0 && (
                                      <small className="staff-block">
                                        {d.ot_reviewed
                                          ? `${duration(d.approved_ot_seconds)} approved`
                                          : "Needs approval"}
                                      </small>
                                    )}
                                  </td>
                                  <td className="number">
                                    <strong>{money(d.total_cents)}</strong>
                                  </td>
                                  {admin && (
                                    <td>
                                      {!statement && (
                                        <div className="staff-actions">
                                          <button
                                            className="text-button"
                                            onClick={() =>
                                              setEditor({
                                                ...editorBase,
                                                action: "correct",
                                                day: d,
                                              })
                                            }
                                          >
                                            {d.attendance_id
                                              ? "Correct"
                                              : "Add punch"}
                                          </button>
                                          <button
                                            className="text-button"
                                            onClick={() =>
                                              setEditor({
                                                ...editorBase,
                                                action: "override",
                                                day: d,
                                              })
                                            }
                                          >
                                            Schedule
                                          </button>
                                          {d.overtime_seconds > 0 && (
                                            <button
                                              className="button secondary compact"
                                              onClick={() =>
                                                setEditor({
                                                  ...editorBase,
                                                  action: "overtime",
                                                  day: d,
                                                })
                                              }
                                            >
                                              Review OT
                                            </button>
                                          )}
                                          {d.attendance_id && (
                                            <button
                                              className="text-button negative"
                                              onClick={() =>
                                                setEditor({
                                                  ...editorBase,
                                                  action: "void",
                                                  day: d,
                                                })
                                              }
                                            >
                                              Void
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </section>
                      {tab === "payroll" && (
                        <section className="panel">
                          <div className="panel-heading">
                            <div>
                              <h2>Payslip history</h2>
                              <p>Finalized statements for {employee.name}</p>
                            </div>
                          </div>
                          <div className="staff-list">
                            {data.payroll
                              .filter((p) => p.employee_id === eid)
                              .sort((a, b) =>
                                b.period_start.localeCompare(a.period_start),
                              )
                              .map((p) => (
                                <div key={p.id}>
                                  <span>
                                    <strong>
                                      {p.period_start} — {p.period_end}
                                    </strong>
                                    <small>
                                      Salary payable {money(p.payable_cents)}
                                    </small>
                                  </span>
                                  <button
                                    className="button secondary compact"
                                    onClick={() => setPeriod(p.period_start)}
                                  >
                                    Open payslip
                                  </button>
                                </div>
                              ))}
                            {!data.payroll.some(
                              (p) => p.employee_id === eid,
                            ) && <Blank>No finalized payslips yet.</Blank>}
                          </div>
                        </section>
                      )}
                      {tab === "payroll" && (
                        <section className="panel">
                          <div className="panel-heading">
                            <div>
                              <h2>Salary payment history</h2>
                              <p>
                                Only actual payments create business expenses
                              </p>
                            </div>
                          </div>
                          <div className="staff-list">
                            {data.cash
                              .filter(
                                (c) =>
                                  c.payroll_id === statement?.id &&
                                  c.kind === "salary",
                              )
                              .map((c) => (
                                <div key={c.id}>
                                  <span>
                                    <strong>{money(c.amount_cents)}</strong>
                                    <small>
                                      {displayDate(c.paid_on)} ·{" "}
                                      {c.reference || "No reference"}
                                    </small>
                                  </span>
                                  <Tag>Paid</Tag>
                                </div>
                              ))}
                            {(!statement ||
                              !data.cash.some(
                                (c) => c.payroll_id === statement.id,
                              )) && (
                              <Blank>
                                No salary payments recorded for this period.
                              </Blank>
                            )}
                          </div>
                        </section>
                      )}
                    </>
                  )
                ))}
              {tab === "requests" && (
                <>
                  <div className="section-heading">
                    <div>
                      <h2>{admin ? "Team requests" : "My requests"}</h2>
                      <p>
                        Approvals and actual cash releases are tracked
                        separately.
                      </p>
                    </div>
                    {admin ? (
                      <label className="team-check">
                        <input
                          type="checkbox"
                          checked={allRequests}
                          onChange={(event) =>
                            setAllRequests(event.target.checked)
                          }
                        />
                        Show all employees
                      </label>
                    ) : (
                      <button
                        className="button primary"
                        disabled={!employee?.active}
                        onClick={() =>
                          setEditor({ ...editorBase, action: "request" })
                        }
                      >
                        <Plus size={17} />
                        New request
                      </button>
                    )}
                  </div>
                  <section className="panel">
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Employee / type</th>
                            <th>Dates / amount</th>
                            <th>Reason / decision</th>
                            <th>Status</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {requests.map((r) => {
                            const released = data.cash
                              .filter((c) => c.request_id === r.id)
                              .reduce((n, c) => n + c.amount_cents, 0);
                            const remaining = (r.amount_cents || 0) - released;
                            return (
                              <tr key={r.id}>
                                <td>
                                  <div className="cell-stack">
                                    <strong>
                                      {
                                        data.employees.find(
                                          (e) => e.id === r.employee_id,
                                        )?.name
                                      }
                                    </strong>
                                    <small>
                                      {r.kind === "advance"
                                        ? "Salary advance"
                                        : r.kind === "sick"
                                          ? "Sick leave"
                                          : "Leave"}
                                    </small>
                                  </div>
                                </td>
                                <td>
                                  {r.kind === "advance" ? (
                                    <div className="cell-stack">
                                      <strong>
                                        {money(r.amount_cents || 0)}
                                      </strong>
                                      <small>{money(released)} released</small>
                                    </div>
                                  ) : (
                                    <div className="cell-stack">
                                      <span>
                                        {r.start_date} — {r.end_date}
                                      </span>
                                      {r.status === "approved" && (
                                        <small>
                                          {r.paid_leave
                                            ? "Paid leave"
                                            : "Unpaid leave"}
                                        </small>
                                      )}
                                    </div>
                                  )}
                                </td>
                                <td>
                                  <div className="cell-stack">
                                    <span>{r.reason}</span>
                                    <small>{r.decision_note}</small>
                                  </div>
                                </td>
                                <td>
                                  <Tag>{r.status}</Tag>
                                </td>
                                <td>
                                  {admin ? (
                                    <div className="staff-actions">
                                      {r.status === "pending" && (
                                        <button
                                          className="button secondary compact"
                                          onClick={() =>
                                            setEditor({
                                              action: "decide",
                                              request: r,
                                            })
                                          }
                                        >
                                          Review
                                        </button>
                                      )}
                                      {r.status === "approved" &&
                                        r.kind === "advance" &&
                                        remaining > 0 && (
                                          <button
                                            className="button primary compact"
                                            onClick={() =>
                                              setEditor({
                                                action: "release",
                                                request: r,
                                                remaining,
                                                employee: data.employees.find(
                                                  (e) => e.id === r.employee_id,
                                                ),
                                              })
                                            }
                                          >
                                            Release cash
                                          </button>
                                        )}
                                      {r.status === "approved" &&
                                        r.kind !== "advance" && (
                                          <button
                                            className="text-button"
                                            onClick={() =>
                                              setEditor({
                                                action: "cancel_leave",
                                                request: r,
                                              })
                                            }
                                          >
                                            Cancel leave
                                          </button>
                                        )}
                                    </div>
                                  ) : (
                                    r.status === "pending" && (
                                      <button
                                        className="button secondary compact"
                                        disabled={busy}
                                        onClick={() =>
                                          void quick(
                                            "withdraw",
                                            { request_id: r.id },
                                            "Request withdrawn.",
                                          )
                                        }
                                      >
                                        Withdraw
                                      </button>
                                    )
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {!requests.length && <Blank>No requests recorded.</Blank>}
                    </div>
                  </section>
                  <section className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>{employee?.name} · advance balance</h2>
                        <p>
                          {money(advanceBalance)} outstanding · recovery happens
                          when payroll is finalized
                        </p>
                      </div>
                    </div>
                    <div className="staff-list">
                      {data.cash
                        .filter(
                          (c) => c.employee_id === eid && c.kind === "advance",
                        )
                        .map((c) => {
                          const recovered = data.recoveries
                            .filter((r) => r.cash_id === c.id)
                            .reduce((n, r) => n + r.amount_cents, 0);
                          return (
                            <div key={c.id}>
                              <span>
                                <strong>
                                  {money(c.amount_cents)} released
                                </strong>
                                <small>
                                  {displayDate(c.paid_on)} ·{" "}
                                  {c.reference || "No reference"}
                                </small>
                              </span>
                              <span>
                                {money(recovered)} recovered
                                <br />
                                <small>
                                  {money(c.amount_cents - recovered)} remaining
                                </small>
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </section>
                </>
              )}
              {tab === "scan" && (
                <section className="panel staff-scan-menu">
                  <ScanLine size={36} />
                  <h2>
                    {employeeRole
                      ? "Court QR scanned."
                      : "Use your employee account"}
                  </h2>
                  <p>
                    {employeeRole
                      ? "Choose an action. Filing a request does not record attendance."
                      : "Jeremy manages the team from the admin workspace. Employees sign in with their own email to use attendance."}
                  </p>
                  {employeeRole && (
                    <>
                      <div className="staff-clock-status">
                        <Tag>
                          {open ? "Currently timed in" : "Currently timed out"}
                        </Tag>
                        {open && (
                          <span>Since {timeInManila(open.clock_in)}</span>
                        )}
                      </div>
                      <button
                        className="button primary staff-clock-button"
                        disabled={busy || !court || !employee?.active}
                        onClick={() => void clock()}
                      >
                        <Clock size={20} />
                        {busy ? "Recording…" : open ? "Time Out" : "Time In"}
                      </button>
                      {!court && (
                        <p className="error-box">
                          Scan the printed court QR to record attendance.
                        </p>
                      )}
                      <div className="staff-actions">
                        {(["leave", "sick", "advance"] as const).map((kind) => (
                          <button
                            key={kind}
                            className="button secondary"
                            disabled={!employee?.active}
                            onClick={() =>
                              setEditor({
                                ...editorBase,
                                action: "request",
                                requestKind: kind,
                              })
                            }
                          >
                            {kind === "leave"
                              ? "Leave request"
                              : kind === "sick"
                                ? "Sick leave"
                                : "Salary advance"}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )}
              {tab === "qr" && admin && (
                <>
                  <section className="court-qr-sheet panel">
                    <CourtMark size={42} />
                    <span className="eyebrow">
                      THE GARDENS · EMPLOYEE ATTENDANCE
                    </span>
                    <h2>Scan here. Choose your action.</h2>
                    <p>
                      Enter your employee code and private six-digit PIN, then
                      choose Time In or Time Out. Use employee sign-in for
                      requests.
                    </p>
                    {svg ? (
                      <img
                        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
                        alt="The Gardens employee attendance court QR"
                        width={360}
                        height={360}
                      />
                    ) : (
                      <Blank>Create your first court QR.</Blank>
                    )}
                    <strong>3:30 PM — 11:30 PM · Asia/Manila</strong>
                    <small>
                      Set your PIN once in your employee account. Email sign-in
                      is also available. Scanning alone never records
                      attendance.
                    </small>
                    <div className="staff-actions qr-actions">
                      <button
                        className="button primary"
                        onClick={() => setEditor({ action: "qr" })}
                      >
                        {data.qr ? "Replace QR" : "Create court QR"}
                      </button>
                      {svg && (
                        <>
                          <button
                            className="button secondary"
                            onClick={() =>
                              download(
                                svg,
                                "image/svg+xml",
                                "The Gardens - Attendance QR.svg",
                              )
                            }
                          >
                            <Download size={16} />
                            Download QR
                          </button>
                          <button
                            className="button secondary"
                            onClick={() => window.print()}
                          >
                            <Printer size={16} />
                            Print QR
                          </button>
                        </>
                      )}
                    </div>
                  </section>
                  <section className="panel staff-welcome">
                    <div>
                      <h2>Wages expense category</h2>
                      <p>
                        Actual advance releases and salary payments create one
                        expense in this category.
                      </p>
                    </div>
                    <label className="field">
                      <span>Expense category</span>
                      <select
                        disabled={!canViewFinance(ws.profile)}
                        value={
                          data.settings?.wages_category_id ||
                          ws.data.categories.find(
                            (c) => c.name === "Wages" && c.kind === "expense",
                          )?.id ||
                          ""
                        }
                        onChange={(event) =>
                          void quick("settings", {
                            category_id: event.target.value,
                          })
                        }
                      >
                        {!canViewFinance(ws.profile) && (
                          <option
                            value={data.settings?.wages_category_id || ""}
                          >
                            Assigned wages category · managed by finance
                          </option>
                        )}
                        {ws.data.categories
                          .filter(
                            (c) =>
                              c.kind === "expense" &&
                              (c.active ||
                                c.id === data.settings?.wages_category_id),
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </section>
                </>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>THE GARDENS · Philippine pesos · Asia/Manila</span>
            <span>
              {ws.mode === "demo"
                ? "Fictional samples"
                : admin
                  ? "Private employee records"
                  : "Only your own records"}
            </span>
          </footer>
        </main>
      </div>
      {editor && (
        <TeamDialog
          editor={editor}
          onClose={() => setEditor(null)}
          onSubmit={async (action, payload) => {
            await run(
              action,
              payload,
              action === "finalize"
                ? "Payroll finalized. No cash payment recorded."
                : action === "qr"
                  ? "New QR created. Print the replacement."
                  : "Record saved.",
            );
          }}
        />
      )}
      {scanner && <CourtScanner onClose={() => setScanner(false)} />}
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
