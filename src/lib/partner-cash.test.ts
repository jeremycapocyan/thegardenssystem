import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_DATA, type Dataset } from "./types";
import { demoCash, cashSummary } from "./balances";
import {
  emptyPartnerCash,
  partnerCashDue,
  partnerCashSummary,
  partnerCashCsvRows,
} from "./partner-cash";
import {
  applyPartnerCashDemo,
  guardPartnerCashManual,
} from "./partner-cash-demo";
import { buildFinanceReport } from "./finance-report";
const base = (): Dataset => ({
  ...structuredClone(EMPTY_DATA),
  categories: [
    { id: "expense", kind: "expense", name: "Equipment", active: true },
  ],
});
function fixture() {
  let data = base(),
    cash = {
      ...demoCash(data),
      settings: { start_date: "2020-01-01", cash: 0, bank: 0, booking: 0 },
    };
  const cmd = (
    action: Parameters<typeof applyPartnerCashDemo>[2],
    p: Record<string, unknown>,
    id = crypto.randomUUID(),
  ) => {
    const n = applyPartnerCashDemo(data, cash, action, id, p, "2021-01-31");
    data = n.data;
    cash = n.balances as typeof cash;
    return id;
  };
  const a = cmd("receive", {
    owner: "Genesis",
    purpose: "Fictional cash advance",
    received_on: "2020-01-01",
    amount_cents: 2500000,
    monthly_cents: 1000000,
    first_due: "2020-01-31",
    account: "cash",
  });
  return {
    cmd,
    a,
    get data() {
      return data;
    },
    get cash() {
      return cash;
    },
  };
}
test("cash advance due dates clamp to month end and retain original due day", () => {
  assert.equal(partnerCashDue("2020-01-31", 1), "2020-02-29");
  assert.equal(partnerCashDue("2020-01-31", 2), "2020-03-31");
  assert.equal(partnerCashDue("2021-01-31", 1), "2021-02-28");
});
test("cash debt summaries allocate early/partial repayments oldest-first and adjust final payment", () => {
  const f = fixture(),
    a = f.data.partner_cash!.advances[0];
  assert.equal(
    partnerCashSummary(f.data.partner_cash!, a, "2020-01-31").overdue,
    0,
  );
  assert.equal(
    partnerCashSummary(f.data.partner_cash!, a, "2020-02-01").overdue,
    1000000,
  );
  f.cmd("repay", {
    advance_id: a.id,
    paid_on: "2020-02-01",
    amount_cents: 1500000,
    account: "cash",
  });
  let s = partnerCashSummary(f.data.partner_cash!, a, "2020-03-01");
  assert.equal(s.remaining, 1000000);
  assert.equal(s.overdue, 500000);
  assert.equal(s.next, "2020-02-29");
  f.cmd("repay", {
    advance_id: a.id,
    paid_on: "2020-03-02",
    amount_cents: 500000,
    account: "cash",
  });
  s = partnerCashSummary(f.data.partner_cash!, a, "2020-03-03");
  assert.equal(s.next, "2020-03-31");
  assert.equal(s.remaining, 500000);
  assert.equal(s.overdue, 0);
  f.cmd("repay", {
    advance_id: a.id,
    paid_on: "2020-03-04",
    amount_cents: 500000,
    account: "cash",
  });
  s = partnerCashSummary(f.data.partner_cash!, a, "2020-04-01");
  assert.equal(s.remaining, 0);
  assert.equal(s.overdue, 0);
  assert.equal(s.next, null);
});
test("advance purchase is expensed once, principal repayment is excluded from profit and report totals", () => {
  const f = fixture();
  assert.equal(cashSummary(f.cash, "2020-01-01").balances.cash, 2500000);
  const purchase = f.cmd("purchase", {
    advance_id: f.a,
    paid_on: "2020-01-02",
    amount_cents: 2500000,
    total_cents: 3000000,
    category_id: "expense",
    account: "cash",
    notes: "Fictional equipment",
    reference: "TEST",
  });
  assert.equal(cashSummary(f.cash, "2020-01-02").balances.cash, -500000);
  f.cmd("repay", {
    advance_id: f.a,
    paid_on: "2020-02-01",
    amount_cents: 1000000,
    account: "cash",
  });
  assert.equal(f.data.expenses.length, 1);
  assert.equal(cashSummary(f.cash, "2020-02-01").balances.cash, -1500000);
  const report = buildFinanceReport(
    {
      finance: f.data,
      balances: f.cash,
      roi: { capital: [], exclusions: [] },
      generated_at: "2020-02-02T00:00:00Z",
      prepared_by: "Fictional admin",
    },
    {
      start: "2020-01-01",
      end: "2020-02-01",
      asOf: "2020-02-01",
      period: "custom",
    },
  );
  assert.equal(report.cash.income, 0);
  assert.equal(report.cash.expense, 3000000);
  assert.equal(report.cash.net, -3000000);
  assert.equal(report.partnerCashAdvances[0].remaining, 1500000);
  assert.equal(report.partnerCashAdvances[0].spent, 2500000);
  const exported = partnerCashCsvRows(f.data.partner_cash!, "2020-02-01");
  assert.equal(exported[2][6], 15000);
  assert(exported.some((row) => row.includes("Purchase links")));
  assert(exported.some((row) => row.includes("Repayments")));
  assert.throws(
    () => guardPartnerCashManual(f.data, "expenses", f.data.expenses[0].id),
    /Partner cash/,
  );
  f.cmd("void_purchase", {
    record_id: purchase,
    reason: "Fictional correction",
  });
  assert.equal(f.data.expenses.length, 0);
  assert.equal(f.data.partner_cash!.spends.length, 1);
});
test("demo retries and prior-date reports do not duplicate funds or count future payments", () => {
  const f = fixture(),
    id = crypto.randomUUID(),
    p = {
      advance_id: f.a,
      paid_on: "2020-03-01",
      amount_cents: 500000,
      account: "cash",
    };
  f.cmd("repay", p, id);
  f.cmd("repay", p, id);
  assert.equal(f.data.partner_cash!.repayments.length, 1);
  assert.throws(
    () => f.cmd("repay", { ...p, amount_cents: 600000 }, id),
    /Retry key/,
  );
  const a = f.data.partner_cash!.advances[0];
  assert.equal(
    partnerCashSummary(f.data.partner_cash!, a, "2020-02-01").repaid,
    0,
  );
  assert.equal(
    partnerCashSummary(f.data.partner_cash!, a, "2019-12-31").active,
    false,
  );
  assert.deepEqual(emptyPartnerCash(), {
    advances: [],
    spends: [],
    repayments: [],
  });
});
