"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { money, parseMoney, todayInManila } from "@/lib/finance";
import { OWNERS } from "@/lib/types";
import type { CashData } from "@/lib/balances";
import { emptyPartnerCash, type PartnerCashAction } from "@/lib/partner-cash";
export type PartnerCashSave = (
  action: PartnerCashAction,
  id: string,
  payload: Record<string, unknown>,
  cash: CashData,
) => Promise<void>;
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
export function PartnerCashEditForm({
  action,
  record,
  cash,
  onSave,
  onSaved,
  onClose,
}: {
  action: PartnerCashAction;
  record?: string;
  cash: CashData;
  onSave: PartnerCashSave;
  onSaved: () => Promise<void>;
  onClose: () => void;
}) {
  const p = cash.finance.partner_cash ?? emptyPartnerCash(),
    receipt = action === "edit_receipt",
    a = p.advances.find((a) => a.id === record),
    r = p.repayments.find((r) => r.id === record),
    item = receipt ? a : r;
  const owned = receipt ? a?.owned_receipt : r?.owned_movement,
    hasPayments =
      receipt &&
      p.repayments.some((r) => r.advance_id === a?.id && !r.voided_at);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [schedule, setSchedule] = useState(
      a && a.monthly_cents !== a.amount_cents ? "monthly" : "single",
    );
  const dialog = useRef<HTMLDialogElement>(null),
    working = useRef(false),
    retry = useRef<{ key: string; id: string } | null>(null),
    today = todayInManila();
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (working.current || !item) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const f = new FormData(event.currentTarget),
        get = (k: string) => String(f.get(k) || "").trim();
      const amount = owned ? parseMoney(get("amount")) : item!.amount_cents;
      const payload: Record<string, unknown> = {
        record_id: record,
        expected: item,
        amount_cents: amount,
        account: owned
          ? get("account")
          : receipt
            ? a!.detail.to_account
            : r!.detail.from_account,
        reference: owned ? get("reference") : item.detail.reference,
        reason: get("reason"),
      };
      if (receipt) {
        Object.assign(payload, {
          owner: hasPayments ? a!.owner : get("owner"),
          purpose: get("purpose"),
          received_on: owned ? get("date") : a!.received_on,
          monthly_cents:
            schedule === "single" ? amount : parseMoney(get("monthly")),
          first_due: get("first_due"),
        });
      } else payload.paid_on = get("date");
      const key = JSON.stringify(payload);
      if (retry.current?.key !== key)
        retry.current = { key, id: crypto.randomUUID() };
      await onSave(action, retry.current.id, payload, cash);
      await onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save. Retry this edit if the response was lost.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="record-dialog partner-dialog"
      aria-labelledby="partner-edit-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">PARTNER ADVANCES</span>
          <h2 id="partner-edit-title">
            {receipt ? "Edit advance" : "Edit repayment"}
          </h2>
        </div>
        <button className="button secondary" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
      <form onSubmit={submit}>
        <fieldset className="partner-fields" disabled={busy}>
          <div className="form-grid">
            {!item ? (
              <p className="error-box wide">
                This record is no longer available. Close and refresh.
              </p>
            ) : (
              <>
                <p className="partner-help wide">
                  Correct the original entry. Its linked cash entry is updated
                  once; this does not record another receipt or payment. For
                  additional money received, create a new advance.
                </p>
                {!owned && (
                  <p className="notice wide">
                    This record links a pre-existing fund movement.{" "}
                    {receipt
                      ? "Its amount, receipt date, account and reference stay unchanged; you can edit the partner, purpose and repayment terms."
                      : "Remove this link and choose the corrected source instead."}
                  </p>
                )}
                {receipt && a && (
                  <>
                    <Field label="Partner">
                      <select
                        name="owner"
                        defaultValue={a.owner}
                        disabled={hasPayments}
                      >
                        {OWNERS.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Purpose" wide>
                      <textarea
                        name="purpose"
                        defaultValue={a.purpose}
                        maxLength={900}
                        required
                      />
                    </Field>
                    {hasPayments && (
                      <p className="partner-help wide">
                        Correct existing repayments before changing the partner.
                      </p>
                    )}
                  </>
                )}
                <Field
                  label={
                    receipt ? "Actual receipt date" : "Actual repayment date"
                  }
                >
                  <input
                    type="date"
                    name="date"
                    defaultValue={receipt ? a?.received_on : r?.paid_on}
                    min={cash.settings?.start_date}
                    max={today}
                    disabled={!owned}
                    required
                  />
                </Field>
                <Field label={receipt ? "Received into" : "Paid from"}>
                  <select
                    name="account"
                    defaultValue={
                      (receipt
                        ? a?.detail.to_account
                        : r?.detail.from_account) || "cash"
                    }
                    disabled={!owned}
                  >
                    <option value="cash">Cash on hand</option>
                    <option value="bank">Bank</option>
                  </select>
                </Field>
                <Field label="Amount (₱)">
                  <input
                    name="amount"
                    inputMode="decimal"
                    defaultValue={(item.amount_cents / 100).toFixed(2)}
                    disabled={!owned}
                    required
                  />
                </Field>
                <Field label="Reference">
                  <input
                    name="reference"
                    defaultValue={item.detail.reference}
                    maxLength={120}
                    disabled={!owned}
                  />
                </Field>
                {receipt && a && (
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
                        name="first_due"
                        type="date"
                        defaultValue={a.first_due}
                        min={cash.settings?.start_date}
                        max="2100-12-31"
                        required
                      />
                    </Field>
                    {schedule === "monthly" && (
                      <Field label="Monthly repayment (₱)">
                        <input
                          name="monthly"
                          inputMode="decimal"
                          defaultValue={(a.monthly_cents / 100).toFixed(2)}
                          required
                        />
                      </Field>
                    )}
                  </>
                )}
                <Field label="Reason for edit" wide>
                  <textarea name="reason" maxLength={1000} required />
                </Field>
                <label className="partner-check wide">
                  <input type="checkbox" required />I reviewed the correction
                  and its effect on the balance owed and account funds.
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
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !item || (!receipt && !owned)}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
