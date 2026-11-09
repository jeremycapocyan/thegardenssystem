"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Banknote,
  BarChart3,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardList,
  CreditCard,
  Download,
  Eye,
  Leaf,
  LoaderCircle,
  LogOut,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  Wallet,
  TrendingUp,
  X,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { RecordModal, type Editor } from "./record-modal";
import { CashFlowChart, ExpenseMix } from "./charts";
import {
  addMonths,
  billSummary,
  csv,
  displayDate,
  displayMonth,
  inRange,
  installmentSummary,
  money,
  monthEnd,
  monthStart,
  ownerShares,
  periodRange,
  settlements,
  todayInManila,
  totals,
  trend,
} from "@/lib/finance";
import { DEMO_AS_OF, DEMO_REFERENCE } from "@/lib/demo";
import type { Collection, Period, View } from "@/lib/types";
import { getBackend } from "@/lib/backend";
import { canManage, canViewFinance } from "@/lib/access";
import { AccountSettings, RestrictedWorkspace } from "./account-settings";
import { RoiTracker } from "./roi-tracker";

const navigation = [
  { view: "dashboard", href: "/", label: "Overview", icon: BarChart3 },
  { view: "income", href: "/income/", label: "Income", icon: ArrowDownLeft },
  {
    view: "expenses",
    href: "/expenses/",
    label: "Expenses",
    icon: ArrowUpRight,
  },
  {
    view: "bills",
    href: "/fixed-bills/",
    label: "Fixed bills",
    icon: CalendarDays,
  },
  {
    view: "installments",
    href: "/installments/",
    label: "Installments",
    icon: CreditCard,
  },
  {
    view: "payouts",
    href: "/owner-payouts/",
    label: "Owner payouts",
    icon: Users,
  },
  { view: "roi", href: "/roi/", label: "ROI tracker", icon: TrendingUp },
  { view: "settings", href: "/settings/", label: "Settings", icon: Settings2 },
] as const;
const headings: Record<View, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Your court, at a glance.",
    subtitle:
      "A clear picture of what came in, what went out, and what’s yours.",
  },
  income: {
    title: "Income",
    subtitle: "Close the day with one total for each income category.",
  },
  expenses: {
    title: "Expenses",
    subtitle:
      "Record every business payment once. The trackers take care of the rest.",
  },
  bills: {
    title: "Fixed bills",
    subtitle:
      "Your recurring commitments, with a clear view of what is still unpaid.",
  },
  installments: {
    title: "Installments",
    subtitle: "Follow each agreement from the first payment to the last.",
  },
  payouts: {
    title: "Owner payouts",
    subtitle: "Settle monthly owner shares and keep track of the balance.",
  },
  settings: {
    title: "Workspace settings",
    subtitle: "Categories, access, and the rules behind your numbers.",
  },
  roi: {
    title: "Return on your court.",
    subtitle:
      "Track invested capital, cash returns, and each owner’s recovery.",
  },
};
export function CourtMark({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="12" fill="currentColor" />
      <path
        d="M11 9h18v22H11zM11 20h18M20 9v22M11 15h18M11 25h18"
        stroke="#D8E9B5"
        strokeWidth="1.3"
      />
      <circle cx="30" cy="10" r="4" fill="#D8E9B5" />
    </svg>
  );
}
function Badge({ children }: { children: ReactNode }) {
  const label = String(children);
  const kind = /Overdue|Overpaid/.test(label)
    ? "danger"
    : /Paid|Settled|Completed/.test(label)
      ? "success"
      : /Part|Upcoming|progress|Unpaid/.test(label)
        ? "warm"
        : "neutral";
  return <span className={`badge ${kind}`}>{children}</span>;
}
function Empty({
  title = "No records here yet",
  description = "Add your first record to get started.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <ClipboardList size={24} />
      </div>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
function DataTable({
  columns,
  rows,
  label,
}: {
  columns: { label: string; number?: boolean }[];
  rows: { id: string; cells: ReactNode[] }[];
  label: string;
}) {
  return (
    <div className="table-scroll">
      <table>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {columns.map((column, i) => (
              <th key={i} className={column.number ? "number" : ""}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {row.cells.map((cell, i) => (
                <td key={i} className={columns[i]?.number ? "number" : ""}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty
          title="No matching records"
          description="Try a different period or clear the filters."
        />
      )}
    </div>
  );
}
function Stat({
  label,
  value,
  note,
  icon: Icon,
  accent = false,
}: {
  label: string;
  value: number;
  note: string;
  icon: typeof Wallet;
  accent?: boolean;
}) {
  return (
    <section className={`stat ${accent ? "stat-accent" : ""}`}>
      <div className="stat-top">
        <span>{label}</span>
        <span className="stat-icon">
          <Icon size={18} />
        </span>
      </div>
      <strong className={value < 0 ? "negative" : ""}>{money(value)}</strong>
      <span className="stat-note">{note}</span>
    </section>
  );
}

export function Login() {
  const ws = useWorkspace();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [recover, setRecover] = useState(false);
  const [notice, setNotice] = useState("");
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    setPending(true);
    const values = new FormData(event.currentTarget);
    try {
      if (recover) {
        const api = getBackend();
        if (!api) throw new Error("Shared sign-in is still being set up.");
        const result = await api.auth.resetPasswordForEmail(
          String(values.get("email")).trim(),
          { redirectTo: `${window.location.origin}/account/` },
        );
        if (result.error)
          throw new Error("Unable to send a recovery link. Please try again.");
        setNotice(
          "If this email has an account, a password recovery link is on its way.",
        );
      } else
        await ws.signIn(
          String(values.get("email")),
          String(values.get("password")),
        );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setPending(false);
    }
  }
  if (ws.mode === "loading")
    return (
      <main className="loading-screen">
        <CourtMark size={48} />
        <LoaderCircle className="spin" size={22} />
        <p>Opening your workspace…</p>
      </main>
    );
  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-brand">
          <CourtMark size={42} />
          <span>
            THE GARDENS<small>Pickleball court finance</small>
          </span>
        </div>
        <div className="login-copy">
          <span className="eyebrow">LESS ADMIN. MORE COURT TIME.</span>
          <h1>
            A clearer view
            <br />
            of your court.
          </h1>
          <p>
            Keep daily income, business expenses, and owner shares together in
            one calm workspace.
          </p>
          <div className="story-points">
            <span>
              <Check size={16} /> Every peso accounted for
            </span>
            <span>
              <Check size={16} /> Shared reports, clear permissions
            </span>
            <span>
              <Check size={16} /> Monthly owner settlements
            </span>
          </div>
        </div>
        <div className="court-illustration" aria-hidden="true">
          <div className="court-lines">
            <i />
            <b />
          </div>
          <span className="court-ball" />
        </div>
        <span className="login-story-footer">
          The Gardens · Made for the daily close.
        </span>
      </section>
      <section className="login-form-side">
        <div className="login-form-card">
          <span className="eyebrow">WELCOME BACK</span>
          <h2>Your workspace awaits.</h2>
          <p className="muted">
            Sign in to your shared court finance workspace.
          </p>
          {ws.mode === "denied" ? (
            <div className="access-message">
              <ShieldCheck size={28} />
              <h3>Workspace access needed</h3>
              <p>{ws.error}</p>
              <button
                className="button primary"
                onClick={() => void ws.signOut()}
              >
                Use a different account
              </button>
            </div>
          ) : (
            <form onSubmit={submit}>
              <label className="field">
                <span>Email address</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  required
                  placeholder="you@example.com"
                />
              </label>
              {!recover && (
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    placeholder="Enter your password"
                  />
                </label>
              )}
              {notice && (
                <p className="setup-note" role="status">
                  {notice}
                </p>
              )}
              {(error || ws.error) && (
                <div className="error-box" role="alert">
                  {error || ws.error}
                </div>
              )}
              {ws.mode === "unconfigured" && (
                <p className="setup-note">
                  Shared sign-in is being set up. You can explore the working
                  sample workspace below.
                </p>
              )}
              <button
                className="button primary login-submit"
                disabled={pending || ws.mode === "unconfigured"}
              >
                {pending ? <LoaderCircle size={18} className="spin" /> : null}
                {pending
                  ? "Please wait…"
                  : recover
                    ? "Send recovery link"
                    : "Sign in"}
                <ArrowUpRight size={18} />
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setRecover(!recover);
                  setError("");
                  setNotice("");
                }}
              >
                {recover ? "Back to sign in" : "Forgot your password?"}
              </button>
            </form>
          )}
          <div className="login-divider">
            <span>Take a look around</span>
          </div>
          <button
            className="button secondary demo-entry"
            onClick={ws.enterDemo}
          >
            Explore sample workspace
            <ChevronRight size={17} />
          </button>
          <p className="login-footnote">
            Fictional records. No sign-in required. Sample changes stay in this
            browser.
          </p>
        </div>
        <span className="login-copyright">
          © {new Date().getFullYear()} The Gardens
        </span>
      </section>
    </main>
  );
}

function DeleteDialog({
  label,
  pending,
  error,
  onConfirm,
  onClose,
  reset = false,
}: {
  label: string;
  pending: boolean;
  error: string;
  onConfirm: () => void;
  onClose: () => void;
  reset?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      className="record-dialog small-dialog"
      ref={ref}
      onCancel={onClose}
      aria-labelledby="delete-title"
    >
      <div className="dialog-heading">
        <h2 id="delete-title">
          {reset ? "Restore original samples?" : "Delete this record?"}
        </h2>
        <button
          className="icon-button"
          aria-label="Close confirmation"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <p className="dialog-description">
        {reset ? (
          "This replaces the fictional sample records in this browser with the original examples. Shared records are unaffected."
        ) : (
          <>
            {label} will be removed. Related totals and owner balances will
            update.
          </>
        )}
      </p>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer">
        <button
          className="button secondary"
          onClick={onClose}
          disabled={pending}
        >
          {reset ? "Keep current samples" : "Keep record"}
        </button>
        <button
          className="button destructive"
          onClick={onConfirm}
          disabled={pending}
        >
          {pending ? (
            <LoaderCircle className="spin" size={17} />
          ) : reset ? (
            <RefreshCw size={16} />
          ) : (
            <Trash2 size={16} />
          )}
          {reset ? "Restore samples" : "Delete record"}
        </button>
      </div>
    </dialog>
  );
}

function EmployeeRedirect() {
  useEffect(() => {
    window.location.replace("/employee/");
  }, []);
  return (
    <main className="loading-screen">
      <p>Opening your employee portal…</p>
    </main>
  );
}
export function FinanceApp({ view }: { view: View }) {
  const ws = useWorkspace();
  const { period, setPeriod, reference, setReference, asOf, setAsOf } = ws;
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toast, setToast] = useState("");
  const [pageError, setPageError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [deletion, setDeletion] = useState<{
    collection: Collection | "bills";
    id: string;
    label: string;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resettingSamples, setResettingSamples] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4200);
    return () => clearTimeout(timer);
  }, [toast]);
  const range = periodRange(period, reference);
  const month = monthStart(reference);
  const admin = canManage(ws.profile, "finance");
  const summary = totals(ws.data, range.start, range.end);
  const shares = ownerShares(summary.net);
  const categoryName = (id: string) =>
    ws.data.categories.find((c) => c.id === id)?.name || "Unknown category";
  const matches = (...values: unknown[]) =>
    !query ||
    values.some((value) =>
      String(value ?? "")
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
  const filteredIncome = ws.data.income
    .filter(
      (r) =>
        inRange(r.business_date, range.start, range.end) &&
        (!categoryFilter || r.category_id === categoryFilter) &&
        matches(categoryName(r.category_id), r.notes),
    )
    .sort((a, b) => b.business_date.localeCompare(a.business_date));
  const filteredExpenses = ws.data.expenses
    .filter(
      (r) =>
        inRange(r.paid_on, range.start, range.end) &&
        (!categoryFilter || r.category_id === categoryFilter) &&
        matches(
          categoryName(r.category_id),
          r.notes,
          r.reference,
          r.payment_kind,
          ws.data.bills.find((b) => b.id === r.fixed_bill_id)?.name,
          ws.data.installments.find((b) => b.id === r.installment_id)?.name,
        ),
    )
    .sort((a, b) => b.paid_on.localeCompare(a.paid_on));
  const billRows = ws.data.bills
    .map((bill) => ({ ...bill, ...billSummary(ws.data, bill, month, asOf) }))
    .filter((b) => matches(b.name, b.code, b.status));
  const installmentRows = ws.data.installments
    .map((agreement) => ({
      ...agreement,
      ...installmentSummary(ws.data, agreement, asOf),
    }))
    .filter((a) => matches(a.name, a.code, a.status));
  const payouts = ws.data.payouts
    .filter(
      (p) =>
        p.settlement_month === month && matches(p.owner, p.notes, p.reference),
    )
    .sort((a, b) => b.paid_on.localeCompare(a.paid_on));
  const ownerBalances = settlements(ws.data, month, asOf);
  const points = useMemo(
    () => trend(ws.data, period, reference),
    [ws.data, period, reference],
  );
  const spending = ws.data.categories
    .filter((c) => c.kind === "expense")
    .map((c) => ({
      name: c.name,
      amount: ws.data.expenses
        .filter(
          (e) =>
            e.category_id === c.id &&
            inRange(e.paid_on, range.start, range.end),
        )
        .reduce((s, e) => s + e.amount_cents, 0),
    }));
  const recent = [
    ...ws.data.income
      .filter((r) => inRange(r.business_date, range.start, range.end))
      .map((r) => ({
        id: r.id,
        date: r.business_date,
        name: categoryName(r.category_id),
        notes: r.notes,
        amount: r.amount_cents,
        income: true,
      })),
    ...ws.data.expenses
      .filter((r) => inRange(r.paid_on, range.start, range.end))
      .map((r) => ({
        id: r.id,
        date: r.paid_on,
        name: categoryName(r.category_id),
        notes: r.notes,
        amount: r.amount_cents,
        income: false,
      })),
  ]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 6);
  function edit(
    kind: Editor["kind"],
    record?: object,
    term?: Editor["term"],
    revise = false,
  ) {
    setEditor({
      kind,
      record: record as Record<string, unknown> | undefined,
      term,
      revise,
    });
    setPageError("");
  }
  const actions = (
    kind: Collection | "bills",
    record: { id: string; staff_payment_id?: string | null },
    label: string,
    term?: Editor["term"],
  ) =>
    record.staff_payment_id ? (
      <span className="badge neutral">Payroll linked</span>
    ) : admin ? (
      <div className="row-actions">
        <button
          className="icon-button"
          title={`Edit ${label}`}
          aria-label={`Edit ${label}`}
          onClick={() => edit(kind, record, term)}
        >
          <Pencil size={15} />
        </button>
        {kind === "bills" && (
          <button
            className="icon-button"
            title="Change terms from a new month"
            aria-label={`Change terms for ${label}`}
            onClick={() => edit("bills", record, term, true)}
          >
            <CalendarDays size={15} />
          </button>
        )}
        <button
          className="icon-button delete-button"
          title={`Delete ${label}`}
          aria-label={`Delete ${label}`}
          onClick={() => {
            setDeletion({ collection: kind, id: record.id, label });
            setPageError("");
          }}
        >
          <Trash2 size={15} />
        </button>
      </div>
    ) : (
      <span className="muted">—</span>
    );
  async function confirmDelete() {
    if (!deletion) return;
    setDeleting(true);
    setPageError("");
    try {
      await ws.remove(deletion.collection, deletion.id);
      setDeletion(null);
      setToast("Record deleted.");
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Unable to delete record.",
      );
    } finally {
      setDeleting(false);
    }
  }
  function download() {
    let rows: (string | number)[][] = [];
    if (view === "income")
      rows = [
        ["Date", "Category", "Amount (PHP)", "Notes"],
        ...filteredIncome.map((r) => [
          r.business_date,
          categoryName(r.category_id),
          (r.amount_cents / 100).toFixed(2),
          r.notes,
        ]),
      ];
    else if (view === "expenses")
      rows = [
        [
          "Payment date",
          "Category",
          "Type",
          "Due month",
          "Amount (PHP)",
          "Reference",
          "Notes",
        ],
        ...filteredExpenses.map((r) => [
          r.paid_on,
          categoryName(r.category_id),
          r.payment_kind,
          r.due_month || "",
          (r.amount_cents / 100).toFixed(2),
          r.reference,
          r.notes,
        ]),
      ];
    else if (view === "bills")
      rows = [
        [
          "Bill",
          "Month",
          "Due date",
          "Expected (PHP)",
          "Paid (PHP)",
          "Unpaid (PHP)",
          "Status",
        ],
        ...billRows.map((r) => [
          r.name,
          month,
          r.due || "",
          r.expected / 100,
          r.paid / 100,
          r.unpaid / 100,
          r.status,
        ]),
      ];
    else if (view === "installments")
      rows = [
        [
          "Agreement",
          "Total (PHP)",
          "Paid (PHP)",
          "Remaining (PHP)",
          "Overdue (PHP)",
          "Next due",
          "Status",
        ],
        ...installmentRows.map((r) => [
          r.name,
          r.total_cents / 100,
          r.paid / 100,
          r.remaining / 100,
          r.overdue / 100,
          r.next || "",
          r.status,
        ]),
      ];
    else if (view === "payouts")
      rows = [
        [
          "Owner",
          "Settlement month",
          "Entitlement (PHP)",
          "Paid (PHP)",
          "Balance (PHP)",
          "Status",
        ],
        ...ownerBalances.map((r) => [
          r.owner,
          month,
          r.entitlement / 100,
          r.paid / 100,
          r.balance / 100,
          r.status,
        ]),
      ];
    else
      rows = [
        [
          "Period start",
          "Period end",
          "Income (PHP)",
          "Expenses (PHP)",
          "Net income (PHP)",
          "Genesis (PHP)",
          "Ken (PHP)",
          "Jeremy (PHP)",
        ],
        [
          range.start,
          range.end,
          summary.income / 100,
          summary.expense / 100,
          summary.net / 100,
          shares.Genesis / 100,
          shares.Ken / 100,
          shares.Jeremy / 100,
        ],
      ];
    const blob = new Blob([csv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `the-gardens-${view}-${reference}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (ws.mode !== "live" && ws.mode !== "demo") return <Login />;
  if (ws.profile?.role === "employee") return <EmployeeRedirect />;
  if (!canViewFinance(ws.profile))
    return <RestrictedWorkspace settings={view === "settings"} />;
  return (
    <div className="app-shell">
      {menuOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <Link href="/" className="brand">
          <CourtMark size={40} />
          <span>
            THE GARDENS<small>Pickleball finance</small>
          </span>
        </Link>
        <div className="nav-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.view}
                href={item.href}
                onClick={() => setMenuOpen(false)}
                className={`nav-item ${view === item.view ? "active" : ""}`}
                aria-current={view === item.view ? "page" : undefined}
              >
                <Icon size={19} />
                {item.label}
                {view === item.view && <span className="nav-dot" />}
              </Link>
            );
          })}
          {canManage(ws.profile, "team") && (
            <Link className="nav-item" href="/team/">
              <Users size={19} />
              Employees & payroll
            </Link>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="split-note">
            <Leaf size={19} />
            <strong>Growing together.</strong>
            <p>
              A clear split.
              <br />A shared way forward.
            </p>
            <div>
              <span>40%</span>
              <span>40%</span>
              <span>20%</span>
            </div>
            <small>Genesis · Ken · Jeremy</small>
          </div>
          <div className="sidebar-profile">
            <span className="avatar">
              {ws.profile?.display_name.slice(0, 1)}
            </span>
            <span>
              <strong>{ws.profile?.display_name}</strong>
              <small>{admin ? "Workspace admin" : "Viewing access"}</small>
            </span>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={() =>
                void ws.signOut().catch((err) => setPageError(String(err)))
              }
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button menu-button"
              onClick={() => setMenuOpen(true)}
              aria-label="Open navigation"
            >
              <Menu size={21} />
            </button>
            <span>The Gardens</span>
            <ChevronRight size={14} />
            <strong>{navigation.find((n) => n.view === view)?.label}</strong>
          </div>
          <div className="topbar-right">
            {ws.mode === "demo" ? (
              <span className="workspace-label">
                <i />
                Sample workspace
              </span>
            ) : (
              <span className="workspace-label">
                <ShieldCheck size={15} />
                Shared workspace
              </span>
            )}
            <span className="role-tag">{admin ? "Admin" : "View only"}</span>
          </div>
        </header>
        {ws.mode === "demo" && (
          <div className="demo-banner">
            <span>
              <strong>Sample workspace.</strong> Fictional records; changes stay
              in this browser.
            </span>
            <div>
              <select
                aria-label="Preview account permissions"
                value={admin ? "admin" : "viewer"}
                onChange={(e) =>
                  ws.previewRole(e.target.value as "admin" | "viewer")
                }
              >
                <option value="admin">Preview as Jeremy · Admin</option>
                <option value="viewer">Preview as Genesis · Viewer</option>
              </select>
              <button onClick={() => void ws.signOut()}>
                Back to sign in
                <ArrowUpRight size={14} />
              </button>
            </div>
          </div>
        )}
        <main id="main-content" className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {view === "dashboard" ? "THE DAILY PICTURE" : "COURT FINANCE"}
              </span>
              <h1>{headings[view].title}</h1>
              <p>{headings[view].subtitle}</p>
            </div>
            <div className="heading-actions">
              {view !== "settings" && view !== "roi" && (
                <button className="button secondary" onClick={download}>
                  <Download size={16} />
                  <span>Export CSV</span>
                </button>
              )}
              {admin && view !== "settings" && view !== "roi" && (
                <button
                  className="button primary"
                  onClick={() =>
                    edit(
                      view === "dashboard"
                        ? "income"
                        : view === "bills"
                          ? "bills"
                          : view,
                    )
                  }
                >
                  <Plus size={18} />
                  {view === "dashboard"
                    ? "Record income"
                    : view === "income"
                      ? "Record income"
                      : view === "expenses"
                        ? "Record payment"
                        : view === "bills"
                          ? "Add fixed bill"
                          : view === "installments"
                            ? "Add agreement"
                            : "Record payout"}
                </button>
              )}
            </div>
          </div>
          {(ws.error || (pageError && !deletion)) && (
            <div className="error-box" role="alert">
              {ws.error || pageError}
            </div>
          )}
          {view !== "settings" && view !== "roi" && (
            <section className="period-bar" aria-label="Report date controls">
              <div className="period-controls">
                <div className="segmented" aria-label="Reporting period">
                  {(["daily", "weekly", "monthly"] as const).map((p) => (
                    <button
                      key={p}
                      className={period === p ? "selected" : ""}
                      aria-pressed={period === p}
                      onClick={() => setPeriod(p)}
                    >
                      {p[0].toUpperCase() + p.slice(1)}
                    </button>
                  ))}
                </div>
                <label className="date-control">
                  <CalendarDays size={16} />
                  <span className="sr-only">Reference date</span>
                  <input
                    aria-label="Reference date"
                    type="date"
                    value={reference}
                    onChange={(e) => {
                      if (e.target.value) setReference(e.target.value);
                    }}
                  />
                </label>
              </div>
              <div className="period-caption">
                <span>
                  {displayDate(range.start)}
                  {range.start !== range.end
                    ? ` — ${displayDate(range.end)}`
                    : ""}
                </span>
                {ws.mode === "live" && (
                  <button
                    className={`icon-button ${refreshing ? "spin" : ""}`}
                    aria-label="Refresh shared records"
                    disabled={refreshing}
                    onClick={async () => {
                      setRefreshing(true);
                      await ws.refresh();
                      setRefreshing(false);
                    }}
                  >
                    <RefreshCw size={15} />
                  </button>
                )}
              </div>
            </section>
          )}

          {view === "dashboard" && (
            <>
              <div className="stats-grid">
                <Stat
                  label="Total income"
                  value={summary.income}
                  note={`${ws.data.income.filter((r) => inRange(r.business_date, range.start, range.end)).length} income entries in this period`}
                  icon={ArrowDownLeft}
                />
                <Stat
                  label="Business expenses"
                  value={summary.expense}
                  note="Operating costs, bills & installments"
                  icon={ArrowUpRight}
                />
                <Stat
                  label="Net income"
                  value={summary.net}
                  note={
                    summary.income
                      ? `${((summary.net / summary.income) * 100).toFixed(1)}% of income remains`
                      : "Income less actual business payments"
                  }
                  icon={Wallet}
                  accent
                />
              </div>
              <dl
                className="payment-breakdown"
                aria-label="Business expense breakdown"
              >
                <div>
                  <dt>Operating expenses</dt>
                  <dd>{money(summary.operating)}</dd>
                </div>
                <div>
                  <dt>Fixed bill payments</dt>
                  <dd>{money(summary.fixed)}</dd>
                </div>
                <div>
                  <dt>Installment payments</dt>
                  <dd>{money(summary.installment)}</dd>
                </div>
              </dl>
              <div className="analytics-grid">
                <section className="panel cash-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Cash flow</h2>
                      <p>
                        {period === "daily"
                          ? "The latest 30 days"
                          : period === "weekly"
                            ? "The latest 12 weeks"
                            : "The latest 12 months"}
                      </p>
                    </div>
                    <div className="chart-legend">
                      <span>
                        <i className="income-dot" />
                        Income
                      </span>
                      <span>
                        <i className="expense-dot" />
                        Expenses
                      </span>
                      <span>
                        <i className="net-dot" />
                        Net
                      </span>
                    </div>
                  </div>
                  <CashFlowChart points={points} />
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Where the money goes</h2>
                      <p>Expenses for the selected period</p>
                    </div>
                  </div>
                  <ExpenseMix entries={spending} />
                </section>
              </div>
              {summary.net < 0 && (
                <p className="loss-note">
                  Loss this period: <strong>{money(-summary.net)}</strong>.
                  Distributable income is ₱0.00; owner shares are zero. This
                  loss does not carry forward.
                </p>
              )}
              <section className="allocation-section">
                <div className="section-heading">
                  <div>
                    <h2>Everyone’s share</h2>
                    <p>
                      {period === "monthly"
                        ? "Monthly entitlement, before payouts."
                        : "Indicative only. Final owner shares use the entire calendar month."}
                    </p>
                  </div>
                  <Link className="text-link" href="/owner-payouts/">
                    View settlements
                    <ChevronRight size={15} />
                  </Link>
                </div>
                <div className="owner-grid">
                  {(["Genesis", "Ken", "Jeremy"] as const).map((owner, i) => (
                    <div className="owner-card" key={owner}>
                      <span className={`owner-avatar owner-${i}`}>
                        {owner[0]}
                      </span>
                      <div>
                        <strong>{owner}</strong>
                        <span>
                          {i === 2 ? "20" : "40"}% of distributable income
                        </span>
                      </div>
                      <strong className="owner-amount">
                        {money(shares[owner])}
                      </strong>
                    </div>
                  ))}
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Recent activity</h2>
                    <p>
                      The latest income and business payments in this period
                    </p>
                  </div>
                  {admin && (
                    <button
                      className="button secondary compact"
                      onClick={() => edit("expenses")}
                    >
                      <Plus size={15} />
                      Add expense
                    </button>
                  )}
                </div>
                <DataTable
                  label="Recent activity"
                  columns={[
                    { label: "Transaction" },
                    { label: "Date" },
                    { label: "Type" },
                    { label: "Amount", number: true },
                  ]}
                  rows={recent.map((r) => ({
                    id: r.id,
                    cells: [
                      <div className="transaction-name">
                        <span
                          className={`transaction-icon ${r.income ? "in" : "out"}`}
                        >
                          {r.income ? (
                            <ArrowDownLeft size={17} />
                          ) : (
                            <ArrowUpRight size={17} />
                          )}
                        </span>
                        <span>
                          <strong>{r.name}</strong>
                          <small>{r.notes || "—"}</small>
                        </span>
                      </div>,
                      displayDate(r.date),
                      <Badge>{r.income ? "Income" : "Expense"}</Badge>,
                      <strong className={r.income ? "positive" : ""}>
                        {r.income ? "+" : "−"}
                        {money(r.amount)}
                      </strong>,
                    ],
                  }))}
                />
              </section>
            </>
          )}

          {(view === "income" || view === "expenses") && (
            <>
              <div className="stats-grid two">
                <Stat
                  label={
                    view === "income"
                      ? "Income this period"
                      : "Payments this period"
                  }
                  value={view === "income" ? summary.income : summary.expense}
                  note={
                    view === "income"
                      ? "One category total per business day"
                      : "Owner payouts are recorded separately"
                  }
                  icon={view === "income" ? ArrowDownLeft : ArrowUpRight}
                  accent
                />
                <div className="info-card">
                  <ClipboardList size={24} />
                  <div>
                    <h3>
                      {view === "income"
                        ? "A simple daily close."
                        : "One payment, one entry."}
                    </h3>
                    <p>
                      {view === "income"
                        ? "Enter each category’s end-of-day total. The dashboard adds everything together."
                        : "Select Fixed bill or Installment to link a payment. Leave everyday costs under Operating expense."}
                    </p>
                  </div>
                </div>
              </div>
              <section className="panel">
                <div className="table-toolbar">
                  <div className="search-field">
                    <Search size={17} />
                    <input
                      aria-label={`Search ${view}`}
                      placeholder="Search records…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="Filter by category"
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                  >
                    <option value="">All categories</option>
                    {ws.data.categories
                      .filter(
                        (c) =>
                          c.kind === (view === "income" ? "income" : "expense"),
                      )
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                  <span className="table-count">
                    {view === "income"
                      ? filteredIncome.length
                      : filteredExpenses.length}{" "}
                    records
                  </span>
                </div>
                {view === "income" ? (
                  <DataTable
                    label="Income entries"
                    columns={[
                      { label: "Business date" },
                      { label: "Category" },
                      { label: "Notes" },
                      { label: "Amount", number: true },
                      { label: "", number: true },
                    ]}
                    rows={filteredIncome.map((r) => ({
                      id: r.id,
                      cells: [
                        displayDate(r.business_date),
                        <strong>{categoryName(r.category_id)}</strong>,
                        <span className="cell-notes">{r.notes || "—"}</span>,
                        <strong className="positive">
                          {money(r.amount_cents)}
                        </strong>,
                        actions("income", r, "income entry"),
                      ],
                    }))}
                  />
                ) : (
                  <DataTable
                    label="Business payments"
                    columns={[
                      { label: "Payment date" },
                      { label: "Category / agreement" },
                      { label: "Payment type" },
                      { label: "Due month" },
                      { label: "Amount", number: true },
                      { label: "", number: true },
                    ]}
                    rows={filteredExpenses.map((r) => ({
                      id: r.id,
                      cells: [
                        <div className="cell-stack">
                          <span>{displayDate(r.paid_on)}</span>
                          <small>{r.reference || "No reference"}</small>
                        </div>,
                        <div className="cell-stack">
                          <strong>{categoryName(r.category_id)}</strong>
                          <small>
                            {r.fixed_bill_id
                              ? ws.data.bills.find(
                                  (b) => b.id === r.fixed_bill_id,
                                )?.name
                              : r.installment_id
                                ? ws.data.installments.find(
                                    (b) => b.id === r.installment_id,
                                  )?.name
                                : r.notes || "Everyday business cost"}
                          </small>
                        </div>,
                        <Badge>
                          {r.payment_kind === "fixed"
                            ? "Fixed bill"
                            : r.payment_kind === "installment"
                              ? "Installment"
                              : "Operating"}
                        </Badge>,
                        r.due_month ? displayMonth(r.due_month) : "—",
                        <strong>{money(r.amount_cents)}</strong>,
                        actions("expenses", r, "payment"),
                      ],
                    }))}
                  />
                )}
              </section>
            </>
          )}

          {view === "bills" && (
            <>
              <div className="section-heading tracker-heading">
                <div>
                  <h2>{displayMonth(month)} commitments</h2>
                  <p>
                    Payments are matched to the month being paid, including
                    early or late payments.
                  </p>
                </div>
                <label className="as-of">
                  Paid through
                  <input
                    type="date"
                    aria-label="Bill balances as of"
                    value={asOf}
                    onChange={(e) => {
                      if (e.target.value) setAsOf(e.target.value);
                    }}
                  />
                </label>
              </div>
              <div className="stats-grid">
                <Stat
                  label="Expected this month"
                  value={billRows.reduce((s, b) => s + b.expected, 0)}
                  note="Recurring bills active in this month"
                  icon={CalendarDays}
                />
                <Stat
                  label="Payments recorded"
                  value={billRows.reduce((s, b) => s + b.paid, 0)}
                  note={`Paid through ${displayDate(asOf)}`}
                  icon={Banknote}
                />
                <Stat
                  label="Still unpaid"
                  value={billRows.reduce((s, b) => s + b.unpaid, 0)}
                  note="Unpaid balances stay visible until settled"
                  icon={Wallet}
                  accent
                />
              </div>
              <section className="panel">
                <div className="table-toolbar">
                  <div className="search-field">
                    <Search size={17} />
                    <input
                      aria-label="Search fixed bills"
                      placeholder="Find a bill…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <span className="table-count">{billRows.length} bills</span>
                </div>
                <DataTable
                  label="Fixed bill tracker"
                  columns={[
                    { label: "Bill" },
                    { label: "Due date" },
                    { label: "Expected", number: true },
                    { label: "Paid", number: true },
                    { label: "Unpaid", number: true },
                    { label: "Status" },
                    { label: "", number: true },
                  ]}
                  rows={billRows.map((b) => ({
                    id: b.id,
                    cells: [
                      <div className="cell-stack">
                        <strong>{b.name}</strong>
                        <small>
                          {b.code} · {categoryName(b.category_id)}
                        </small>
                      </div>,
                      b.due ? displayDate(b.due) : "—",
                      money(b.expected),
                      money(b.paid),
                      <strong className={b.overdue ? "negative" : ""}>
                        {money(b.unpaid)}
                      </strong>,
                      <Badge>{b.status}</Badge>,
                      actions("bills", b, b.name, b.term),
                    ],
                  }))}
                />
                <div className="panel-footnote">
                  <CalendarDays size={15} />
                  Use the calendar action to change an amount from a new month.
                  Earlier terms are preserved.
                </div>
              </section>
            </>
          )}

          {view === "installments" && (
            <>
              <div className="section-heading tracker-heading">
                <div>
                  <h2>Keep the finish line in sight.</h2>
                  <p>Balances use actual payments recorded in Expenses.</p>
                </div>
                <label className="as-of">
                  Balances as of
                  <input
                    type="date"
                    aria-label="Installment balances as of"
                    value={asOf}
                    onChange={(e) => {
                      if (e.target.value) setAsOf(e.target.value);
                    }}
                  />
                </label>
              </div>
              <div className="stats-grid">
                <Stat
                  label="Remaining balance"
                  value={installmentRows.reduce((s, a) => s + a.remaining, 0)}
                  note="Across all installment agreements"
                  icon={CreditCard}
                  accent
                />
                <Stat
                  label="Overdue amount"
                  value={installmentRows.reduce((s, a) => s + a.overdue, 0)}
                  note="Unpaid installments due before the as-of date"
                  icon={CalendarDays}
                />
                <Stat
                  label="Paid in selected period"
                  value={summary.installment}
                  note="Already included in business expenses"
                  icon={Banknote}
                />
              </div>
              <section className="panel">
                <div className="table-toolbar">
                  <div className="search-field">
                    <Search size={17} />
                    <input
                      aria-label="Search installments"
                      placeholder="Find an agreement…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <span className="table-count">
                    {installmentRows.length} agreements
                  </span>
                </div>
                <DataTable
                  label="Installment tracker"
                  columns={[
                    { label: "Agreement" },
                    { label: "Monthly payment", number: true },
                    { label: "Paid", number: true },
                    { label: "Remaining", number: true },
                    { label: "Next unpaid due" },
                    { label: "Status" },
                    { label: "", number: true },
                  ]}
                  rows={installmentRows.map((a) => ({
                    id: a.id,
                    cells: [
                      <div className="cell-stack">
                        <strong>{a.name}</strong>
                        <small>
                          {a.code} · agreed {money(a.total_cents)}
                        </small>
                        <small>
                          {a.count} payments · final {money(a.finalPayment)}
                        </small>
                        <div className="progress-track">
                          <span
                            style={{
                              width: `${Math.min((a.paid / a.total_cents) * 100, 100)}%`,
                            }}
                          />
                        </div>
                      </div>,
                      money(a.monthly_cents),
                      money(a.paid),
                      <strong>{money(a.remaining)}</strong>,
                      <div className="cell-stack">
                        <span>
                          {a.next ? displayDate(a.next) : "Completed"}
                        </span>
                        {a.overdue > 0 && (
                          <small className="negative">
                            {money(a.overdue)} overdue
                          </small>
                        )}
                      </div>,
                      <Badge>{a.status}</Badge>,
                      actions("installments", a, a.name),
                    ],
                  }))}
                />
              </section>
            </>
          )}

          {view === "payouts" && (
            <>
              <div className="section-heading tracker-heading">
                <div>
                  <h2>{displayMonth(month)} settlement</h2>
                  <p>
                    Shares use the entire calendar month’s net income. Payouts
                    are separate from business expenses.
                  </p>
                </div>
                <label className="as-of">
                  Paid through
                  <input
                    type="date"
                    aria-label="Owner payouts as of"
                    value={asOf}
                    onChange={(e) => {
                      if (e.target.value) setAsOf(e.target.value);
                    }}
                  />
                </label>
              </div>
              {monthEnd(month) > asOf && (
                <div className="notice">
                  This month has not closed. Owner entitlements will change as
                  more records are entered.
                </div>
              )}
              <div className="settlement-grid">
                {ownerBalances.map((o, i) => (
                  <section className="settlement-card" key={o.owner}>
                    <div className="settlement-owner">
                      <span className={`owner-avatar owner-${i}`}>
                        {o.owner[0]}
                      </span>
                      <div>
                        <h2>{o.owner}</h2>
                        <span>{o.share}% share</span>
                      </div>
                      <Badge>{o.status}</Badge>
                    </div>
                    <div className="settlement-amount">
                      <span>Monthly entitlement</span>
                      <strong>{money(o.entitlement)}</strong>
                    </div>
                    <div className="settlement-detail">
                      <span>
                        Paid to date<strong>{money(o.paid)}</strong>
                      </span>
                      <span>
                        {o.balance < 0 ? "Overpaid by" : "Still unpaid"}
                        <strong className={o.balance < 0 ? "negative" : ""}>
                          {money(Math.abs(o.balance))}
                        </strong>
                      </span>
                    </div>
                  </section>
                ))}
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Payout history</h2>
                    <p>
                      Payments assigned to {displayMonth(month)}, even if paid
                      later.
                    </p>
                  </div>
                  <div className="search-field">
                    <Search size={16} />
                    <input
                      aria-label="Search owner payouts"
                      placeholder="Search payouts…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                </div>
                <DataTable
                  label="Owner payouts"
                  columns={[
                    { label: "Paid on" },
                    { label: "Owner" },
                    { label: "Settlement month" },
                    { label: "Reference / notes" },
                    { label: "Amount", number: true },
                    { label: "", number: true },
                  ]}
                  rows={payouts.map((p) => ({
                    id: p.id,
                    cells: [
                      <div className="cell-stack">
                        <span>{displayDate(p.paid_on)}</span>
                        {p.paid_on > asOf && <small>After as-of date</small>}
                      </div>,
                      <strong>{p.owner}</strong>,
                      displayMonth(p.settlement_month),
                      <div className="cell-stack">
                        <span>{p.reference || "—"}</span>
                        <small>{p.notes}</small>
                      </div>,
                      <strong>{money(p.amount_cents)}</strong>,
                      actions("payouts", p, `${p.owner} payout`),
                    ],
                  }))}
                />
              </section>
            </>
          )}

          {view === "roi" && <RoiTracker />}
          {view === "settings" && (
            <>
              <AccountSettings />
              <div className="settings-grid">
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Income categories</h2>
                      <p>For the daily close</p>
                    </div>
                    {admin && (
                      <button
                        className="icon-button"
                        aria-label="Add income category"
                        onClick={() =>
                          setEditor({
                            kind: "categories",
                            categoryKind: "income",
                          })
                        }
                      >
                        <Plus size={19} />
                      </button>
                    )}
                  </div>
                  {ws.data.categories
                    .filter((c) => c.kind === "income")
                    .map((c) => (
                      <div
                        className={`category-row ${!c.active ? "archived" : ""}`}
                        key={c.id}
                      >
                        <span>
                          {c.name}
                          {!c.active && <small>Archived</small>}
                        </span>
                        {admin && (
                          <div>
                            <button
                              className="icon-button"
                              aria-label={`Edit ${c.name}`}
                              onClick={() => edit("categories", c)}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="text-button"
                              onClick={() =>
                                void ws
                                  .save("categories", {
                                    ...c,
                                    active: !c.active,
                                  })
                                  .catch((err) => setPageError(err.message))
                              }
                            >
                              {c.active ? "Archive" : "Restore"}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                </section>
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Expense categories</h2>
                      <p>Understand where your money goes</p>
                    </div>
                    {admin && (
                      <button
                        className="icon-button"
                        aria-label="Add expense category"
                        onClick={() =>
                          setEditor({
                            kind: "categories",
                            categoryKind: "expense",
                          })
                        }
                      >
                        <Plus size={19} />
                      </button>
                    )}
                  </div>
                  {ws.data.categories
                    .filter((c) => c.kind === "expense")
                    .map((c) => (
                      <div
                        className={`category-row ${!c.active ? "archived" : ""}`}
                        key={c.id}
                      >
                        <span>
                          {c.name}
                          {!c.active && <small>Archived</small>}
                        </span>
                        {admin && (
                          <div>
                            <button
                              className="icon-button"
                              aria-label={`Edit ${c.name}`}
                              onClick={() => edit("categories", c)}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              className="text-button"
                              onClick={() =>
                                void ws
                                  .save("categories", {
                                    ...c,
                                    active: !c.active,
                                  })
                                  .catch((err) => setPageError(err.message))
                              }
                            >
                              {c.active ? "Archive" : "Restore"}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                </section>
              </div>
              <section className="panel settings-panel">
                <div className="panel-heading">
                  <div>
                    <h2>A few things stay consistent.</h2>
                    <p>The rules used across the workspace</p>
                  </div>
                  <ShieldCheck size={22} />
                </div>
                <div className="rules-grid">
                  <div>
                    <strong>40% / 40% / 20%</strong>
                    <p>
                      Genesis, Ken, and Jeremy. Jeremy receives any centavo
                      rounding remainder.
                    </p>
                  </div>
                  <div>
                    <strong>Actual payments</strong>
                    <p>
                      Net income is cash collected less actual business
                      payments. Owner withdrawals are separate.
                    </p>
                  </div>
                  <div>
                    <strong>Calendar-month settlement</strong>
                    <p>
                      Daily and weekly shares are indicative. Loss months have
                      zero entitlement, with no loss carryforward.
                    </p>
                  </div>
                  <div>
                    <strong>Clear access</strong>
                    <p>
                      Jeremy manages records. Genesis and Ken have viewing
                      access. Changes to shared records are logged.
                    </p>
                  </div>
                </div>
              </section>
              {admin && (
                <section className="panel settings-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Workspace activity</h2>
                      <p>
                        {ws.mode === "demo"
                          ? "Shared records keep an audit history when the live workspace is connected."
                          : "Recent changes to shared records"}
                      </p>
                    </div>
                    {ws.mode === "demo" && (
                      <button
                        className="button secondary compact"
                        onClick={() => setResettingSamples(true)}
                      >
                        <RefreshCw size={14} />
                        Reset samples
                      </button>
                    )}
                  </div>
                  {ws.data.audit.length ? (
                    <div className="audit-list">
                      {ws.data.audit.slice(0, 10).map((a) => (
                        <div key={a.id}>
                          <span>
                            {a.action.toLowerCase()} ·{" "}
                            {a.table_name
                              .replace("garden_", "")
                              .replaceAll("_", " ")}
                          </span>
                          <time>
                            {new Date(a.occurred_at).toLocaleString("en-PH", {
                              timeZone: "Asia/Manila",
                            })}
                          </time>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-inline">
                      No shared changes recorded yet.
                    </p>
                  )}
                </section>
              )}
            </>
          )}
          <footer className="workspace-footer">
            <span>
              THE GARDENS <i /> Philippine pesos · Cash basis · Asia/Manila
            </span>
            <span>
              {ws.mode === "demo"
                ? "Sample data"
                : ws.syncedAt
                  ? `Last synced ${ws.syncedAt.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" })}`
                  : "Shared workspace"}
            </span>
          </footer>
        </main>
      </div>
      {editor && (
        <RecordModal
          key={`${editor.kind}-${editor.record?.id || "new"}-${editor.revise ? "revise" : "edit"}`}
          editor={editor}
          reference={reference}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            setToast("Record saved.");
          }}
        />
      )}
      {deletion && (
        <DeleteDialog
          label={deletion.label}
          pending={deleting}
          error={pageError}
          onConfirm={() => void confirmDelete()}
          onClose={() => {
            setDeletion(null);
            setPageError("");
          }}
        />
      )}
      {resettingSamples && (
        <DeleteDialog
          reset
          label="Samples"
          pending={false}
          error=""
          onClose={() => setResettingSamples(false)}
          onConfirm={() => {
            ws.resetDemo();
            setResettingSamples(false);
            setToast("Original sample records restored.");
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
        </div>
      )}
    </div>
  );
}
