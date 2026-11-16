import type { Dataset, Period } from "./types";
import type { RoiData } from "./roi";
import { cashSummary, type CashData } from "./balances";
import { roiSummary } from "./roi";
import {
  addDays,
  addMonths,
  billSummary,
  inRange,
  installmentSummary,
  monthStart,
  monthEnd,
  ownerShares,
  settlements,
  toDate,
  totals,
} from "./finance";

export interface FinanceReportOptions {
  start: string;
  end: string;
  asOf: string;
  period: Period | "custom";
}
export interface FinanceReportSource {
  balances?: Omit<CashData, "finance">;
  finance: Dataset;
  roi: RoiData;
  generated_at: string;
  prepared_by: string;
}
export function validateFinanceReportRange(o: FinanceReportOptions) {
  const days =
    (toDate(o.end).valueOf() - toDate(o.start).valueOf()) / 86400000 + 1;
  toDate(o.asOf);
  if (days < 1 || days > 366)
    throw Error("Choose a reporting range of 1 to 366 days.");
  if (!["daily", "weekly", "monthly", "custom"].includes(o.period))
    throw Error("Choose a report period.");
  return days;
}
export function buildFinanceReport(
  source: FinanceReportSource,
  options: FinanceReportOptions,
  sample = false,
) {
  const length = validateFinanceReportRange(options);
  if (!Number.isFinite(new Date(source.generated_at).valueOf()))
    throw Error("Report generation time is unavailable.");
  const { finance: data, roi } = source,
    { start, end, asOf } = options;
  const category = (id: string) =>
    data.categories.find((c) => c.id === id)?.name || "Unknown category";
  const sorted = <T extends { id: string }>(
    rows: T[],
    date: (r: T) => string,
  ) =>
    rows
      .slice()
      .sort(
        (a, b) => date(a).localeCompare(date(b)) || a.id.localeCompare(b.id),
      );
  const income = sorted(
    data.income.filter((r) => inRange(r.business_date, start, end)),
    (r) => r.business_date,
  );
  const expenses = sorted(
    data.expenses.filter((r) => inRange(r.paid_on, start, end)),
    (r) => r.paid_on,
  );
  const payouts = sorted(
    data.payouts.filter((r) => inRange(r.paid_on, start, end)),
    (r) => r.paid_on,
  );
  const cash = totals(data, start, end);
  const paidToOwners = payouts.reduce((n, r) => n + r.amount_cents, 0);
  const categoryTotals = (
    rows: { category_id: string; amount_cents: number }[],
  ) => {
    const groups = new Map<
      string,
      { name: string; amount: number; count: number }
    >();
    for (const r of rows) {
      const g = groups.get(r.category_id) || {
        name: category(r.category_id),
        amount: 0,
        count: 0,
      };
      g.amount += r.amount_cents;
      g.count++;
      groups.set(r.category_id, g);
    }
    return [...groups.values()].sort(
      (a, b) => b.amount - a.amount || a.name.localeCompare(b.name),
    );
  };
  const months: string[] = [];
  for (let m = monthStart(start); m <= monthStart(end); m = addMonths(m, 1))
    months.push(m);
  const bills = months.flatMap((month) =>
    data.bills
      .map((bill) => ({ bill, month, ...billSummary(data, bill, month, asOf) }))
      .filter((b) => b.term),
  );
  const installments = data.installments.map((agreement) => {
    const summary = installmentSummary(data, agreement, asOf);
    let scheduled = 0;
    for (const month of months) {
      const offset =
        (toDate(month).getUTCFullYear() -
          toDate(agreement.first_due).getUTCFullYear()) *
          12 +
        toDate(month).getUTCMonth() -
        toDate(agreement.first_due).getUTCMonth();
      if (offset < 0 || offset >= summary.count) continue;
      const due = addMonths(
        agreement.first_due,
        offset,
        toDate(agreement.first_due).getUTCDate(),
      );
      if (inRange(due, start, end))
        scheduled += Math.min(
          agreement.monthly_cents,
          agreement.total_cents - offset * agreement.monthly_cents,
        );
    }
    return {
      agreement,
      ...summary,
      scheduled,
      periodPaid: expenses
        .filter((e) => e.installment_id === agreement.id)
        .reduce((n, e) => n + e.amount_cents, 0),
    };
  });
  const ownerMonths = months.map((month) => ({
    month,
    ...totals(data, month, monthEnd(month)),
    owners: settlements(data, month, asOf),
  }));
  const daily = Array.from({ length }, (_, i) => {
    const date = addDays(start, i),
      total = totals(data, date, date),
      ownerPaid = payouts
        .filter((p) => p.paid_on === date)
        .reduce((n, p) => n + p.amount_cents, 0);
    return { date, ...total, ownerPaid, retained: total.net - ownerPaid };
  });
  const warnings: string[] = [];
  const unknown = new Set(
    [...income, ...expenses]
      .filter((r) => !data.categories.some((c) => c.id === r.category_id))
      .map((r) => r.category_id),
  );
  if (unknown.size)
    warnings.push(
      `${unknown.size} missing category reference(s). Related transactions are included as Unknown category.`,
    );
  for (const e of expenses) {
    if (
      e.payment_kind === "fixed" &&
      (!e.due_month || !data.bills.some((b) => b.id === e.fixed_bill_id))
    )
      warnings.push(
        `Expense ${e.id}: fixed-bill link or due month is missing.`,
      );
    if (
      e.payment_kind === "installment" &&
      (!e.due_month ||
        !data.installments.some((a) => a.id === e.installment_id))
    )
      warnings.push(
        `Expense ${e.id}: installment link or due month is missing.`,
      );
  }
  const duplicateKeys = new Map<string, number>();
  for (const e of expenses) {
    const k = JSON.stringify([
      e.paid_on,
      e.category_id,
      e.payment_kind,
      e.amount_cents,
      e.reference,
      e.fixed_bill_id,
      e.installment_id,
      e.due_month,
    ]);
    duplicateKeys.set(k, (duplicateKeys.get(k) || 0) + 1);
  }
  const duplicates = [...duplicateKeys.values()]
    .filter((n) => n > 1)
    .reduce((n, c) => n + c, 0);
  if (duplicates)
    warnings.push(
      `${duplicates} expense rows have matching payment details. Review possible duplicates; every recorded row remains included in totals.`,
    );
  const missingReferences =
    expenses.filter((e) => !e.reference.trim()).length +
    payouts.filter((p) => !p.reference.trim()).length;
  if (missingReferences)
    warnings.push(
      `${missingReferences} expense or owner payout rows have no payment reference.`,
    );
  const roiTotal = roiSummary(data, roi, asOf);
  const capital = sorted(
    roi.capital.filter((c) => c.invested_on <= asOf),
    (c) => c.invested_on,
  );
  const capitalCosts = roi.exclusions.flatMap((x) => {
    const expense = data.expenses.find((e) => e.id === x.expense_id);
    return expense &&
      roiTotal.start &&
      inRange(expense.paid_on, roiTotal.start, asOf)
      ? [{ ...x, expense }]
      : [];
  });
  return structuredClone({
    balances: source.balances
      ? cashSummary({ ...source.balances, finance: data }, asOf)
      : null,
    balanceData: source.balances || null,
    options,
    sample,
    generatedAt: source.generated_at,
    preparedBy: source.prepared_by,
    cash,
    paidToOwners,
    retained: cash.net - paidToOwners,
    shares: ownerShares(cash.net),
    income,
    expenses,
    payouts,
    incomeCategories: categoryTotals(income),
    expenseCategories: categoryTotals(expenses),
    bills,
    installments,
    ownerMonths,
    daily,
    roi: roiTotal,
    capital,
    capitalCosts,
    warnings,
    categories: data.categories,
    billRegister: data.bills,
    installmentRegister: data.installments,
  });
}
export type FinanceReport = ReturnType<typeof buildFinanceReport>;
export const financeReportFileName = (r: FinanceReport) =>
  `The-Gardens-Finance-${r.options.start}-to-${r.options.end}.pdf`;
