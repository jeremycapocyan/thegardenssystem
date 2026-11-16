import test from "node:test";
import assert from "node:assert/strict";
import { demoData } from "./demo";
import { demoRoi } from "./roi";
import { buildFinanceReport } from "./finance-report";
import {
  cashSummary,
  cashEntries,
  demoCash,
  validateCashAllocation,
  signedMoney,
} from "./balances";
test("account balances reconcile opening funds, split receipts, fees, payouts, transfers and as-of dates", () => {
  const data = demoCash(demoData());
  data.settings = {
    start_date: "2026-11-01",
    cash: 100000,
    bank: 200000,
    booking: 300000,
  };
  const income = data.finance.income.find(
      (i) => i.business_date === "2026-11-01",
    )!,
    expense = data.finance.expenses.find((e) => e.paid_on === "2026-11-01")!;
  const alloc = (
    id: string,
    account: "cash" | "bank" | "booking",
    amount: number,
  ) => ({
    id,
    account,
    income_id: income.id,
    expense_id: null,
    payout_id: null,
    amount_cents: amount,
  });
  data.allocations = [
    alloc("a", "cash", 10000),
    alloc("b", "booking", income.amount_cents - 10000),
    {
      id: "c",
      account: "booking",
      income_id: null,
      expense_id: expense.id,
      payout_id: null,
      amount_cents: expense.amount_cents,
    },
  ];
  const before = JSON.stringify(data.finance);
  const s = cashSummary(data, "2026-11-01");
  assert.equal(s.total, 600000 + income.amount_cents - expense.amount_cents);
  assert.equal(s.balances.cash, 110000);
  data.movements.push({
    id: "m",
    moved_on: "2026-11-02",
    kind: "transfer",
    from_account: "booking",
    to_account: "bank",
    amount_cents: 50000,
    reference: "Withdrawal",
    reason: "Actual booking withdrawal",
  });
  const next = cashSummary(data, "2026-11-02");
  assert.equal(next.total, s.total);
  assert.equal(next.balances.bank, 250000);
  assert.equal(next.balances.booking, s.balances.booking - 50000);
  assert.equal(cashSummary(data, "2026-10-31").available, false);
  assert.equal(JSON.stringify(data.finance), before);
  assert.equal(
    cashEntries(data).find((e) => e.id === income.id)!.unassigned,
    0,
  );
  assert.throws(
    () => validateCashAllocation(data, alloc("d", "bank", 1)),
    /cannot exceed/,
  );
  data.movements.push({
    id: "n",
    moved_on: "2026-11-03",
    kind: "adjustment",
    from_account: "cash",
    to_account: null,
    amount_cents: 120000,
    reference: "Count",
    reason: "Cash correction",
  });
  assert.equal(cashSummary(data, "2026-11-03").balances.cash, -10000);
  assert.equal(signedMoney("-205,457.96"), -20545796);
});
test("booking receipts become available on their funds date, and finance reports freeze balances", () => {
  const data = demoCash(demoData());
  data.settings = { start_date: "2026-11-01", cash: 0, bank: 0, booking: 0 };
  const income = data.finance.income.find(
    (i) => i.business_date === "2026-11-01",
  )!;
  data.allocations = [
    {
      id: "later",
      account: "booking",
      income_id: income.id,
      expense_id: null,
      payout_id: null,
      amount_cents: income.amount_cents,
      posted_on: "2026-11-05",
    },
  ];
  assert.equal(cashSummary(data, "2026-11-04").balances.booking, 0);
  assert.equal(
    cashSummary(data, "2026-11-05").balances.booking,
    income.amount_cents,
  );
  const { finance, ...balances } = data;
  const report = buildFinanceReport(
    {
      finance,
      roi: demoRoi(),
      balances,
      prepared_by: "Fictional admin",
      generated_at: "2026-11-06T00:00:00Z",
    },
    {
      start: "2026-11-01",
      end: "2026-11-05",
      asOf: "2026-11-05",
      period: "custom",
    },
  );
  assert.equal(report.balances!.balances.booking, income.amount_cents);
  data.allocations[0].amount_cents = 1;
  assert.equal(
    report.balanceData!.allocations[0].amount_cents,
    income.amount_cents,
  );
});
