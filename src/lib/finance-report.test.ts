import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PageSizes } from "pdf-lib";
import { demoData } from "./demo";
import { demoRoi } from "./roi";
import {
  buildFinanceReport,
  validateFinanceReportRange,
} from "./finance-report";
import { createFinanceReportPdf } from "./finance-report-pdf";
import { loadTimesheetPdfAssets } from "./timesheet-pdf-assets";
import { EMPTY_DATA } from "./types";
const options = {
  start: "2026-11-01",
  end: "2026-11-30",
  asOf: "2026-12-01",
  period: "monthly" as const,
};
const source = () => ({
  finance: demoData(),
  roi: demoRoi(),
  generated_at: "2026-12-01T02:00:00Z",
  prepared_by: "Fictional sample administrator",
});
test("finance PDF totals reconcile to all detailed records and expense categories without counting payouts as expenses", () => {
  const r = buildFinanceReport(source(), options);
  assert.equal(
    r.cash.income,
    r.income.reduce((n, e) => n + e.amount_cents, 0),
  );
  assert.equal(
    r.cash.expense,
    r.expenses.reduce((n, e) => n + e.amount_cents, 0),
  );
  assert.equal(
    r.cash.expense,
    r.cash.operating + r.cash.fixed + r.cash.installment,
  );
  assert.equal(r.cash.net, r.cash.income - r.cash.expense);
  assert.equal(r.retained, r.cash.net - r.paidToOwners);
  assert.equal(
    r.expenseCategories.reduce((n, c) => n + c.amount, 0),
    r.cash.expense,
  );
  assert.equal(
    r.daily.reduce((n, d) => n + d.net, 0),
    r.cash.net,
  );
  assert.equal(
    Object.values(r.shares).reduce((a, b) => a + b, 0),
    r.cash.distributable,
  );
});
test("partial report uses actual payment dates once, full calendar-month owner entitlement and later settlement payouts", () => {
  const s = source();
  s.finance = {
    ...structuredClone(EMPTY_DATA),
    categories: s.finance.categories,
  };
  s.roi = { capital: [], exclusions: [] };
  s.finance.income = [
    {
      id: "i1",
      business_date: "2026-11-01",
      category_id: "income-0",
      amount_cents: 1000000,
      notes: "",
    },
    {
      id: "i2",
      business_date: "2026-11-30",
      category_id: "income-0",
      amount_cents: 500000,
      notes: "",
    },
  ];
  s.finance.expenses = [
    {
      id: "e1",
      paid_on: "2026-11-01",
      category_id: "expense-0",
      payment_kind: "operating",
      fixed_bill_id: null,
      installment_id: null,
      due_month: null,
      amount_cents: 100000,
      reference: "WAGE-1",
      notes: "Linked wage expense",
      staff_payment_id: "wage-1",
    },
  ];
  s.finance.payouts = [
    {
      id: "p",
      paid_on: "2026-12-01",
      owner: "Genesis",
      settlement_month: "2026-11-01",
      amount_cents: 10000,
      reference: "PAY-1",
      notes: "",
    },
  ];
  const r = buildFinanceReport(s, {
    ...options,
    end: "2026-11-01",
    period: "daily",
  });
  assert.equal(r.cash.net, 900000);
  assert.equal(r.cash.expense, 100000);
  assert.equal(r.paidToOwners, 0);
  assert.equal(r.shares.Genesis, 360000);
  assert.equal(r.ownerMonths[0].net, 1400000);
  assert.equal(r.ownerMonths[0].owners[0].entitlement, 560000);
  assert.equal(r.ownerMonths[0].owners[0].paid, 10000);
  s.finance.payouts[0].amount_cents = 9999999;
  assert.equal(
    r.ownerMonths[0].owners[0].paid,
    10000,
    "report payload is frozen",
  );
});
test("ranges include year-crossing weeks and leap days; invalid and excessive ranges fail", () => {
  assert.equal(
    validateFinanceReportRange({
      ...options,
      start: "2026-12-28",
      end: "2027-01-03",
      period: "weekly",
    }),
    7,
  );
  assert.equal(
    validateFinanceReportRange({
      ...options,
      start: "2024-01-01",
      end: "2024-12-31",
      period: "custom",
    }),
    366,
  );
  assert.throws(
    () =>
      validateFinanceReportRange({
        ...options,
        start: "2026-11-30",
        end: "2026-11-01",
      }),
    /1 to 366/,
  );
  assert.throws(
    () =>
      validateFinanceReportRange({
        ...options,
        start: "2023-01-01",
        end: "2024-12-31",
      }),
    /1 to 366/,
  );
  assert.throws(
    () => validateFinanceReportRange({ ...options, asOf: "2026-02-30" }),
    /valid date/,
  );
});
test("installment schedule clamps month ends, adjusts final payment and separates period payments from cumulative progress", () => {
  const s = source();
  s.finance = {
    ...structuredClone(EMPTY_DATA),
    categories: s.finance.categories,
  };
  s.finance.installments = [
    {
      id: "a",
      code: "TEST-01",
      name: "Fictional agreement",
      category_id: "expense-9",
      total_cents: 100000,
      monthly_cents: 60000,
      first_due: "2026-01-31",
      notes: "",
    },
  ];
  s.finance.expenses = [
    {
      id: "e",
      paid_on: "2026-03-02",
      category_id: "expense-9",
      payment_kind: "installment",
      fixed_bill_id: null,
      installment_id: "a",
      due_month: "2026-02-01",
      amount_cents: 100000,
      reference: "LATE",
      notes: "",
    },
  ];
  const feb = buildFinanceReport(s, {
    ...options,
    start: "2026-02-01",
    end: "2026-02-28",
    asOf: "2026-03-02",
  });
  assert.equal(feb.cash.installment, 0);
  assert.equal(feb.installments[0].scheduled, 40000);
  assert.equal(feb.installments[0].finalPayment, 40000);
  assert.equal(feb.installments[0].paid, 100000);
  assert.equal(feb.installments[0].remaining, 0);
  assert.equal(feb.installments[0].next, null);
  const march = buildFinanceReport(s, {
    ...options,
    start: "2026-03-01",
    end: "2026-03-31",
    asOf: "2026-03-02",
  });
  assert.equal(march.cash.installment, 100000);
  assert.equal(march.installments[0].scheduled, 0);
});
test("fixed bill balances use historical effective terms and late partial payments without changing report-period cash", () => {
  const s = source();
  s.finance = {
    ...structuredClone(EMPTY_DATA),
    categories: s.finance.categories,
  };
  s.finance.bills = [
    {
      id: "b",
      code: "RENT-1",
      name: "Court rent",
      category_id: "expense-6",
      notes: "",
    },
  ];
  s.finance.terms = [
    {
      id: "old",
      bill_id: "b",
      start_month: "2026-01-01",
      end_month: "2026-02-01",
      amount_cents: 100000,
      due_day: 31,
    },
    {
      id: "new",
      bill_id: "b",
      start_month: "2026-03-01",
      end_month: null,
      amount_cents: 200000,
      due_day: 31,
    },
  ];
  s.finance.expenses = [
    {
      id: "e",
      paid_on: "2026-03-02",
      category_id: "expense-6",
      payment_kind: "fixed",
      fixed_bill_id: "b",
      installment_id: null,
      due_month: "2026-02-01",
      amount_cents: 25000,
      reference: "PART",
      notes: "",
    },
  ];
  const r = buildFinanceReport(s, {
    ...options,
    start: "2026-02-01",
    end: "2026-02-28",
    asOf: "2026-03-02",
  });
  assert.equal(r.bills[0].expected, 100000);
  assert.equal(r.bills[0].due, "2026-02-28");
  assert.equal(r.bills[0].paid, 25000);
  assert.equal(r.bills[0].overdue, 75000);
  assert.equal(r.cash.expense, 0);
});
test("losses distribute zero, centavo shares reconcile, and duplicate/unknown records are flagged without exclusion", () => {
  const s = source();
  s.finance.income = [];
  const base = s.finance.expenses[0];
  s.finance.expenses = [
    { ...base, id: "e1", paid_on: "2026-11-01", category_id: "missing" },
    { ...base, id: "e2", paid_on: "2026-11-01", category_id: "missing" },
  ];
  const loss = buildFinanceReport(s, options);
  assert.equal(loss.cash.distributable, 0);
  assert.deepEqual(loss.shares, { Genesis: 0, Ken: 0, Jeremy: 0 });
  assert.equal(loss.cash.expense, base.amount_cents * 2);
  assert(loss.warnings.some((w) => /missing category/.test(w)));
  assert(loss.warnings.some((w) => /duplicates/.test(w)));
  s.finance.expenses = [];
  s.finance.income = [
    {
      id: "cent",
      business_date: "2026-11-01",
      category_id: "income-0",
      amount_cents: 1,
      notes: "",
    },
  ];
  const cent = buildFinanceReport(s, options);
  assert.deepEqual(cent.shares, { Genesis: 0, Ken: 0, Jeremy: 1 });
});
test("finance PDF includes every section, embeds serif peso fonts and paginates very long notes", async () => {
  const s = source();
  const assets = await loadTimesheetPdfAssets();
  const baseline = await PDFDocument.load(
    await createFinanceReportPdf(buildFinanceReport(s, options, true), assets),
  );
  const longPayment = s.finance.expenses.find(
    (e) => e.paid_on >= options.start && e.paid_on <= options.end,
  )!;
  longPayment.notes = "Fictional long reference and notes. ".repeat(350);
  const bytes = await createFinanceReportPdf(
    buildFinanceReport(s, options, true),
    assets,
  );
  const pdf = await PDFDocument.load(bytes);
  assert(pdf.getPageCount() > baseline.getPageCount() + 3);
  for (const page of pdf.getPages()) {
    assert.equal(page.getWidth(), PageSizes.A4[1]);
    assert.equal(page.getHeight(), PageSizes.A4[0]);
  }
  assert.match(pdf.getTitle() || "", /Finance report/);
});
