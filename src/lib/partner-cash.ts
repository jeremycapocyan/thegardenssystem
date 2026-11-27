import { partnerCostLedger } from "./distribution";
import { toDate } from "./finance";
import { OWNERS, type Owner, type Dataset } from "./types";
import type { CashAccount, CashMovement, CashAllocation } from "./balances";

export interface PartnerCashAdvance {
  id: string;
  owner: Owner;
  purpose: string;
  received_on: string;
  amount_cents: number;
  monthly_cents: number;
  first_due: string;
  receipt_id: string | null;
  owned_receipt: boolean;
  detail: CashMovement;
  voided_at: string | null;
  void_reason?: string;
  created_at?: string;
}
export interface PartnerCashSpend {
  id: string;
  advance_id: string;
  expense_id: string | null;
  allocation_id: string | null;
  amount_cents: number;
  owned_expense: boolean;
  owned_allocation: boolean;
  detail: { expense: Dataset["expenses"][number]; allocation: CashAllocation };
  voided_at: string | null;
  void_reason?: string;
  created_at?: string;
}
export interface PartnerCashRepayment {
  id: string;
  advance_id: string;
  paid_on: string;
  amount_cents: number;
  movement_id: string | null;
  owned_movement: boolean;
  detail: CashMovement;
  voided_at: string | null;
  void_reason?: string;
  created_at?: string;
}
export interface PartnerCashData {
  advances: PartnerCashAdvance[];
  spends: PartnerCashSpend[];
  repayments: PartnerCashRepayment[];
}
export const emptyPartnerCash = (): PartnerCashData => ({
  advances: [],
  spends: [],
  repayments: [],
});
export type PartnerCashAction =
  | "receive"
  | "purchase"
  | "repay"
  | "edit_receipt"
  | "edit_repayment"
  | "void_receipt"
  | "void_purchase"
  | "void_repayment";
export type PartnerCashAccount = Extract<CashAccount, "cash" | "bank">;
export function partnerCashDue(first: string, index: number) {
  const d = toDate(first),
    day = d.getUTCDate();
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + index + 1, 0),
  );
  return new Date(
    Date.UTC(
      last.getUTCFullYear(),
      last.getUTCMonth(),
      Math.min(day, last.getUTCDate()),
    ),
  )
    .toISOString()
    .slice(0, 10);
}
export function partnerCashSummary(
  data: PartnerCashData,
  a: PartnerCashAdvance,
  asOf: string,
) {
  toDate(asOf);
  const active = !a.voided_at && a.received_on <= asOf;
  const repaid = active
    ? data.repayments
        .filter(
          (r) => r.advance_id === a.id && !r.voided_at && r.paid_on <= asOf,
        )
        .reduce((n, r) => n + r.amount_cents, 0)
    : 0;
  const spent = active
    ? data.spends
        .filter(
          (s) =>
            s.advance_id === a.id &&
            !s.voided_at &&
            s.detail.expense.paid_on <= asOf,
        )
        .reduce((n, s) => n + s.amount_cents, 0)
    : 0;
  const remaining = active ? Math.max(0, a.amount_cents - repaid) : 0;
  const next = remaining
    ? partnerCashDue(a.first_due, Math.floor(repaid / a.monthly_cents))
    : null;
  const first = toDate(a.first_due),
    end = toDate(asOf);
  let periods =
    (end.getUTCFullYear() - first.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    first.getUTCMonth();
  if (periods >= 0 && partnerCashDue(a.first_due, periods) >= asOf) periods--;
  const overdue = active
    ? Math.max(
        0,
        Math.min(a.amount_cents, Math.max(0, periods + 1) * a.monthly_cents) -
          repaid,
      )
    : 0;
  return {
    active,
    repaid,
    spent,
    remaining,
    next,
    overdue,
    unlinked: active ? a.amount_cents - spent : 0,
  };
}

export function partnerBorrowingSummary(data: PartnerCashData, asOf: string) {
  toDate(asOf);
  const rows = OWNERS.flatMap((owner) => {
    const advances = data.advances.filter(
      (a) => a.owner === owner && !a.voided_at && a.received_on <= asOf,
    );
    if (!advances.length) return [];
    const received = advances.reduce((n, a) => n + a.amount_cents, 0);
    const summaries = advances.map((a) => partnerCashSummary(data, a, asOf));
    return [
      {
        owner,
        received,
        repaid: summaries.reduce((n, a) => n + a.repaid, 0),
        remaining: summaries.reduce((n, a) => n + a.remaining, 0),
      },
    ];
  });
  return {
    rows,
    received: rows.reduce((n, r) => n + r.received, 0),
    repaid: rows.reduce((n, r) => n + r.repaid, 0),
    remaining: rows.reduce((n, r) => n + r.remaining, 0),
  };
}
export function partnerBorrowingCsvRows(
  summary: ReturnType<typeof partnerBorrowingSummary>,
  asOf: string,
): (string | number)[][] {
  return [
    ["Partner borrowing · as of", asOf],
    ["Partner", "Cash received PHP", "Repaid PHP", "Still owed PHP"],
    ...summary.rows.map((r) => [
      r.owner,
      r.received / 100,
      r.repaid / 100,
      r.remaining / 100,
    ]),
    [
      "Total",
      summary.received / 100,
      summary.repaid / 100,
      summary.remaining / 100,
    ],
    [
      "Advance receipts and repayments are already included in account balances. Debt is shown separately; no additional cash posting.",
    ],
  ];
}

export function partnerCashCsvRows(
  p: PartnerCashData,
  asOf: string,
): (string | number)[][] {
  const rows: (string | number)[][] = [
    ["Partner cash advances · as of", asOf],
    [
      "Partner",
      "Purpose",
      "Received",
      "Principal",
      "Linked purchases",
      "Repaid",
      "Outstanding",
      "Next due",
      "Overdue",
      "Status",
      "Receipt account",
      "Receipt reference",
      "First due",
      "Monthly repayment",
      "Correction reason",
    ],
  ];
  for (const a of p.advances) {
    const s = partnerCashSummary(p, a, asOf);
    if (a.received_on > asOf) continue;
    rows.push([
      a.owner,
      a.purpose,
      a.received_on,
      a.amount_cents / 100,
      s.spent / 100,
      s.repaid / 100,
      s.remaining / 100,
      s.next || "",
      s.overdue / 100,
      a.voided_at ? "Voided" : s.remaining ? "Outstanding" : "Repaid",
      a.detail.to_account || "",
      a.detail.reference,
      a.first_due,
      a.monthly_cents / 100,
      a.void_reason || "",
    ]);
  }
  rows.push(
    [],
    [
      "Purchase links",
      "Partner",
      "Date",
      "Expense ID",
      "Funded portion",
      "Full expense",
      "Account",
      "Reference",
      "Status",
      "Correction reason",
    ],
  );
  for (const s of p.spends) {
    if (s.detail.expense.paid_on > asOf) continue;
    rows.push([
      s.id,
      p.advances.find((a) => a.id === s.advance_id)?.owner || "",
      s.detail.expense.paid_on,
      s.detail.expense.id,
      s.amount_cents / 100,
      s.detail.expense.amount_cents / 100,
      s.detail.allocation.account,
      s.detail.expense.reference,
      s.voided_at ? "Voided" : "Active",
      s.void_reason || "",
    ]);
  }
  rows.push(
    [],
    [
      "Repayments",
      "Partner",
      "Date",
      "Amount",
      "Reimbursed cost PHP",
      "Unused advance returned PHP",
      "Account",
      "Reference",
      "Status",
      "Correction reason",
    ],
  );
  const ledger = partnerCostLedger(p);
  for (const r of p.repayments) {
    if (r.paid_on > asOf) continue;
    rows.push([
      r.id,
      p.advances.find((a) => a.id === r.advance_id)?.owner || "",
      r.paid_on,
      r.amount_cents / 100,
      (ledger.find((e) => e.id === r.id)?.reimbursed_cost_cents || 0) / 100,
      (ledger.find((e) => e.id === r.id)?.unused_return_cents || 0) / 100,
      r.detail.from_account || "",
      r.detail.reference,
      r.voided_at ? "Voided" : "Active",
      r.void_reason || "",
    ]);
  }
  return rows;
}
