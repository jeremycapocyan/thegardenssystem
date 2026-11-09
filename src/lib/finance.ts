import type {
  BillTerm,
  Dataset,
  FixedBill,
  Installment,
  Owner,
  Period,
} from "./types";

export const money = (cents: number) =>
  new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 2,
  }).format(cents / 100);
export function parseMoney(input: string): number {
  const value = input.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))
    throw new Error("Enter a peso amount with up to two decimal places.");
  const [whole, fraction = ""] = value.replaceAll(",", "").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 999999999999)
    throw new Error("This amount is too large.");
  return cents;
}
const iso = (date: Date) => date.toISOString().slice(0, 10);
export function toDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Enter a valid date.");
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || iso(date) !== value)
    throw new Error("Enter a valid date.");
  return date;
}
export function todayInManila(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function addDays(day: string, days: number): string {
  const d = toDate(day);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
export function addMonths(
  day: string,
  months: number,
  originalDay?: number,
): string {
  const d = toDate(day);
  const wanted = originalDay ?? d.getUTCDate();
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1),
  );
  const last = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(wanted, last));
  return iso(start);
}
export const monthEnd = (day: string) =>
  addDays(addMonths(monthStart(day), 1), -1);
export function periodRange(
  period: Period,
  reference: string,
): { start: string; end: string } {
  toDate(reference);
  if (period === "daily") return { start: reference, end: reference };
  if (period === "monthly")
    return { start: monthStart(reference), end: monthEnd(reference) };
  const start = addDays(reference, -((toDate(reference).getUTCDay() + 6) % 7));
  return { start, end: addDays(start, 6) };
}
export const inRange = (date: string, start: string, end: string) =>
  date >= start && date <= end;
export const displayDate = (
  day: string,
  options?: Intl.DateTimeFormatOptions,
) =>
  new Intl.DateTimeFormat("en-PH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
    ...options,
  }).format(toDate(day));
export const displayMonth = (day: string) =>
  displayDate(monthStart(day), { day: undefined, month: "long" });
export function totals(data: Dataset, start: string, end: string) {
  const income = data.income
    .filter((r) => inRange(r.business_date, start, end))
    .reduce((sum, r) => sum + r.amount_cents, 0);
  const payments = data.expenses.filter((r) => inRange(r.paid_on, start, end));
  const expense = payments.reduce((sum, r) => sum + r.amount_cents, 0);
  const operating = payments
    .filter((r) => r.payment_kind === "operating")
    .reduce((sum, r) => sum + r.amount_cents, 0);
  const fixed = payments
    .filter((r) => r.payment_kind === "fixed")
    .reduce((sum, r) => sum + r.amount_cents, 0);
  const installment = payments
    .filter((r) => r.payment_kind === "installment")
    .reduce((sum, r) => sum + r.amount_cents, 0);
  return {
    income,
    expense,
    operating,
    fixed,
    installment,
    net: income - expense,
    distributable: Math.max(income - expense, 0),
  };
}
export function ownerShares(net: number): Record<Owner, number> {
  const pool = Math.max(0, net);
  const forty = Math.floor((pool * 40 + 50) / 100);
  return { Genesis: forty, Ken: forty, Jeremy: pool - forty * 2 };
}
export function trend(data: Dataset, period: Period, reference: string) {
  const current = periodRange(period, reference).start;
  const count = period === "daily" ? 30 : 12;
  return Array.from({ length: count }, (_, i) => {
    const offset = i - count + 1;
    const start =
      period === "monthly"
        ? addMonths(current, offset)
        : addDays(current, offset * (period === "weekly" ? 7 : 1));
    const end =
      period === "monthly"
        ? monthEnd(start)
        : period === "weekly"
          ? addDays(start, 6)
          : start;
    const label = displayDate(
      start,
      period === "monthly"
        ? { day: undefined, month: "short", year: "2-digit" }
        : { year: undefined },
    );
    return { start, end, label, ...totals(data, start, end) };
  });
}
export function billTerm(
  data: Dataset,
  id: string,
  month: string,
): BillTerm | undefined {
  const key = monthStart(month);
  return data.terms.find(
    (t) =>
      t.bill_id === id &&
      t.start_month <= key &&
      (!t.end_month || t.end_month >= key),
  );
}
export function dueOn(month: string, dueDay: number): string {
  return `${month.slice(0, 7)}-${String(Math.min(dueDay, toDate(monthEnd(month)).getUTCDate())).padStart(2, "0")}`;
}
export function billSummary(
  data: Dataset,
  bill: FixedBill,
  month: string,
  asOf: string,
) {
  const term = billTerm(data, bill.id, month);
  const expected = term?.amount_cents ?? 0;
  const paid = data.expenses
    .filter(
      (e) =>
        e.fixed_bill_id === bill.id &&
        e.due_month === monthStart(month) &&
        e.paid_on <= asOf,
    )
    .reduce((s, e) => s + e.amount_cents, 0);
  const due = term ? dueOn(month, term.due_day) : null;
  const unpaid = Math.max(0, expected - paid);
  const overdue = due && due < asOf ? unpaid : 0;
  const status = !term
    ? "Outside month"
    : paid > expected
      ? "Overpaid"
      : unpaid === 0
        ? "Paid"
        : overdue > 0
          ? "Overdue"
          : paid > 0
            ? "Part paid"
            : "Upcoming";
  return { term, expected, paid, due, unpaid, overdue, status };
}
export function installmentSummary(
  data: Dataset,
  agreement: Installment,
  asOf: string,
) {
  const {
    total_cents: total,
    monthly_cents: monthly,
    first_due: first,
  } = agreement;
  if (total <= 0 || monthly <= 0)
    throw new Error("Installment amounts must be positive.");
  const count = Math.ceil(total / monthly);
  const paid = data.expenses
    .filter((e) => e.installment_id === agreement.id && e.paid_on <= asOf)
    .reduce((s, e) => s + e.amount_cents, 0);
  const remaining = Math.max(0, total - paid);
  const months =
    (toDate(asOf).getUTCFullYear() - toDate(first).getUTCFullYear()) * 12 +
    toDate(asOf).getUTCMonth() -
    toDate(first).getUTCMonth();
  const scheduledThisMonth = dueOn(asOf, toDate(first).getUTCDate());
  const dueCount = Math.max(
    0,
    Math.min(count, months + (asOf >= scheduledThisMonth ? 1 : 0)),
  );
  const pastCount = Math.max(
    0,
    Math.min(count, months + (asOf > scheduledThisMonth ? 1 : 0)),
  );
  const next =
    remaining > 0
      ? addMonths(
          first,
          Math.min(count - 1, Math.floor(paid / monthly)),
          toDate(first).getUTCDate(),
        )
      : null;
  const overdue = Math.max(0, Math.min(total, pastCount * monthly) - paid);
  return {
    count,
    paid,
    remaining,
    due: Math.min(total, dueCount * monthly),
    overdue,
    next,
    finalPayment: total - monthly * (count - 1),
    lastMonth: monthStart(addMonths(first, count - 1)),
    status:
      paid > total
        ? "Overpaid"
        : remaining === 0
          ? "Completed"
          : overdue > 0
            ? "Overdue"
            : paid > 0
              ? "In progress"
              : "Not started",
  };
}
export function settlements(data: Dataset, month: string, asOf: string) {
  const result = totals(data, monthStart(month), monthEnd(month));
  const shares = ownerShares(result.net);
  return (["Genesis", "Ken", "Jeremy"] as const).map((owner) => {
    const paid = data.payouts
      .filter(
        (p) =>
          p.owner === owner &&
          p.settlement_month === monthStart(month) &&
          p.paid_on <= asOf,
      )
      .reduce((sum, p) => sum + p.amount_cents, 0);
    const balance = shares[owner] - paid;
    return {
      owner,
      share: owner === "Jeremy" ? 20 : 40,
      entitlement: shares[owner],
      paid,
      balance,
      status: balance < 0 ? "Overpaid" : balance === 0 ? "Settled" : "Unpaid",
    };
  });
}
export function csv(rows: (string | number)[][]): string {
  return (
    "\ufeff" +
    rows
      .map((row) =>
        row
          .map((value) => {
            const text =
              typeof value === "string" && /^[\s]*[=+\-@]/.test(value)
                ? `'${value}`
                : String(value);
            return `"${text.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n")
  );
}
