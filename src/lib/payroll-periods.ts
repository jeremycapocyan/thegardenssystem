import { addDays, addMonths, monthEnd, monthStart, toDate } from "./finance";
export interface CutoffRule {
  id?: string;
  effective_from: string;
  first_day: number;
  second_day: number;
  reason?: string;
}
export const LEGACY_CUTOFFS: CutoffRule[] = [
  { effective_from: "2000-01-01", first_day: 15, second_day: 31 },
];
export function payrollBounds(
  date: string,
  rules: CutoffRule[] = LEGACY_CUTOFFS,
) {
  toDate(date);
  const versions = rules.length ? rules : LEGACY_CUTOFFS;
  const rule = versions
    .filter((r) => r.effective_from <= date)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0];
  if (
    !rule ||
    rule.first_day < 1 ||
    rule.first_day > 27 ||
    rule.second_day <= rule.first_day ||
    rule.second_day > 31
  )
    throw Error(
      "Payroll cutoff schedule is unavailable. Refresh employee records.",
    );
  const ends: string[] = [];
  for (const offset of [-1, 0, 1]) {
    const month = addMonths(monthStart(date), offset),
      last = Number(monthEnd(month).slice(8));
    for (const n of [rule.first_day, rule.second_day])
      ends.push(
        `${month.slice(0, 7)}-${String(Math.min(n, last)).padStart(2, "0")}`,
      );
  }
  const previous = ends
      .filter((d) => d < date)
      .sort()
      .at(-1)!,
    next = ends.filter((d) => d >= date).sort()[0];
  const change = versions
    .filter((r) => r.effective_from > date)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
  const start =
    addDays(previous, 1) > rule.effective_from
      ? addDays(previous, 1)
      : rule.effective_from;
  const end =
    change && change.effective_from <= next
      ? addDays(change.effective_from, -1)
      : next;
  return { start, end, rule };
}
