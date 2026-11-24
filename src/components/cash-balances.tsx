"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { canManage } from "@/lib/access";
import { getBackend, friendlyError } from "@/lib/backend";
import {
  money,
  displayDate,
  parseMoney,
  todayInManila,
  csv,
  periodRange,
} from "@/lib/finance";
import {
  ACCOUNTS,
  allocationKind,
  allocationRecord,
  cashEntries,
  cashSummary,
  demoCash,
  signedMoney,
  validateCashAllocation,
  type CashData,
  type CashAccount,
  type CashAllocation,
  type CashMovement,
} from "@/lib/balances";
const STORE = "gardens.balances.sample.v1";
const accountOptions = Object.entries(ACCOUNTS).map(([id, label]) => (
  <option key={id} value={id}>
    {label}
  </option>
));
type Entry = ReturnType<typeof cashEntries>[number];
export function CashBalances() {
  const ws = useWorkspace(),
    admin = canManage(ws.profile, "finance");
  const [data, setData] = useState<CashData | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [asOf, setAsOf] = useState(ws.mode === "demo" ? ws.asOf : todayInManila()),
    [onlyUnassigned, setOnlyUnassigned] = useState(true),
    [editing, setEditing] = useState<Entry | null>(null),
    [movement, setMovement] = useState(false);
  const running = useRef(false),
    requestId = useRef(crypto.randomUUID());
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      if (ws.mode === "demo") {
        let next = demoCash(ws.data);
        try {
          const saved = JSON.parse(localStorage.getItem(STORE) || "null");
          if (
            saved &&
            Array.isArray(saved.allocations) &&
            Array.isArray(saved.movements)
          )
            next = { ...saved, finance: ws.data };
        } catch {}
        setData(next);
      } else if (ws.mode === "live") {
        const api = getBackend();
        if (!api) throw Error("Sign in again.");
        const r = await api.rpc("garden_balances_snapshot");
        if (r.error) throw Error(friendlyError(r.error));
        setData(r.data as CashData);
      }
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Unable to load balances.");
    } finally {
      setLoading(false);
    }
  }, [ws.mode, ws.data, ws.syncedAt]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const reset = () => void refresh();
    window.addEventListener("gardens-demo-reset", reset);
    return () => window.removeEventListener("gardens-demo-reset", reset);
  }, [refresh]);
  async function mutate(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!admin) throw Error("Finance management permission required.");
      if (ws.mode === "live" && !navigator.onLine)
        throw Error(
          "Reconnect before saving. Retry the same action after a connection failure.",
        );
      await fn();
      setNotice("Saved. Finance income and expenses have not been duplicated.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save.");
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  function commit(next: CashData) {
    localStorage.setItem(
      STORE,
      JSON.stringify({ ...next, finance: undefined }),
    );
    setData(next);
  }
  async function rpc(name: string, args: Record<string, unknown>) {
    const api = getBackend();
    if (!api) throw Error("Sign in again.");
    const r = await api.rpc(name, args);
    if (r.error) throw Error(friendlyError(r.error));
  }
  async function setup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await mutate(async () => {
      const settings = {
        start_date: String(form.get("date")),
        cash: signedMoney(String(form.get("cash"))),
        bank: signedMoney(String(form.get("bank"))),
        booking: signedMoney(String(form.get("booking"))),
      };
      if (ws.mode === "demo") commit({ ...data!, settings });
      else
        await rpc("garden_cash_setup", {
          p_date: settings.start_date,
          p_cash: settings.cash,
          p_bank: settings.bank,
          p_booking: settings.booking,
        });
    });
  }
  async function assign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !data) return;
    const f = new FormData(event.currentTarget);
    await mutate(async () => {
      const a: CashAllocation = {
        id: requestId.current,
        account: String(f.get("account")) as CashAccount,
        income_id: editing.kind === "income" ? editing.id : null,
        expense_id: editing.kind === "expenses" ? editing.id : null,
        payout_id: editing.kind === "payouts" ? editing.id : null,
        amount_cents: parseMoney(String(f.get("amount"))),
        posted_on: String(f.get("posted_on")),
      };
      validateCashAllocation(data, a);
      if (
        ws.mode === "demo" &&
        ws.data.partner_cash?.spends.some(
          (s) => s.allocation_id === a.id && !s.voided_at,
        )
      )
        throw Error("Use Partner cash advances to correct this linked entry.");
      if (ws.mode === "demo")
        commit({
          ...data,
          allocations: [...data.allocations.filter((x) => x.id !== a.id), a],
        });
      else
        await rpc("garden_cash_allocate", {
          p_id: a.id,
          p_kind: editing.kind,
          p_record: editing.id,
          p_account: a.account,
          p_amount: a.amount_cents,
          p_posted: a.posted_on,
        });
      setEditing(null);
    });
  }
  async function unassign(a: CashAllocation) {
    await mutate(async () => {
      if (
        ws.mode === "demo" &&
        ws.data.partner_cash?.spends.some(
          (s) => s.allocation_id === a.id && !s.voided_at,
        )
      )
        throw Error("Use Partner cash advances to correct this linked entry.");
      if (ws.mode === "demo")
        commit({
          ...data!,
          allocations: data!.allocations.filter((x) => x.id !== a.id),
        });
      else await rpc("garden_cash_unassign", { p_id: a.id });
    });
  }
  async function move(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    await mutate(async () => {
      const kind = String(f.get("kind")) as CashMovement["kind"],
        direction = String(f.get("direction"));
      const m: CashMovement = {
        id: requestId.current,
        moved_on: String(f.get("date")),
        kind,
        from_account:
          kind === "transfer" || direction === "out"
            ? (String(f.get("from")) as CashAccount)
            : null,
        to_account:
          kind === "transfer"
            ? (String(f.get("to")) as CashAccount)
            : direction === "in"
              ? (String(f.get("from")) as CashAccount)
              : null,
        amount_cents: parseMoney(String(f.get("amount"))),
        reference: String(f.get("reference")),
        reason: String(f.get("reason")).trim(),
      };
      if (m.amount_cents <= 0) throw Error("Enter a positive amount.");
      if (!m.reason) throw Error("Enter a reason.");
      if (m.from_account === m.to_account)
        throw Error("Choose two different accounts.");
      if (ws.mode === "demo") {
        const old = data!.movements.find((x) => x.id === m.id);
        if (old && JSON.stringify(old) !== JSON.stringify(m))
          throw Error("Retry key was already used.");
        if (!old) commit({ ...data!, movements: [...data!.movements, m] });
      } else
        await rpc("garden_cash_move", {
          p_id: m.id,
          p_date: m.moved_on,
          p_kind: m.kind,
          p_from: m.from_account,
          p_to: m.to_account,
          p_amount: m.amount_cents,
          p_reference: m.reference,
          p_reason: m.reason,
        });
      setMovement(false);
    });
  }
  const report = data ? cashSummary(data, asOf) : null,
    range = periodRange(ws.period, ws.reference);
  const entries =
    report?.entries.filter(
      (e) =>
        e.date >= range.start &&
        e.date <= range.end &&
        (!onlyUnassigned || e.unassigned !== 0),
    ) || [];
  const movements =
    data?.movements
      .filter(
        (m) =>
          m.moved_on >= range.start &&
          m.moved_on <= range.end &&
          m.moved_on <= asOf,
      )
      .sort((a, b) => b.moved_on.localeCompare(a.moved_on)) || [];
  function download() {
    if (!data || !report) return;
    const rows: (string | number)[][] = [
      ["The Gardens · Account balances"],
      ["As of", asOf],
      ["Opening date", data.settings?.start_date || "Not configured"],
      ["Account", "Balance PHP"],
      ...Object.keys(ACCOUNTS).map((k) => [
        ACCOUNTS[k as CashAccount],
        report.balances[k as CashAccount] / 100,
      ]),
      ["Total tracked funds", report.total / 100],
      ["Unassigned receipts", report.unassignedIn / 100],
      [
        "Income refund corrections requiring manual account handling",
        report.unassignedRefunds / 100,
      ],
      ["Unassigned payments", report.unassignedOut / 100],
      [],
      [
        "Entry date",
        "Type",
        "Description",
        "Amount PHP",
        "Assigned PHP",
        "Unassigned PHP",
      ],
      ...report.entries.map((e) => [
        e.date,
        e.kind,
        e.label,
        e.amount / 100,
        e.assigned / 100,
        e.unassigned / 100,
      ]),
      [],
      ["Date", "Movement", "From", "To", "Amount PHP", "Reference", "Reason"],
      ...data.movements
        .filter((m) => m.moved_on <= asOf)
        .map((m) => [
          m.moved_on,
          m.kind,
          m.from_account || "",
          m.to_account || "",
          m.amount_cents / 100,
          m.reference,
          m.reason,
        ]),
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + csv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `Gardens-Balances-${asOf}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="cash-tracker">
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="success-box">
          {notice}
        </p>
      )}
      <details className="panel cash-help">
        <summary>How balances work</summary>
        <p>
          Enter opening balances at the <strong>start of a day</strong>, before
          that day’s transactions. Assign income, expense and owner-payout
          entries to the account that received or paid the money. Split one
          entry across accounts when needed.
        </p>
        <p>
          Booking funds are tracked manually: include only funds the platform
          has made available to withdraw. A booking withdrawal to your bank is a
          transfer. Record platform fees once in Expenses, then assign that
          payment to Booking system. Pending bookings are excluded.
        </p>
        <p>
          Opening balances, transfers, funding and balance corrections do not
          change income, expenses, ROI or owner shares. Record real income and
          expenses in their existing modules first. This is a recorded balance,
          not a live bank feed.
        </p>
      </details>
      <div className="cash-toolbar">
        <label className="field">
          <span>Balances as of</span>
          <input
            aria-label="Balances as of"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value || asOf)}
          />
        </label>
        <button
          className="button secondary"
          disabled={loading || busy}
          onClick={() => void refresh()}
        >
          Refresh balances
        </button>
        {data?.settings && (
          <button className="button secondary" onClick={download}>
            Export balances CSV
          </button>
        )}
      </div>
      {loading ? (
        <p role="status">Loading account balances…</p>
      ) : data && !data.settings ? (
        <section className="panel cash-help">
          <h2>Set opening balances</h2>
          <p>
            No balances have been assumed from historical finance entries. Use
            the funds actually held just before transactions on the opening
            date. Booking balance means available to withdraw.
          </p>
          {admin ? (
            <form onSubmit={setup} className="cash-form">
              <label className="field">
                <span>Opening date</span>
                <input
                  name="date"
                  type="date"
                  defaultValue={
                    ws.mode === "demo" ? "2026-11-01" : todayInManila()
                  }
                  max={todayInManila()}
                  required
                />
              </label>
              {Object.entries(ACCOUNTS).map(([k, label]) => (
                <label className="field" key={k}>
                  <span>{label} (₱)</span>
                  <input
                    name={k}
                    inputMode="decimal"
                    placeholder="0.00"
                    required
                  />
                </label>
              ))}
              <p className="wide">
                Opening balances are saved once. Later corrections require a
                dated adjustment and a reason, preserving the history.
              </p>
              <button className="button primary" disabled={busy}>
                Save opening balances
              </button>
            </form>
          ) : (
            <p>A finance admin must enter the opening balances.</p>
          )}
        </section>
      ) : (
        report &&
        data?.settings && (
          <>
            <div className="cash-cards">
              {Object.entries(ACCOUNTS).map(([k, label]) => (
                <section className="panel" key={k}>
                  <p>{label}</p>
                  <strong
                    className={
                      report.balances[k as CashAccount] < 0 ? "negative" : ""
                    }
                  >
                    {report.available
                      ? money(report.balances[k as CashAccount])
                      : "Before opening date"}
                  </strong>
                  <small>
                    Opening: {money(data.settings![k as CashAccount])} ·{" "}
                    {displayDate(data.settings!.start_date)}
                  </small>
                </section>
              ))}
              <section className="panel">
                <p>Total tracked funds</p>
                <strong>{report.available ? money(report.total) : "—"}</strong>
                <small>Cash + bank + withdrawable booking funds</small>
              </section>
            </div>
            {(report.unassignedIn > 0 ||
              report.unassignedOut > 0 ||
              report.unassignedRefunds > 0) && (
              <div className="cash-warning" role="status">
                <strong>Reconciliation needed</strong>
                <p>
                  Unassigned receipts: {money(report.unassignedIn)} · Unassigned
                  payments: {money(report.unassignedOut)} · Income refund
                  corrections requiring manual cash handling:{" "}
                  {money(report.unassignedRefunds)} through {displayDate(asOf)}.
                  Receipts and payments are excluded from balances until
                  assigned. Handle negative income with a dated account
                  correction and a reason; do not add another expense. Refund
                  corrections remain listed for review. Change the period above
                  to find older entries.
                </p>
              </div>
            )}
            {Object.values(report.balances).some((n) => n < 0) && (
              <p className="cash-warning">
                An account has a negative recorded balance. Check opening funds,
                assignments and missing transfers.
              </p>
            )}
            <section className="panel cash-help">
              <div className="panel-heading">
                <div>
                  <h2>Assign finance entries</h2>
                  <p>
                    {displayDate(range.start)} – {displayDate(range.end)} ·
                    Change the period controls above to review another period.
                  </p>
                </div>
                <label>
                  <input
                    type="checkbox"
                    checked={onlyUnassigned}
                    onChange={(e) => setOnlyUnassigned(e.target.checked)}
                  />{" "}
                  Unassigned only
                </label>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date / type</th>
                      <th>Finance entry</th>
                      <th>Amount</th>
                      <th>Account assignments</th>
                      <th>Unassigned</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={`${e.kind}-${e.id}`}>
                        <td>
                          {displayDate(e.date)}
                          <small>
                            {e.kind === "income"
                              ? e.amount < 0
                                ? "Income refund correction"
                                : "Receipt"
                              : e.kind === "payouts"
                                ? "Owner payout"
                                : "Expense payment"}
                          </small>
                        </td>
                        <td>
                          {e.label}
                          <small>{e.reference || e.notes}</small>
                        </td>
                        <td>{money(e.amount)}</td>
                        <td>
                          {e.allocations.length
                            ? e.allocations.map((a) => (
                                <div key={a.id}>
                                  {ACCOUNTS[a.account]}: {money(a.amount_cents)}{" "}
                                  {admin && (
                                    <button
                                      className="text-button"
                                      disabled={busy}
                                      onClick={() => void unassign(a)}
                                    >
                                      Unassign
                                    </button>
                                  )}
                                </div>
                              ))
                            : "Not assigned"}
                        </td>
                        <td>{money(e.unassigned)}</td>
                        <td>
                          {admin && e.unassigned > 0 && (
                            <button
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => {
                                requestId.current = crypto.randomUUID();
                                setEditing(e);
                                setError("");
                              }}
                            >
                              Assign account
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!entries.length && (
                      <tr>
                        <td colSpan={6}>No matching entries in this period.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="panel cash-help">
              <div className="panel-heading">
                <div>
                  <h2>Transfers and other fund movements</h2>
                  <p>
                    Only movements in the selected period are listed. Balances
                    include all activity since opening.
                  </p>
                </div>
                {admin && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => {
                      requestId.current = crypto.randomUUID();
                      setMovement(true);
                      setError("");
                    }}
                  >
                    Record fund movement
                  </button>
                )}
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Amount</th>
                      <th>Reference / reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movements.map((m) => (
                      <tr key={m.id}>
                        <td>{displayDate(m.moved_on)}</td>
                        <td>
                          {m.kind === "partner_capital"
                            ? "Partner capital advance"
                            : m.kind}
                        </td>
                        <td>
                          {m.from_account
                            ? ACCOUNTS[m.from_account]
                            : "Outside funds"}
                        </td>
                        <td>
                          {m.to_account
                            ? ACCOUNTS[m.to_account]
                            : "Outside funds"}
                        </td>
                        <td>{money(m.amount_cents)}</td>
                        <td>
                          {m.reference}
                          <small>{m.reason}</small>
                        </td>
                      </tr>
                    ))}
                    {!movements.length && (
                      <tr>
                        <td colSpan={6}>No fund movements in this period.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p>
                Movements remain in the history. Correct a mistake with an
                opposite movement and explain the original reference.
              </p>
            </section>
          </>
        )
      )}
      {editing && (
        <CashDialog
          title="Assign an account"
          busy={busy}
          error={error}
          onClose={() => setEditing(null)}
        >
          <form onSubmit={assign} className="cash-form">
            <p className="wide">
              {editing.label} · {displayDate(editing.date)} · Unassigned{" "}
              {money(editing.unassigned)}. Use a partial amount to split across
              accounts.
            </p>
            <label className="field">
              <span>
                {editing.kind === "income" ? "Received into" : "Paid from"}
              </span>
              <select name="account">{accountOptions}</select>
            </label>
            <label className="field">
              <span>Funds date · available or paid</span>
              <input
                name="posted_on"
                type="date"
                min={editing.date}
                max={ws.mode === "demo" ? ws.asOf : todayInManila()}
                defaultValue={editing.date}
                required
              />
              <small>
                For booking receipts, use the date the platform made these funds
                withdrawable. Pending funds stay unassigned.
              </small>
            </label>
            <label className="field">
              <span>Amount (₱)</span>
              <input
                name="amount"
                defaultValue={(editing.unassigned / 100).toFixed(2)}
                inputMode="decimal"
                required
              />
            </label>
            <button className="button primary" disabled={busy}>
              Save assignment
            </button>
          </form>
        </CashDialog>
      )}
      {movement && (
        <CashDialog
          title="Record fund movement"
          busy={busy}
          error={error}
          onClose={() => setMovement(false)}
        >
          <MovementForm
            busy={busy}
            start={data!.settings!.start_date}
            onSubmit={move}
          />
        </CashDialog>
      )}
    </div>
  );
}
function CashDialog({
  title,
  busy,
  error,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="record-dialog cash-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="cash-help">
        <div className="panel-heading">
          <h2>{title}</h2>
          <button
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );
}
function MovementForm({
  busy,
  start,
  onSubmit,
}: {
  busy: boolean;
  start: string;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}) {
  const [kind, setKind] = useState("transfer");
  return (
    <form onSubmit={onSubmit} className="cash-form">
      <label className="field">
        <span>Movement type</span>
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="transfer">Transfer between accounts</option>
          <option value="funding">Outside funding / withdrawal</option>
          <option value="adjustment">Balance correction</option>
        </select>
      </label>
      <label className="field">
        <span>Actual date</span>
        <input
          name="date"
          type="date"
          min={start}
          max={todayInManila()}
          defaultValue={todayInManila()}
          required
        />
      </label>
      {kind !== "transfer" && (
        <label className="field">
          <span>Direction</span>
          <select name="direction">
            <option value="in">Increase this account</option>
            <option value="out">Decrease this account</option>
          </select>
        </label>
      )}
      <label className="field">
        <span>{kind === "transfer" ? "From account" : "Account"}</span>
        <select name="from">{accountOptions}</select>
      </label>
      {kind === "transfer" && (
        <label className="field">
          <span>To account</span>
          <select name="to" defaultValue="bank">
            {accountOptions}
          </select>
        </label>
      )}
      <label className="field">
        <span>Amount (₱)</span>
        <input name="amount" inputMode="decimal" placeholder="0.00" required />
      </label>
      <label className="field">
        <span>Reference</span>
        <input name="reference" maxLength={120} />
      </label>
      <label className="field wide">
        <span>Reason</span>
        <textarea name="reason" maxLength={1000} required />
      </label>
      <p className="wide">
        This moves balances only. Record actual sales and costs once in Income /
        Expenses. Capital contributions must also be recorded in ROI if you want
        them included in invested capital. Corrections and funding must not
        replace missing income or expense entries.
      </p>
      {kind === "funding" && (
        <p className="notice wide">
          For cash a partner gives The Gardens to repay later, use{" "}
          <a href="/installments/#partner-cash-advances">Partner Advances</a>.
          It records the cash and the amount owed together.
        </p>
      )}
      <button className="button primary" disabled={busy}>
        Save movement
      </button>
    </form>
  );
}
