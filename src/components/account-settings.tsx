"use client";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Plus, RefreshCw, ShieldCheck, Users } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { getBackend } from "@/lib/backend";
import { canManage, canViewFinance, accountInput } from "@/lib/access";
import type { Profile } from "@/lib/types";

type Account = Profile & { email: string };
type Registered = {
  id: string;
  name: string;
  email: string;
  profile_id: string | null;
  active: boolean;
};
const store = "gardens.accounts.sample.v1";
const samples = (): Account[] => [
  {
    id: "sample-jeremy",
    display_name: "Jeremy",
    email: "jeremy@example.invalid",
    role: "admin",
    active: true,
    is_owner: true,
    finance_access: true,
    team_access: true,
    manage_accounts: true,
  },
  {
    id: "sample-genesis",
    display_name: "Genesis",
    email: "genesis@example.invalid",
    role: "viewer",
    active: true,
    finance_access: true,
    team_access: false,
    manage_accounts: false,
  },
  {
    id: "sample-ken",
    display_name: "Ken",
    email: "ken@example.invalid",
    role: "viewer",
    active: true,
    finance_access: true,
    team_access: false,
    manage_accounts: false,
  },
  {
    id: "sample-staff",
    display_name: "Alex Reyes",
    email: "alex@example.invalid",
    role: "employee",
    active: true,
    finance_access: false,
    team_access: false,
    manage_accounts: false,
  },
];
export function AccountSettings() {
  const ws = useWorkspace(),
    allowed = canManage(ws.profile, "accounts");
  const [accounts, setAccounts] = useState<Account[]>([]),
    [employees, setEmployees] = useState<Registered[]>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<Account | "new" | null>(null),
    [role, setRole] = useState("admin"),
    [inviteEmployee, setInviteEmployee] = useState("");
  const refresh = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    try {
      if (ws.mode === "demo") {
        let rows = samples();
        try {
          const saved = JSON.parse(localStorage.getItem(store) || "null");
          if (Array.isArray(saved)) rows = saved;
        } catch {}
        setAccounts(rows);
        setEmployees([
          {
            id: "sample-sam",
            name: "Sam Santos",
            email: "sam@example.invalid",
            profile_id: null,
            active: true,
          },
        ]);
      } else {
        const session = await getBackend()!.auth.getSession();
        const result = await fetch("/api/accounts/", {
          headers: {
            Authorization: `Bearer ${session.data.session?.access_token || ""}`,
          },
          cache: "no-store",
        });
        const data = await result.json();
        if (!result.ok) throw Error(data.message);
        setAccounts(data.accounts);
        setEmployees(data.employees);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load accounts.");
    } finally {
      setLoading(false);
    }
  }, [allowed, ws.mode]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const reset = () => {
      setAccounts(samples());
      setEditor(null);
    };
    window.addEventListener("gardens-demo-reset", reset);
    return () => window.removeEventListener("gardens-demo-reset", reset);
  }, []);
  if (!allowed) return null;
  const editable = (a: Account) =>
    !a.is_owner &&
    a.id !== ws.profile?.id &&
    (ws.profile?.is_owner ||
      ((!(a.role === "viewer" || (a.role === "admin" && a.finance_access)) ||
        canManage(ws.profile, "finance")) &&
        (!(a.role === "admin" && a.team_access) ||
          canManage(ws.profile, "team")) &&
        (!(a.role === "admin" && a.manage_accounts) ||
          canManage(ws.profile, "accounts"))));
  async function submit(values: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (ws.mode === "demo") {
        let next = accounts;
        if (values.action === "create") {
          const input = accountInput(values);
          if (accounts.some((a) => a.email === input.email))
            throw Error("This account already exists.");
          next = [...accounts, { ...input, id: crypto.randomUUID() }];
        }
        if (values.action === "update")
          next = accounts.map((a) =>
            a.id === values.id ? ({ ...a, ...values } as Account) : a,
          );
        if (values.action === "invite_employee") {
          const e = employees.find((e) => e.id === values.employee_id);
          if (e && !accounts.some((a) => a.email === e.email))
            next = [
              ...accounts,
              {
                id: crypto.randomUUID(),
                display_name: e.name,
                email: e.email,
                role: "employee",
                active: true,
                finance_access: false,
                team_access: false,
                manage_accounts: false,
              },
            ];
        }
        localStorage.setItem(store, JSON.stringify(next));
        setAccounts(next);
        setNotice(
          "Sample updated. No real account was created and no email was sent.",
        );
      } else {
        const session = await getBackend()!.auth.getSession();
        const response = await fetch("/api/accounts/", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.data.session?.access_token || ""}`,
          },
          body: JSON.stringify(values),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.message);
        setNotice(data.message);
        await refresh();
      }
      setEditor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save account.");
      if (ws.mode === "live") await refresh();
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      current = editor && editor !== "new" ? editor : null;
    void submit({
      action: current ? "update" : "create",
      id: current?.id,
      display_name: form.get("display_name"),
      email: current?.email || form.get("email"),
      role: current?.role === "employee" ? "employee" : role,
      finance_access: form.has("finance_access"),
      team_access: form.has("team_access"),
      manage_accounts: form.has("manage_accounts"),
      active: form.has("active"),
    });
  }
  const current = editor && editor !== "new" ? editor : null;
  return (
    <section
      className="panel settings-panel account-settings"
      aria-labelledby="accounts-title"
    >
      <div className="panel-heading">
        <div>
          <h2 id="accounts-title">Accounts & permissions</h2>
          <p>Invite people, choose their access, and disable accounts.</p>
        </div>
        <div className="account-actions">
          <button
            className="button secondary compact"
            onClick={() => {
              setError("");
              void refresh();
            }}
            disabled={busy || loading}
          >
            <RefreshCw size={14} />
            Refresh accounts
          </button>
          <button
            className="button primary compact"
            onClick={() => {
              setEditor("new");
              setRole("admin");
              setError("");
            }}
            disabled={busy}
          >
            <Plus size={15} />
            Create account
          </button>
        </div>
      </div>
      <p className="account-note">
        <ShieldCheck size={17} />
        The owner is protected. Admins can grant and manage only permissions
        within their own access. Employees see their own records; finance
        viewers cannot access private employee records.
      </p>
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
      {editor && (
        <form
          className="account-editor"
          onSubmit={save}
          key={typeof editor === "string" ? editor : editor.id}
        >
          <h3>
            {current
              ? `Edit ${current.display_name}`
              : "Create an administrator or finance viewer"}
          </h3>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input
                name="display_name"
                required
                maxLength={100}
                defaultValue={current?.display_name || ""}
                readOnly={current?.role === "employee"}
              />
            </label>
            <label className="field">
              <span>Email address</span>
              <input
                name="email"
                type="email"
                required
                defaultValue={current?.email || ""}
                readOnly={!!current}
              />
              <small>New users receive a secure password setup email.</small>
            </label>
            {current?.role !== "employee" && (
              <label className="field">
                <span>Account role</span>
                <select value={role} onChange={(e) => setRole(e.target.value)}>
                  <option value="admin">Administrator</option>
                  <option
                    value="viewer"
                    disabled={!canManage(ws.profile, "finance")}
                  >
                    Finance viewer · read only
                  </option>
                </select>
              </label>
            )}
            <label className="account-check">
              <input
                type="checkbox"
                name="active"
                defaultChecked={current?.active !== false}
              />
              Account enabled
            </label>
          </div>
          {role === "admin" && current?.role !== "employee" && (
            <fieldset className="account-permissions">
              <legend>Administrator permissions</legend>
              <label className="account-check">
                <input
                  type="checkbox"
                  name="finance_access"
                  defaultChecked={
                    current?.finance_access ?? canManage(ws.profile, "finance")
                  }
                  disabled={!canManage(ws.profile, "finance")}
                />
                Finance management{" "}
                <small>Income, expenses, owner payouts, and categories</small>
              </label>
              <label className="account-check">
                <input
                  type="checkbox"
                  name="team_access"
                  defaultChecked={current?.team_access || false}
                  disabled={!canManage(ws.profile, "team")}
                />
                Employees & payroll{" "}
                <small>Attendance, requests, salaries, and court QR</small>
              </label>
              <label className="account-check">
                <input
                  type="checkbox"
                  name="manage_accounts"
                  defaultChecked={current?.manage_accounts || false}
                />
                Account management{" "}
                <small>
                  Invite users and manage access within these limits
                </small>
              </label>
            </fieldset>
          )}
          {current?.role === "employee" && (
            <p>
              Employee access is limited to their own attendance, requests,
              payslips, and advances. Employment details and workdays are
              managed in Employees & payroll.
            </p>
          )}
          <div className="account-actions">
            <button className="button primary" disabled={busy}>
              {busy
                ? "Saving…"
                : current
                  ? "Save account permissions"
                  : "Create & send setup email"}
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => setEditor(null)}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Role & permissions</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.display_name}</strong>
                  <small className="account-block">{a.email}</small>
                </td>
                <td>
                  {a.is_owner
                    ? "Owner · all permissions"
                    : a.role === "employee"
                      ? "Employee · own records"
                      : a.role === "viewer"
                        ? "Finance viewer · read only"
                        : [
                            a.finance_access && "Finance",
                            a.team_access && "Employees & payroll",
                            a.manage_accounts && "Account management",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                </td>
                <td>
                  <span
                    className={`badge ${a.active !== false ? "success" : "neutral"}`}
                  >
                    {a.active !== false ? "Enabled" : "Disabled"}
                  </span>
                </td>
                <td>
                  {editable(a) ? (
                    <div className="account-actions">
                      <button
                        className="button secondary compact"
                        disabled={busy}
                        onClick={() => {
                          setEditor(a);
                          setRole(a.role);
                          setError("");
                        }}
                      >
                        Edit permissions
                      </button>
                      <button
                        className="text-button"
                        disabled={busy || a.active === false}
                        onClick={() =>
                          void submit({ action: "resend", id: a.id })
                        }
                      >
                        Resend setup email
                      </button>
                    </div>
                  ) : (
                    <span className="muted">
                      {a.is_owner
                        ? "Protected owner"
                        : a.id === ws.profile?.id
                          ? "Your account · protected"
                          : "Outside your permission limits"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="empty-inline">Loading accounts…</p>}
      </div>
      <div className="account-invite">
        <h3>
          <Users size={18} />
          Employee accounts
        </h3>
        <p>
          Register an employee’s details and workdays in{" "}
          {canManage(ws.profile, "team") ? (
            <Link href="/team/" className="text-button">
              Employees & payroll
            </Link>
          ) : (
            "Employees & payroll with a staff manager"
          )}
          , then invite them here. They choose their own password.
        </p>
        <div className="account-actions">
          <select
            aria-label="Registered employee to invite"
            value={inviteEmployee}
            onChange={(e) => setInviteEmployee(e.target.value)}
          >
            <option value="">Choose a registered employee</option>
            {employees
              .filter((e) => e.active)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.email}
                </option>
              ))}
          </select>
          <button
            className="button secondary"
            disabled={!inviteEmployee || busy}
            onClick={() =>
              void submit({
                action: "invite_employee",
                employee_id: inviteEmployee,
              })
            }
          >
            Invite employee / resend
          </button>
        </div>
      </div>
    </section>
  );
}

export function RestrictedWorkspace({
  settings = false,
}: {
  settings?: boolean;
}) {
  const ws = useWorkspace();
  return (
    <main className="restricted-workspace" id="main-content">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">THE GARDENS</span>
          <h1>{settings ? "Account settings" : "Your workspace"}</h1>
          <p>
            Your administrator permissions determine which sections you can
            open.
          </p>
        </div>
        <button className="button secondary" onClick={() => void ws.signOut()}>
          Sign out
        </button>
      </div>
      <nav className="account-actions" aria-label="Available workspaces">
        {canManage(ws.profile, "team") && (
          <Link href="/team/" className="button primary">
            Employees & payroll
          </Link>
        )}
        {canManage(ws.profile, "accounts") && (
          <Link href="/settings/" className="button secondary">
            Settings · Accounts & permissions
          </Link>
        )}
        {canViewFinance(ws.profile) && (
          <Link href="/" className="button secondary">
            Finance workspace
          </Link>
        )}
      </nav>
      {settings && <AccountSettings />}
    </main>
  );
}
