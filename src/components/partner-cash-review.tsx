"use client";
import { useEffect, useRef, useState } from "react";
import { money, displayDate } from "@/lib/finance";
import type { PartnerCashImpact } from "@/lib/distribution";

export function PartnerCashReview({
  impact,
  onConfirm,
  onCancel,
}: {
  impact: PartnerCashImpact;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  const b = impact.before,
    a = impact.after;
  const changes = new Map<string, number>();
  for (const [events, sign] of [
    [b.events, -1],
    [a.events, 1],
  ] as const)
    for (const e of events)
      changes.set(
        e.date,
        (changes.get(e.date) || 0) +
          sign * (e.funded_cents - e.reimbursed_cost_cents),
      );
  return (
    <dialog
      ref={dialog}
      className="record-dialog partner-dialog"
      aria-labelledby="partner-review-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">REVIEW BEFORE SAVING</span>
          <h2 id="partner-review-title">Partner advance payout impact</h2>
        </div>
      </div>
      <div className="partner-review-body">
        <p>
          Cash follows the actual payments. Owner shares use income available
          for payouts, after the adjustments below.
        </p>
        {impact.retry && (
          <p className="notice">
            This action was already saved. Confirming again will not create
            another entry.
          </p>
        )}
        {impact.repayment && (
          <section className="panel" aria-label="Repayment split">
            <h3>Repayment on {displayDate(impact.repayment.date)}</h3>
            <p>
              Reimburses linked purchases:{" "}
              <strong>{money(impact.repayment.reimbursed_cost_cents)}</strong>
            </p>
            <p>
              Returns unused advance:{" "}
              <strong>{money(impact.repayment.unused_return_cents)}</strong> —
              no payout deduction.
            </p>
          </section>
        )}
        <dl className="payment-breakdown">
          <div>
            <dt>Change in recorded operating result</dt>
            <dd>
              {money(a.operating_result_cents - b.operating_result_cents)}
            </dd>
          </div>
          <div>
            <dt>Change in funded-purchase addbacks</dt>
            <dd>
              {money(a.funded_purchases_cents - b.funded_purchases_cents)}
            </dd>
          </div>
          <div>
            <dt>Change in reimbursed-cost deductions</dt>
            <dd>{money(a.reimbursed_cost_cents - b.reimbursed_cost_cents)}</dd>
          </div>
          <div>
            <dt>Overall change in payout basis</dt>
            <dd>{money(a.payout_basis_cents - b.payout_basis_cents)}</dd>
          </div>
        </dl>
        {[...changes].filter(([, n]) => n).length > 0 && (
          <details open>
            <summary>Purchase and repayment adjustments by date</summary>
            <ul>
              {[...changes]
                .filter(([, n]) => n)
                .sort(([x], [y]) => x.localeCompare(y))
                .map(([date, amount]) => (
                  <li key={date}>
                    {displayDate(date)}: {money(amount)}
                  </li>
                ))}
            </ul>
          </details>
        )}
        <p className="partner-help">
          Confirmed owner settlements retain their saved amounts. Affected
          months will require review and reversal/reconfirmation. This does not
          send money.
        </p>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="button secondary"
            disabled={busy}
            onClick={onCancel}
          >
            Back
          </button>
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await onConfirm();
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Unable to save. Refresh the preview and retry.",
                );
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Confirm save"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
