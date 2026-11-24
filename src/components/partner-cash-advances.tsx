"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { useWorkspace } from "./workspace-provider";
import { canManage } from "@/lib/access";
import { getBackend, friendlyError } from "@/lib/backend";
import {
  money,
  displayDate,
  todayInManila,
  parseMoney,
  csv,
} from "@/lib/finance";
import { OWNERS } from "@/lib/types";
import { ACCOUNTS, demoCash, type CashData } from "@/lib/balances";
import {
  emptyPartnerCash,
  partnerCashSummary,
  partnerCashCsvRows,
  type PartnerCashAction,
} from "@/lib/partner-cash";
import { applyPartnerCashDemo } from "@/lib/partner-cash-demo";
const STORE = "gardens.balances.sample.v1";
const titles: Record<PartnerCashAction, string> = {
  receive: "Receive partner advance",
  purchase: "Link an expense (optional)",
  repay: "Record repayment",
  void_receipt: "Correct an advance receipt",
  void_purchase: "Correct a purchase link",
  void_repayment: "Correct a repayment",
};
function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}
export function PartnerCashSummary() {
  const ws = useWorkspace(),
    p = ws.data.partner_cash ?? emptyPartnerCash();
  const rows = p.advances
    .map((a) => ({ ...a, ...partnerCashSummary(p, a, ws.asOf) }))
    .filter((a) => a.active);
  if (!rows.length) return null;
  const next = rows
    .filter((a) => a.next)
    .sort((a, b) => a.next!.localeCompare(b.next!))[0];
  return (
    <section className="panel partner-summary">
      <div>
        <span className="eyebrow">PARTNER CASH ADVANCES</span>
        <h2>Gardens owes partners</h2>
        <p>As of {displayDate(ws.asOf)}</p>
      </div>
      <div>
        <span>Still owed</span>
        <strong>{money(rows.reduce((n, a) => n + a.remaining, 0))}</strong>
      </div>
      <div>
        <span>Overdue</span>
        <strong className={rows.some((a) => a.overdue) ? "negative" : ""}>
          {money(rows.reduce((n, a) => n + a.overdue, 0))}
        </strong>
        <Link href="/installments/#partner-cash-advances">
          View repayment dates
        </Link>
        {next && (
          <small>
            Next unpaid due: {displayDate(next.next!)} · {next.owner}
          </small>
        )}
      </div>
    </section>
  );
}
export function PartnerCashAdvances() {
  const ws = useWorkspace(),
    admin = canManage(ws.profile, "finance"),
    p = ws.data.partner_cash ?? emptyPartnerCash();
  const [form, setForm] = useState<{
      action: PartnerCashAction;
      record?: string;
      cash: CashData;
    } | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false),
    [showClosed, setShowClosed] = useState(false);
  const visible = p.advances.filter(
    (a) =>
      showClosed ||
      (!a.voided_at &&
        (a.received_on > ws.asOf ||
          partnerCashSummary(p, a, ws.asOf).remaining > 0)),
  );
  async function open(action: PartnerCashAction, record?: string) {
    if (loading) return;
    setLoading(true);
    setError("");
    setNotice("");
    try {
      let cash: CashData;
      if (ws.mode === "demo") {
        let saved;
        try {
          saved = JSON.parse(localStorage.getItem(STORE) || "null");
        } catch {}
        cash = { ...demoCash(ws.data), ...saved, finance: ws.data };
      } else {
        const result = await getBackend()!.rpc("garden_balances_snapshot");
        if (result.error) throw Error(friendlyError(result.error));
        cash = result.data;
      }
      setForm({ action, record, cash });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load balances.");
    } finally {
      setLoading(false);
    }
  }
  function exportRows() {
    const rows = partnerCashCsvRows(p, ws.asOf);
    const url = URL.createObjectURL(
        new Blob([csv(rows)], { type: "text/csv;charset=utf-8" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = `Gardens - Partner cash advances - ${ws.asOf}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="panel partner-panel" id="partner-cash-advances">
      <span id="partner-advances" />
      <div className="panel-heading">
        <div>
          <span className="eyebrow">GARDENS OWES THE PARTNER</span>
          <h2>Partner Advances</h2>
          <p>
            Record cash a partner gives The Gardens for expenses, then track
            what has been repaid and what is still owed.
          </p>
        </div>
        <div className="button-row">
          <button className="button secondary" onClick={exportRows}>
            Export CSV
          </button>
          {admin && (
            <button
              className="button primary"
              disabled={loading}
              onClick={() => void open("receive")}
            >
              {loading ? "Loading…" : "Receive advance"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <p className="partner-help">
        Receive advance → record purchases in{" "}
        <Link href="/expenses/">Expenses</Link> → record repayment here.
        Receiving and repaying an advance update Cash or Bank automatically. You
        do not need a separate fund movement.
      </p>
      <div className="partner-cash-controls">
        <span>Balances as of {displayDate(ws.asOf)}</span>
        <label>
          <input
            type="checkbox"
            checked={showClosed}
            onChange={(e) => setShowClosed(e.target.checked)}
          />
          Show repaid and voided advances
        </label>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Partner / purpose</th>
              <th>Received</th>
              <th>Cash received</th>
              <th>Repaid</th>
              <th>Still owed</th>
              <th>Next due / overdue</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((a) => {
              const s = partnerCashSummary(p, a, ws.asOf);
              return (
                <tr key={a.id}>
                  <td>
                    <strong>{a.owner}</strong>
                    <small>{a.purpose}</small>
                    {a.voided_at && <small>Voided: {a.void_reason}</small>}
                  </td>
                  <td>
                    {displayDate(a.received_on)}
                    <small>
                      {a.detail.to_account && ACCOUNTS[a.detail.to_account]}
                    </small>
                    <small>{a.detail.reference}</small>
                  </td>
                  <td>{money(a.amount_cents)}</td>
                  <td>{money(s.repaid)}</td>
                  <td>
                    <strong>{money(s.remaining)}</strong>
                  </td>
                  <td>
                    {a.voided_at
                      ? "Voided"
                      : !s.active
                        ? "After as-of date"
                        : s.next
                          ? displayDate(s.next)
                          : "Repaid"}
                    {s.overdue > 0 && (
                      <small className="negative">
                        {money(s.overdue)} overdue
                      </small>
                    )}
                    <small>
                      {a.monthly_cents === a.amount_cents
                        ? "Single repayment"
                        : money(a.monthly_cents) + " monthly"}{" "}
                      · first due {displayDate(a.first_due)}
                    </small>
                  </td>
                  <td>
                    {admin && !a.voided_at && (
                      <div className="partner-actions">
                        {partnerCashSummary(p, a, todayInManila()).remaining >
                          0 && (
                          <button
                            className="button secondary"
                            disabled={loading}
                            onClick={() => void open("repay", a.id)}
                          >
                            Record repayment
                          </button>
                        )}
                        <details className="partner-cash-more">
                          <summary>More options</summary>
                          <button
                            className="text-button"
                            disabled={loading}
                            onClick={() => void open("purchase", a.id)}
                          >
                            Link an existing expense (optional)
                          </button>
                          <button
                            className="button secondary"
                            disabled={loading}
                            onClick={() => void open("void_receipt", a.id)}
                          >
                            Correct receipt
                          </button>
                        </details>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {!visible.length && (
              <tr>
                <td colSpan={7}>
                  No outstanding partner advances. Use Receive advance when a
                  partner gives The Gardens cash to repay later.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <details className="cash-advance-history">
        <summary>Repayment history and optional expense links</summary>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type / partner</th>
                <th>Purpose / details</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Account / reference</th>
                <th>Status / correction</th>
              </tr>
            </thead>
            <tbody>
              {p.spends.map((s) => (
                <tr key={s.id}>
                  <td>
                    Purchase ·{" "}
                    {p.advances.find((a) => a.id === s.advance_id)?.owner}
                  </td>
                  <td>
                    {s.detail.expense.notes}
                    <small>
                      Full expense {money(s.detail.expense.amount_cents)} ·
                      funded portion shown
                    </small>
                  </td>
                  <td>{displayDate(s.detail.expense.paid_on)}</td>
                  <td>{money(s.amount_cents)}</td>
                  <td>
                    {ACCOUNTS[s.detail.allocation.account]}
                    <small>{s.detail.expense.reference}</small>
                  </td>
                  <td>
                    {s.voided_at ? (
                      `Voided: ${s.void_reason}`
                    ) : admin ? (
                      <button
                        className="button secondary"
                        disabled={loading}
                        onClick={() => void open("void_purchase", s.id)}
                      >
                        Correct purchase
                      </button>
                    ) : (
                      "Active"
                    )}
                  </td>
                </tr>
              ))}
              {p.repayments.map((r) => (
                <tr key={r.id}>
                  <td>
                    Repayment ·{" "}
                    {p.advances.find((a) => a.id === r.advance_id)?.owner}
                  </td>
                  <td>
                    {p.advances.find((a) => a.id === r.advance_id)?.purpose}
                  </td>
                  <td>{displayDate(r.paid_on)}</td>
                  <td>{money(r.amount_cents)}</td>
                  <td>
                    {r.detail.from_account && ACCOUNTS[r.detail.from_account]}
                    <small>{r.detail.reference}</small>
                  </td>
                  <td>
                    {r.voided_at ? (
                      `Voided: ${r.void_reason}`
                    ) : admin ? (
                      <button
                        className="button secondary"
                        disabled={loading}
                        onClick={() => void open("void_repayment", r.id)}
                      >
                        Correct repayment
                      </button>
                    ) : (
                      "Active"
                    )}
                  </td>
                </tr>
              ))}
              {!p.spends.length && !p.repayments.length && (
                <tr>
                  <td colSpan={6}>No repayments or expense links yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
      <p className="partner-help">
        The amount owed changes only when you repay the partner. A purchase is
        recorded once in Expenses. Repayments are not additional expenses and do
        not change capital or profit shares.
      </p>
      {form && (
        <CashAdvanceForm
          key={`${form.action}:${form.record || ""}`}
          {...form}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            setNotice(
              form.action === "receive"
                ? "Advance received. The Gardens now owes this amount to the partner."
                : form.action === "repay"
                  ? "Repayment recorded. The amount owed and account funds have been reduced."
                  : "Saved. The linked record has been updated.",
            );
            if (ws.mode === "live") await ws.refresh();
          }}
        />
      )}
    </section>
  );
}

function CashAdvanceForm({
  action,
  record,
  cash,
  onClose,
  onSaved,
}: {
  action: PartnerCashAction;
  record?: string;
  cash: CashData;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const ws = useWorkspace(),
    dialog = useRef<HTMLDialogElement>(null),
    working = useRef(false),
    retry = useRef<{ key: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [link, setLink] = useState(action === "purchase"),
    [source, setSource] = useState(""),
    [allocation, setAllocation] = useState(""),
    [schedule, setSchedule] = useState("single");
  const p = cash.finance.partner_cash ?? emptyPartnerCash(),
    a = p.advances.find((a) => a.id === record),
    today = todayInManila(),
    correction = action.startsWith("void_");
  const expense = cash.finance.expenses.find((e) => e.id === source),
    movement = cash.movements.find((m) => m.id === source),
    assigned = cash.allocations.find((c) => c.id === allocation);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const candidates = cash.movements.filter(
    (m) =>
      m.kind === "funding" &&
      (action === "receive"
        ? !!m.to_account && !m.from_account
        : !!m.from_account && !m.to_account) &&
      ["cash", "bank"].includes(
        (action === "receive" ? m.to_account : m.from_account) || "",
      ) &&
      (!a || m.moved_on >= a.received_on) &&
      !p.advances.some((a) => !a.voided_at && a.receipt_id === m.id) &&
      !p.repayments.some((r) => !r.voided_at && r.movement_id === m.id),
  );
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (!canManage(ws.profile, "finance"))
        throw Error("Finance management permission required.");
      const f = new FormData(event.currentTarget),
        get = (k: string) => String(f.get(k) || "").trim();
      let payload: Record<string, unknown>;
      if (correction) payload = { record_id: record, reason: get("reason") };
      else if (action === "receive") {
        if (link && !movement)
          throw Error("Choose an existing funding receipt.");
        const amount = link
          ? movement!.amount_cents
          : parseMoney(get("amount"));
        payload = {
          owner: get("owner"),
          purpose: get("purpose"),
          received_on: link ? movement!.moved_on : get("date"),
          amount_cents: amount,
          monthly_cents:
            schedule === "single" ? amount : parseMoney(get("monthly")),
          first_due: get("first_due"),
          account: link ? movement!.to_account : get("account"),
          reference: link ? movement!.reference : get("reference"),
          ...(link ? { movement_id: source } : {}),
        };
      } else if (action === "repay") {
        if (link && !movement)
          throw Error("Choose an existing repayment withdrawal.");
        payload = {
          advance_id: record,
          paid_on: link ? movement!.moved_on : get("date"),
          amount_cents: link
            ? movement!.amount_cents
            : parseMoney(get("amount")),
          account: link ? movement!.from_account : get("account"),
          reference: link ? movement!.reference : get("reference"),
          ...(link ? { movement_id: source } : {}),
        };
      } else {
        if (link && !expense)
          throw Error("Choose an existing operating expense.");
        const total = link ? expense!.amount_cents : parseMoney(get("total"));
        payload = {
          advance_id: record,
          paid_on: link ? expense!.paid_on : get("date"),
          amount_cents: get("portion") ? parseMoney(get("portion")) : total,
          total_cents: total,
          account: assigned?.account || get("account"),
          category_id: link ? expense!.category_id : get("category_id"),
          notes: link ? expense!.notes : get("notes"),
          reference: link ? expense!.reference : get("reference"),
          ...(link
            ? {
                expense_id: source,
                expected_total_cents: expense!.amount_cents,
                ...(allocation ? { allocation_id: allocation } : {}),
              }
            : {}),
        };
      }
      const key = JSON.stringify(payload);
      if (retry.current?.key !== key)
        retry.current = { key, id: crypto.randomUUID() };
      if (ws.mode === "demo") {
        const next = applyPartnerCashDemo(
          ws.data,
          cash,
          action,
          retry.current.id,
          payload,
          today,
        );
        localStorage.setItem(
          STORE,
          JSON.stringify({ ...next.balances, finance: undefined }),
        );
        ws.commitDemoFinance(next.data);
      } else {
        if (!navigator.onLine)
          throw Error("Reconnect, then retry this same action.");
        const result = await getBackend()!.rpc("garden_partner_cash_command", {
          p_action: action,
          p_id: retry.current.id,
          p_payload: payload,
        });
        if (result.error) throw Error(friendlyError(result.error));
      }
      await onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save. Retry the same action if the response was lost.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const sourceSp = p.spends.find((s) => s.id === record),
    sourceRp = p.repayments.find((r) => r.id === record);
  const owned =
    action === "void_receipt"
      ? a?.owned_receipt
      : action === "void_purchase"
        ? sourceSp?.owned_expense
        : sourceRp?.owned_movement;
  return (
    <dialog
      ref={dialog}
      className="record-dialog partner-dialog"
      aria-labelledby="cash-advance-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">PARTNER CASH ADVANCE</span>
          <h2 id="cash-advance-title">{titles[action]}</h2>
        </div>
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
      <form onSubmit={submit}>
        <fieldset className="partner-fields" disabled={busy}>
          <div className="form-grid">
            {a && (
              <p className="wide">
                <strong>
                  {a.owner} · {a.purpose}
                </strong>
                <br />
                Outstanding: {money(
                  partnerCashSummary(p, a, today).remaining,
                )}{" "}
                · received {displayDate(a.received_on)}
              </p>
            )}
            {correction ? (
              <>
                <p className="wide">
                  This corrects a mistaken entry; it does not return actual
                  money.{" "}
                  {owned
                    ? "The entry created by this workflow and its account effect will be removed; its audit history stays."
                    : "The pre-existing entry stays in Finance and balances; only this advance link is removed."}
                  {action === "void_purchase" &&
                  sourceSp?.owned_allocation &&
                  !sourceSp.owned_expense
                    ? " The account assignment created when linking will also be removed."
                    : ""}
                </p>
                <Field label="Correction reason" wide>
                  <textarea name="reason" maxLength={1000} required />
                </Field>
                <label className="partner-check wide">
                  <input type="checkbox" required />I reviewed the correction
                  and its effect on balances.
                </label>
              </>
            ) : (
              <>
                {action !== "purchase" && candidates.length > 0 && (
                  <Field
                    label="Already recorded this cash movement? (optional)"
                    wide
                  >
                    <select
                      value={link ? "existing" : "new"}
                      onChange={(e) => {
                        setLink(e.target.value === "existing");
                        setSource("");
                        setAllocation("");
                      }}
                    >
                      <option value="new">
                        Create new{" "}
                        {action === "receive" ? "receipt" : "repayment"}
                      </option>
                      <option value="existing">
                        Link existing fund movement — do not post again
                      </option>
                    </select>
                  </Field>
                )}
                {action === "receive" && (
                  <>
                    <Field label="Partner">
                      <select name="owner" required>
                        {OWNERS.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Purpose" wide>
                      <textarea
                        name="purpose"
                        placeholder="Linix — repayable cash advance"
                        maxLength={900}
                        required
                      />
                    </Field>
                  </>
                )}
                {link && (
                  <Field
                    label={
                      action === "purchase"
                        ? "Existing operating expense"
                        : "Existing outside-funding movement"
                    }
                    wide
                  >
                    <select
                      value={source}
                      required
                      onChange={(e) => {
                        setSource(e.target.value);
                        setAllocation("");
                      }}
                    >
                      <option value="">Choose and review an entry</option>
                      {action === "purchase"
                        ? cash.finance.expenses
                            .filter(
                              (e) =>
                                e.payment_kind === "operating" &&
                                !e.staff_payment_id &&
                                (!a || e.paid_on >= a.received_on),
                            )
                            .map((e) => (
                              <option value={e.id} key={e.id}>
                                {e.paid_on} · {money(e.amount_cents)} ·{" "}
                                {e.notes || e.reference || e.id}
                              </option>
                            ))
                        : candidates.map((m) => (
                            <option value={m.id} key={m.id}>
                              {m.moved_on} · {money(m.amount_cents)} ·{" "}
                              {m.reason}
                            </option>
                          ))}
                    </select>
                  </Field>
                )}
                {link && movement && (
                  <p className="notice wide">
                    {displayDate(movement.moved_on)} ·{" "}
                    {money(movement.amount_cents)} ·{" "}
                    {
                      ACCOUNTS[
                        (action === "receive"
                          ? movement.to_account
                          : movement.from_account)!
                      ]
                    }
                    <br />
                    {movement.reference} · {movement.reason}
                  </p>
                )}
                {link && expense && (
                  <>
                    <p className="notice wide">
                      {displayDate(expense.paid_on)} ·{" "}
                      {money(expense.amount_cents)}
                      <br />
                      {expense.notes} · {expense.reference}
                    </p>
                    <Field label="Account assignment" wide>
                      <select
                        value={allocation}
                        onChange={(e) => setAllocation(e.target.value)}
                      >
                        <option value="">
                          Create an assignment for the funded portion
                        </option>
                        {cash.allocations
                          .filter(
                            (c) =>
                              c.expense_id === expense.id &&
                              ["cash", "bank"].includes(c.account) &&
                              (c.posted_on || expense.paid_on) ===
                                expense.paid_on,
                          )
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {ACCOUNTS[c.account]} · {money(c.amount_cents)} ·{" "}
                              {c.posted_on || expense.paid_on}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <p className="partner-help wide">
                      If this expense is already assigned, choose its existing
                      assignment. Existing assigned funds are not deducted
                      again.
                    </p>
                  </>
                )}
                {!link && (
                  <Field
                    label={
                      action === "receive"
                        ? "Actual receipt date"
                        : "Actual payment date"
                    }
                  >
                    <input
                      name="date"
                      type="date"
                      min={a?.received_on || cash.settings?.start_date}
                      max={today}
                      defaultValue={today}
                      required
                    />
                  </Field>
                )}
                {(!link || (action === "purchase" && !assigned)) && (
                  <Field
                    label={action === "receive" ? "Receive into" : "Paid from"}
                  >
                    <select name="account" required>
                      <option value="cash">Cash on hand</option>
                      <option value="bank">Bank</option>
                    </select>
                  </Field>
                )}
                {!link && action !== "purchase" && (
                  <Field label="Amount (₱)">
                    <input
                      name="amount"
                      inputMode="decimal"
                      required
                      placeholder="25,000.00"
                      defaultValue={
                        action === "repay" && a
                          ? (
                              partnerCashSummary(p, a, today).remaining / 100
                            ).toFixed(2)
                          : undefined
                      }
                    />
                  </Field>
                )}
                {action === "purchase" && (
                  <>
                    {!link && (
                      <>
                        <Field label="Purchase description" wide>
                          <textarea
                            name="notes"
                            maxLength={1000}
                            required
                            defaultValue={a?.purpose}
                          />
                        </Field>
                        <Field label="Expense category">
                          <select name="category_id" required>
                            <option value="">Choose category</option>
                            {cash.finance.categories
                              .filter((c) => c.kind === "expense" && c.active)
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                          </select>
                        </Field>
                        <Field label="Full purchase amount (₱)">
                          <input name="total" inputMode="decimal" required />
                        </Field>
                      </>
                    )}
                    <Field
                      label="Funded by this advance (₱) — blank means full purchase"
                      wide
                    >
                      <input
                        name="portion"
                        inputMode="decimal"
                        placeholder="Leave blank to fund the entire purchase"
                      />
                    </Field>
                  </>
                )}
                {!link && (
                  <Field label="Reference" wide>
                    <input name="reference" maxLength={120} />
                  </Field>
                )}
                {action === "receive" && (
                  <>
                    <Field label="Repayment schedule">
                      <select
                        value={schedule}
                        onChange={(e) => setSchedule(e.target.value)}
                      >
                        <option value="single">One repayment date</option>
                        <option value="monthly">Monthly installments</option>
                      </select>
                    </Field>
                    <Field
                      label={
                        schedule === "single"
                          ? "Repayment due date"
                          : "First installment due date"
                      }
                    >
                      <input
                        type="date"
                        name="first_due"
                        min={
                          link && movement
                            ? movement.moved_on
                            : cash.settings?.start_date
                        }
                        max="2100-12-31"
                        required
                      />
                    </Field>
                    {schedule === "monthly" && (
                      <Field label="Monthly repayment (₱)">
                        <input name="monthly" inputMode="decimal" required />
                      </Field>
                    )}
                  </>
                )}
                <p className="partner-help wide">
                  {action === "receive"
                    ? "Creates debt and one cash inflow. No income, expense, capital credit or owner-share deduction."
                    : action === "repay"
                      ? "Reduces debt and cash once. No additional expense or owner payout. Partial payments and returns of unused money are supported."
                      : "Links an existing expense without creating another expense. The amount owed to the partner does not change."}
                </p>
                <label className="partner-check wide">
                  <input type="checkbox" required />I reviewed the amount, date,
                  account and any existing entry selected.
                </label>
              </>
            )}
          </div>
        </fieldset>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy
              ? "Saving…"
              : correction
                ? "Confirm correction"
                : link
                  ? "Confirm existing-entry link"
                  : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
