import test from "node:test";
import assert from "node:assert/strict";
import { roiSummary, roiTrend, type RoiData } from "./roi";
import { EMPTY_DATA, type Dataset } from "./types";
import { totals } from "./finance";
const data = (): Dataset => ({
  ...structuredClone(EMPTY_DATA),
  income: [
    {
      id: "i1",
      business_date: "2026-01-02",
      category_id: "c",
      amount_cents: 1500000,
      notes: "",
    },
  ],
  expenses: [
    {
      id: "e1",
      paid_on: "2026-01-03",
      category_id: "e",
      payment_kind: "operating",
      fixed_bill_id: null,
      installment_id: null,
      due_month: null,
      amount_cents: 500000,
      reference: "",
      notes: "",
    },
  ],
  payouts: [
    {
      id: "p1",
      paid_on: "2026-02-03",
      owner: "Genesis",
      settlement_month: "2026-01-01",
      amount_cents: 400000,
      reference: "",
      notes: "",
    },
  ],
});
const capital = (): RoiData => ({
  capital: [
    {
      id: "c1",
      owner: "Genesis",
      invested_on: "2026-01-01",
      amount_cents: 4000000,
      reference: "",
      notes: "",
    },
    {
      id: "c2",
      owner: "Ken",
      invested_on: "2026-01-01",
      amount_cents: 6000000,
      reference: "",
      notes: "",
    },
  ],
  exclusions: [],
});
test("cash ROI and owner recovery use different actual records", () => {
  const r = roiSummary(data(), capital(), "2026-02-28");
  assert.equal(r.invested, 10000000);
  assert.equal(r.returned, 1000000);
  assert.equal(r.percent, 10);
  assert.equal(r.remaining, 9000000);
  assert.equal(r.owners[0].percent, 10);
  assert.equal(r.owners[1].contribution, 6000000);
  assert.equal(r.owners[2].percent, null);
});
test("owner recovery uses actual payment date instead of settlement month", () => {
  assert.equal(roiSummary(data(), capital(), "2026-01-31").owners[0].paid, 0);
  assert.equal(
    roiSummary(data(), capital(), "2026-02-03").owners[0].paid,
    400000,
  );
});
test("capital cost addbacks affect ROI only and count the payment once", () => {
  const d = data(),
    r = capital();
  r.exclusions = [
    { id: "x", expense_id: "e1", reason: "Original court construction" },
    { id: "duplicate", expense_id: "e1", reason: "Defensive duplicate" },
  ];
  const before = totals(d, "2026-01-01", "2026-02-28");
  const result = roiSummary(d, r, "2026-02-28");
  assert.equal(result.capitalCosts, 500000);
  assert.equal(result.returned, 1500000);
  assert.deepEqual(totals(d, "2026-01-01", "2026-02-28"), before);
});
test("losses remain negative and increase the unrecovered capital", () => {
  const d = data();
  d.income = [];
  const r = roiSummary(d, capital(), "2026-01-31");
  assert.equal(r.percent, -5);
  assert.equal(r.remaining, 10500000);
});
test("additional and future capital follow the as-of date and do not become income", () => {
  const r = capital();
  r.capital.push({
    id: "c3",
    owner: "Jeremy",
    invested_on: "2026-03-01",
    amount_cents: 1000000,
    reference: "",
    notes: "",
  });
  assert.equal(roiSummary(data(), r, "2026-02-28").invested, 10000000);
  assert.equal(roiSummary(data(), r, "2026-03-01").invested, 11000000);
  assert.equal(roiSummary(data(), r, "2026-03-01").income, 1500000);
});
test("zero capital, a date before investment, and returns above capital are handled explicitly", () => {
  assert.equal(
    roiSummary(data(), { capital: [], exclusions: [] }, "2026-01-31").percent,
    null,
  );
  assert.equal(roiSummary(data(), capital(), "2025-12-31").start, null);
  const d = data();
  d.income[0].amount_cents = 15000000;
  const r = roiSummary(d, capital(), "2026-01-31");
  assert.equal(r.percent, 145);
  assert.equal(r.remaining, 0);
  assert.equal(r.surplus, 4500000);
});
test("12-month trend keeps earlier accumulated returns and includes the partial final month", () => {
  const r = roiTrend(data(), capital(), "2027-03-10");
  assert.equal(r.length, 12);
  assert.equal(r[0].month, "2026-04-01");
  assert.equal(r[0].returned, 1000000);
  assert.equal(r.at(-1)?.date, "2027-03-10");
});
