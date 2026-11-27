import type { Dataset } from "./types";
import type { PartnerCashData } from "./partner-cash";

export interface DistributionEvent {
  id: string;
  advance_id: string;
  date: string;
  kind: "purchase" | "repayment";
  amount_cents: number;
  funded_cents: number;
  reimbursed_cost_cents: number;
  unused_return_cents: number;
  allocations: { spend_id: string; amount_cents: number }[];
}
export interface DistributionBasis {
  version: "partner_repayment_v1";
  start: string;
  end: string;
  operating_result_cents: number;
  funded_purchases_cents: number;
  reimbursed_cost_cents: number;
  unused_return_cents: number;
  payout_basis_cents: number;
  distributable_cents: number;
  events: DistributionEvent[];
}

/** Replay actual dated events; no editable parallel financial ledger. */
export function partnerCostLedger(p: PartnerCashData): DistributionEvent[] {
  const result: DistributionEvent[] = [];
  for (const advance of p.advances.filter((a) => !a.voided_at)) {
    let funded = 0,
      returned = 0,
      repaid = 0;
    const queue: { id: string; remaining: number }[] = [];
    const events = [
      ...p.spends
        .filter((s) => s.advance_id === advance.id && !s.voided_at)
        .map((s) => ({
          id: s.id,
          date: s.detail.expense.paid_on,
          kind: "purchase" as const,
          recorded: "",
          amount: s.amount_cents,
        })),
      ...p.repayments
        .filter((r) => r.advance_id === advance.id && !r.voided_at)
        .map((r) => ({
          id: r.id,
          date: r.paid_on,
          kind: "repayment" as const,
          recorded: r.created_at || "",
          amount: r.amount_cents,
        })),
    ].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        (a.kind === b.kind
          ? a.recorded.localeCompare(b.recorded) || a.id.localeCompare(b.id)
          : a.kind === "purchase"
            ? -1
            : 1),
    );
    for (const e of events) {
      if (
        e.date < advance.received_on ||
        !Number.isSafeInteger(e.amount) ||
        e.amount <= 0
      )
        throw Error(
          "Advance history is inconsistent. Review receipt, purchase and repayment dates and amounts.",
        );
      const entry: DistributionEvent = {
        id: e.id,
        advance_id: advance.id,
        date: e.date,
        kind: e.kind,
        amount_cents: e.amount,
        funded_cents: 0,
        reimbursed_cost_cents: 0,
        unused_return_cents: 0,
        allocations: [],
      };
      if (e.kind === "purchase") {
        funded += e.amount;
        if (funded + returned > advance.amount_cents)
          throw Error(
            "Linked funding exceeds cash retained from this advance. Reduce the funded portion or correct the earlier unused-funds return.",
          );
        queue.push({ id: e.id, remaining: e.amount });
        entry.funded_cents = e.amount;
      } else {
        repaid += e.amount;
        if (repaid > advance.amount_cents)
          throw Error("Repayment cannot exceed the outstanding debt.");
        let remaining = e.amount;
        for (const cost of queue) {
          const take = Math.min(remaining, cost.remaining);
          if (take)
            entry.allocations.push({ spend_id: cost.id, amount_cents: take });
          cost.remaining -= take;
          remaining -= take;
          if (!remaining) break;
        }
        entry.reimbursed_cost_cents = e.amount - remaining;
        entry.unused_return_cents = remaining;
        returned += remaining;
      }
      result.push(entry);
    }
  }
  return result.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind
        ? a.id.localeCompare(b.id)
        : a.kind === "purchase"
          ? -1
          : 1),
  );
}

export function distributionBasis(
  data: Dataset,
  start: string,
  end: string,
): DistributionBasis {
  const inRange = (d: string) => d >= start && d <= end;
  const operating_result_cents =
    data.income
      .filter((i) => inRange(i.business_date))
      .reduce((n, i) => n + i.amount_cents, 0) -
    data.expenses
      .filter((e) => inRange(e.paid_on))
      .reduce((n, e) => n + e.amount_cents, 0);
  const events = partnerCostLedger(
    data.partner_cash || { advances: [], spends: [], repayments: [] },
  ).filter((e) => inRange(e.date));
  const funded_purchases_cents = events.reduce((n, e) => n + e.funded_cents, 0);
  const reimbursed_cost_cents = events.reduce(
    (n, e) => n + e.reimbursed_cost_cents,
    0,
  );
  const unused_return_cents = events.reduce(
    (n, e) => n + e.unused_return_cents,
    0,
  );
  const payout_basis_cents =
    operating_result_cents + funded_purchases_cents - reimbursed_cost_cents;
  return {
    version: "partner_repayment_v1",
    start,
    end,
    operating_result_cents,
    funded_purchases_cents,
    reimbursed_cost_cents,
    unused_return_cents,
    payout_basis_cents,
    distributable_cents: Math.max(0, payout_basis_cents),
    events,
  };
}

export interface PartnerCashImpact {
  fingerprint: string;
  before: DistributionBasis;
  after: DistributionBasis;
  repayment: DistributionEvent | null;
  retry?: boolean;
}

export function distributionCsvRows(
  d: DistributionBasis,
): (string | number)[][] {
  return [
    ["Owner payout basis", d.start, d.end],
    ["Recorded operating result PHP", d.operating_result_cents / 100],
    ["Add linked partner-funded purchases PHP", d.funded_purchases_cents / 100],
    ["Less cost reimbursed to partners PHP", d.reimbursed_cost_cents / 100],
    [
      "Unused advance returned (no payout deduction) PHP",
      d.unused_return_cents / 100,
    ],
    ["Income available for payouts PHP", d.payout_basis_cents / 100],
    ["Distributable PHP", d.distributable_cents / 100],
  ];
}

// PostgreSQL jsonb key order differs from browser insertion order.
export function distributionEvidenceKey(d: DistributionBasis) {
  return JSON.stringify([
    d.version,
    d.start,
    d.end,
    d.operating_result_cents,
    d.funded_purchases_cents,
    d.reimbursed_cost_cents,
    d.unused_return_cents,
    d.payout_basis_cents,
    d.distributable_cents,
    d.events.map((e) => [
      e.id,
      e.advance_id,
      e.date,
      e.kind,
      e.amount_cents,
      e.funded_cents,
      e.reimbursed_cost_cents,
      e.unused_return_cents,
      e.allocations.map((a) => [a.spend_id, a.amount_cents]),
    ]),
  ]);
}
