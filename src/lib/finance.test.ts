import test from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  billSummary,
  billTerm,
  csv,
  dueOn,
  installmentSummary,
  money,
  ownerShares,
  parseMoney,
  periodRange,
  settlements,
  toDate,
  totals,
  trend,
} from "./finance";
import { demoData } from "./demo";

test("peso inputs preserve exact centavos and reject excessive precision", () => {
  assert.equal(parseMoney("25,000.50"), 2500050);
  assert.equal(parseMoney("0.01"), 1);
  assert.equal(parseMoney("100.1"), 10010);
  for (const invalid of ["-1", "1.005", "1,2", "NaN", "", "10000000000"])
    assert.throws(() => parseMoney(invalid));
});
test("peso displays use PHP, not dollars", () => {
  assert.match(money(2500050), /₱25,000\.50/);
});
test("weekly ranges start Monday and handle a year boundary", () => {
  assert.deepEqual(periodRange("weekly", "2026-01-01"), {
    start: "2025-12-29",
    end: "2026-01-04",
  });
});
test("monthly ranges include leap days and final days", () => {
  assert.deepEqual(periodRange("monthly", "2028-02-14"), {
    start: "2028-02-01",
    end: "2028-02-29",
  });
  assert.throws(() => toDate("2026-02-30"));
});
test("month additions preserve the original due day across February", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-01-31", 2), "2026-03-31");
  assert.equal(dueOn("2028-02-01", 31), "2028-02-29");
});
test("sample month reconciles the three expense types exactly once", () => {
  const result = totals(demoData(), "2026-11-01", "2026-11-30");
  assert.deepEqual(result, {
    income: 8990000,
    expense: 5100000,
    operating: 1710000,
    fixed: 2850000,
    installment: 540000,
    net: 3890000,
    distributable: 3890000,
  });
});
test("owner payouts never reduce business net income", () => {
  const data = demoData();
  const before = totals(data, "2026-11-01", "2026-11-30");
  data.payouts.push({
    ...data.payouts[0],
    id: "more",
    paid_on: "2026-11-20",
    amount_cents: 10000000,
  });
  assert.deepEqual(totals(data, "2026-11-01", "2026-11-30"), before);
});
test("daily and weekly samples use the correct date boundaries", () => {
  const data = demoData();
  assert.equal(totals(data, "2026-11-08", "2026-11-08").net, 1170000);
  const week = periodRange("weekly", "2026-11-08");
  assert.equal(totals(data, week.start, week.end).net, 2000000);
  assert.equal(totals(data, "2026-11-30", "2026-11-30").net, -830000);
});
test("owner shares reconcile to the centavo, including small amounts", () => {
  assert.deepEqual(ownerShares(1000000), {
    Genesis: 400000,
    Ken: 400000,
    Jeremy: 200000,
  });
  for (let cents = 0; cents < 1000; cents++) {
    const result = ownerShares(cents);
    assert.equal(result.Genesis + result.Ken + result.Jeremy, cents);
    assert.ok(result.Jeremy >= 0);
  }
});
test("losses produce zero shares without carrying into other months", () => {
  assert.deepEqual(ownerShares(-800), { Genesis: 0, Ken: 0, Jeremy: 0 });
  assert.equal(
    ownerShares(totals(demoData(), "2026-11-01", "2026-11-30").net).Genesis,
    1556000,
  );
});
test("tracker balances use due month and actual payment as-of date separately", () => {
  const data = demoData();
  const rent = data.bills[0];
  assert.equal(billSummary(data, rent, "2026-11-01", "2026-11-29").paid, 0);
  assert.equal(
    billSummary(data, rent, "2026-11-01", "2026-12-01").paid,
    2500000,
  );
  assert.equal(
    billSummary(data, data.bills[2], "2026-11-01", "2026-12-01").overdue,
    150000,
  );
});
test("bill version lookup preserves earlier monthly amounts", () => {
  const data = demoData();
  data.terms[0].end_month = "2026-11-01";
  data.terms.push({
    ...data.terms[0],
    id: "new",
    start_month: "2026-12-01",
    end_month: null,
    amount_cents: 2600000,
  });
  assert.equal(
    billTerm(data, "bill-rent", "2026-11-30")?.amount_cents,
    2500000,
  );
  assert.equal(
    billTerm(data, "bill-rent", "2026-12-15")?.amount_cents,
    2600000,
  );
});
test("installments combine partial payments and adjust the last payment", () => {
  const data = demoData();
  const agreement = data.installments[0];
  const partial = installmentSummary(data, agreement, "2026-11-16");
  assert.equal(partial.paid, 100000);
  assert.equal(partial.overdue, 200000);
  assert.equal(partial.next, "2026-11-15");
  const current = installmentSummary(data, agreement, "2026-12-01");
  assert.equal(current.paid, 300000);
  assert.equal(current.remaining, 700000);
  assert.equal(current.count, 4);
  assert.equal(current.finalPayment, 100000);
  assert.equal(current.next, "2026-12-15");
});
test("installments due today are due, but become overdue tomorrow", () => {
  const data = demoData();
  const a = data.installments[1];
  assert.equal(
    installmentSummary({ ...data, expenses: [] }, a, "2026-11-10").overdue,
    0,
  );
  assert.equal(
    installmentSummary({ ...data, expenses: [] }, a, "2026-11-11").overdue,
    150000,
  );
});
test("completed installments have no next unpaid due date", () => {
  const data = demoData();
  const result = installmentSummary(data, data.installments[2], "2026-12-01");
  assert.equal(result.remaining, 0);
  assert.equal(result.status, "Completed");
  assert.equal(result.next, null);
});
test("late owner payouts settle the assigned earlier month", () => {
  const rows = settlements(demoData(), "2026-11-01", "2026-12-01");
  assert.equal(rows[0].balance, 556000);
  assert.equal(rows[1].balance, 0);
  assert.equal(rows[2].balance, 378000);
  assert.equal(settlements(demoData(), "2026-11-01", "2026-11-30")[0].paid, 0);
});
test("overpayments remain visible instead of being hidden as zero balances", () => {
  const data = demoData();
  data.payouts.push({ ...data.payouts[0], id: "extra", amount_cents: 600000 });
  const genesis = settlements(data, "2026-11-01", "2026-12-01")[0];
  assert.equal(genesis.balance, -44000);
  assert.equal(genesis.status, "Overpaid");
});
test("trend lengths and endpoints follow the selected granularity", () => {
  const data = demoData();
  for (const period of ["daily", "weekly", "monthly"] as const) {
    const points = trend(data, period, "2026-11-30");
    assert.equal(points.length, period === "daily" ? 30 : 12);
    assert.equal(points.at(-1)?.start, periodRange(period, "2026-11-30").start);
  }
});
test("CSV exports escape formulas, quotes, and embedded newlines", () => {
  const output = csv([
    ["Notes", "Amount"],
    ['=HYPERLINK("bad")', 5],
    ["line1\nline2", 10],
  ]);
  assert.match(output, /'=HYPERLINK\(""bad""\)/);
  assert.ok(output.includes('"line1\nline2"'));
});
