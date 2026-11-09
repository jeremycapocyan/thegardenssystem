import { addMonths, monthStart, monthEnd, totals } from "./finance";
import { OWNERS, type Dataset, type Owner } from "./types";
export interface Capital {
  id: string;
  invested_on: string;
  owner: Owner;
  amount_cents: number;
  reference: string;
  notes: string;
}
export interface CapitalExclusion {
  id: string;
  expense_id: string;
  reason: string;
}
export interface RoiData {
  capital: Capital[];
  exclusions: CapitalExclusion[];
}
export function roiSummary(finance: Dataset, roi: RoiData, asOf: string) {
  const capital = roi.capital.filter((c) => c.invested_on <= asOf);
  const start = capital.map((c) => c.invested_on).sort()[0] || null;
  const invested = capital.reduce((n, c) => n + c.amount_cents, 0);
  const cash = start
    ? totals(finance, start, asOf)
    : { income: 0, expense: 0, net: 0 };
  const marks = new Set(roi.exclusions.map((e) => e.expense_id));
  const capitalCosts = start
    ? finance.expenses
        .filter(
          (e) => marks.has(e.id) && e.paid_on >= start && e.paid_on <= asOf,
        )
        .reduce((n, e) => n + e.amount_cents, 0)
    : 0;
  const returned = cash.net + capitalCosts;
  const owners = OWNERS.map((owner) => {
    const contribution = capital
      .filter((c) => c.owner === owner)
      .reduce((n, c) => n + c.amount_cents, 0);
    const paid = start
      ? finance.payouts
          .filter(
            (p) => p.owner === owner && p.paid_on >= start && p.paid_on <= asOf,
          )
          .reduce((n, p) => n + p.amount_cents, 0)
      : 0;
    return {
      owner,
      contribution,
      paid,
      remaining: Math.max(0, contribution - paid),
      percent: contribution > 0 ? (paid / contribution) * 100 : null,
    };
  });
  return {
    start,
    invested,
    income: cash.income,
    expense: cash.expense,
    net: cash.net,
    capitalCosts,
    returned,
    percent: invested > 0 ? (returned / invested) * 100 : null,
    remaining: Math.max(0, invested - returned),
    surplus: Math.max(0, returned - invested),
    owners,
  };
}
export function roiTrend(finance: Dataset, roi: RoiData, asOf: string) {
  const start = roiSummary(finance, roi, asOf).start;
  if (!start) return [];
  const endMonth = monthStart(asOf),
    first = monthStart(start),
    earliest = addMonths(endMonth, -11);
  const begin = first > earliest ? first : earliest;
  const points = [];
  for (let month = begin; month <= endMonth; month = addMonths(month, 1)) {
    const date = monthEnd(month) < asOf ? monthEnd(month) : asOf;
    const total = roiSummary(finance, roi, date);
    points.push({
      month,
      date,
      invested: total.invested,
      returned: total.returned,
    });
  }
  return points;
}
export const emptyRoi = (): RoiData => ({ capital: [], exclusions: [] });
export const demoRoi = (): RoiData => ({
  capital: OWNERS.map((owner, i) => ({
    id: `demo-capital-${i}`,
    invested_on: "2026-11-01",
    owner,
    amount_cents: i === 2 ? 2000000 : 4000000,
    reference: `SAMPLE-CAP-${i + 1}`,
    notes: "Fictional initial capital",
  })),
  exclusions: [],
});
