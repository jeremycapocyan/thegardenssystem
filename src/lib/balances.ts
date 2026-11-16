import type { Dataset } from "./types";
import { parseMoney, toDate } from "./finance";
export const ACCOUNTS = {
  cash: "Cash on hand",
  bank: "Bank",
  booking: "Booking system · withdrawable",
} as const;
export type CashAccount = keyof typeof ACCOUNTS;
export type CashKind = "income" | "expenses" | "payouts";
export interface CashSettings {
  start_date: string;
  cash: number;
  bank: number;
  booking: number;
}
export interface CashAllocation {
  posted_on?: string;
  id: string;
  account: CashAccount;
  income_id: string | null;
  expense_id: string | null;
  payout_id: string | null;
  amount_cents: number;
}
export interface CashMovement {
  id: string;
  moved_on: string;
  kind: "transfer" | "funding" | "adjustment";
  from_account: CashAccount | null;
  to_account: CashAccount | null;
  amount_cents: number;
  reference: string;
  reason: string;
}
export interface CashData {
  settings: CashSettings | null;
  allocations: CashAllocation[];
  movements: CashMovement[];
  finance: Dataset;
}
export function signedMoney(input: string) {
  return input.trim().startsWith("-")
    ? -parseMoney(input.trim().slice(1))
    : parseMoney(input);
}
export function cashEntries(data: CashData, asOf?: string) {
  return (["income", "expenses", "payouts"] as const)
    .flatMap((kind) =>
      data.finance[kind].map((row) => {
        const date = "business_date" in row ? row.business_date : row.paid_on;
        const label =
          "owner" in row
            ? `${row.owner} · Owner payout`
            : data.finance.categories.find((c) => c.id === row.category_id)
                ?.name || "Unknown category";
        const allocations = data.allocations.filter(
          (a) =>
            allocationRecord(a) === row.id &&
            allocationKind(a) === kind &&
            (!asOf || (a.posted_on || date) <= asOf),
        );
        const assigned = allocations.reduce((n, a) => n + a.amount_cents, 0);
        return {
          id: row.id,
          kind,
          date,
          label,
          notes: row.notes,
          reference: "reference" in row ? row.reference : "",
          amount: row.amount_cents,
          assigned,
          unassigned: row.amount_cents - assigned,
          allocations,
        };
      }),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
export const allocationRecord = (a: CashAllocation) =>
  a.income_id || a.expense_id || a.payout_id;
export const allocationKind = (a: CashAllocation): CashKind =>
  a.income_id ? "income" : a.expense_id ? "expenses" : "payouts";
export function cashSummary(data: CashData, asOf: string) {
  toDate(asOf);
  const balances = { cash: 0, bank: 0, booking: 0 };
  const opening = data.settings;
  if (!opening || asOf < opening.start_date)
    return {
      balances,
      total: 0,
      available: false,
      entries: [],
      unassignedIn: 0,
      unassignedOut: 0,
    };
  Object.assign(balances, {
    cash: opening.cash,
    bank: opening.bank,
    booking: opening.booking,
  });
  const entries = cashEntries(data, asOf).filter(
    (e) => e.date >= opening.start_date && e.date <= asOf,
  );
  for (const e of entries)
    for (const a of e.allocations)
      balances[a.account] += a.amount_cents * (e.kind === "income" ? 1 : -1);
  for (const m of data.movements.filter(
    (m) => m.moved_on >= opening.start_date && m.moved_on <= asOf,
  )) {
    if (m.from_account) balances[m.from_account] -= m.amount_cents;
    if (m.to_account) balances[m.to_account] += m.amount_cents;
  }
  return {
    balances,
    total: balances.cash + balances.bank + balances.booking,
    available: true,
    entries,
    unassignedIn: entries
      .filter((e) => e.kind === "income")
      .reduce((n, e) => n + e.unassigned, 0),
    unassignedOut: entries
      .filter((e) => e.kind !== "income")
      .reduce((n, e) => n + e.unassigned, 0),
  };
}
export function validateCashAllocation(data: CashData, a: CashAllocation) {
  if (!data.settings) throw Error("Set opening balances first.");
  if (
    !(a.account in ACCOUNTS) ||
    !Number.isSafeInteger(a.amount_cents) ||
    a.amount_cents <= 0
  )
    throw Error("Choose an account and a positive amount.");
  const e = cashEntries(data).find(
    (e) => e.id === allocationRecord(a) && e.kind === allocationKind(a),
  );
  if (!e || e.date < data.settings.start_date)
    throw Error("Choose an entry on or after the opening date.");
  if (a.posted_on) {
    toDate(a.posted_on);
    if (a.posted_on < e.date)
      throw Error("Funds date cannot precede the finance entry.");
  }
  const old = data.allocations.find((x) => x.id === a.id);
  if (
    old &&
    (allocationRecord(old) !== allocationRecord(a) ||
      allocationKind(old) !== allocationKind(a))
  )
    throw Error("This assignment belongs to another entry.");
  if (e.assigned - (old?.amount_cents || 0) + a.amount_cents > e.amount)
    throw Error("Account assignments cannot exceed the finance entry amount.");
}
export function demoCash(finance: Dataset): CashData {
  return { settings: null, allocations: [], movements: [], finance };
}
