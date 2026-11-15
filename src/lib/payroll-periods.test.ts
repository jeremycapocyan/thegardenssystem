import test from "node:test";
import assert from "node:assert/strict";
import { payrollBounds, type CutoffRule } from "./payroll-periods";
import { demoTeam, previewPayroll } from "./team";
import { demoCutoffSummary, sumCutoffEmployees } from "./payroll-summary";
const rules: CutoffRule[] = [
  { effective_from: "2000-01-01", first_day: 15, second_day: 31 },
  { effective_from: "2026-11-01", first_day: 12, second_day: 28 },
];
test("12th/28th cutoffs cover transition, cross-month/year periods and February without gaps", () => {
  for (const [day, start, end] of [
    ["2026-10-31", "2026-10-16", "2026-10-31"],
    ["2026-11-01", "2026-11-01", "2026-11-12"],
    ["2026-11-12", "2026-11-01", "2026-11-12"],
    ["2026-11-13", "2026-11-13", "2026-11-28"],
    ["2026-11-28", "2026-11-13", "2026-11-28"],
    ["2026-11-29", "2026-11-29", "2026-12-12"],
    ["2027-01-01", "2026-12-29", "2027-01-12"],
    ["2027-02-28", "2027-02-13", "2027-02-28"],
    ["2027-03-01", "2027-03-01", "2027-03-12"],
    ["2028-02-29", "2028-02-29", "2028-03-12"],
  ]) {
    assert.deepEqual(
      [payrollBounds(day, rules).start, payrollBounds(day, rules).end],
      [start, end],
    );
  }
  const changed = [
    ...rules,
    { effective_from: "2026-11-29", first_day: 10, second_day: 25 },
  ];
  assert.equal(payrollBounds("2026-11-28", changed).end, "2026-11-28");
  assert.equal(payrollBounds("2026-11-30", changed).start, "2026-11-29");
  assert.equal(payrollBounds("2026-11-30", changed).end, "2026-12-10");
});
test("cutoff totals separate finalized amounts, draft estimates, advance recoveries and actual partial payments", () => {
  const data = demoTeam();
  data.cutoff_rules = rules;
  data.payroll = [];
  data.attendance = [];
  data.requests = [];
  data.cash = [];
  data.recoveries = [];
  for (const e of data.employees) e.started_on = "2026-11-01";
  const [alex, sam] = data.employees;
  sam.active = false;
  data.schedules = data.employees.map((e) => ({
    id: e.id,
    employee_id: e.id,
    effective_from: "2026-11-01",
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  }));
  data.attendance = [
    {
      id: "a",
      employee_id: alex.id,
      work_date: "2026-11-13",
      clock_in: "2026-11-13T08:00:00Z",
      clock_out: "2026-11-13T15:30:00Z",
      ot_reviewed: true,
      approved_ot_seconds: 0,
      correction_reason: "",
    },
  ];
  const snapshot = previewPayroll(
    data,
    alex.id,
    "2026-11-13",
    new Date("2026-12-01"),
  );
  data.payroll = [
    {
      id: "p",
      employee_id: alex.id,
      period_start: "2026-11-13",
      period_end: "2026-11-28",
      snapshot,
      gross_cents: snapshot.gross_cents,
      recovery_cents: 10000,
      payable_cents: snapshot.gross_cents - 10000,
      finalized_at: "2026-12-01",
    },
  ];
  data.cash = [
    {
      id: "salary",
      employee_id: alex.id,
      kind: "salary",
      request_id: null,
      payroll_id: "p",
      amount_cents: 20000,
      paid_on: "2026-12-02",
      reference: "",
      created_at: "2026-12-02",
    },
  ];
  data.attendance = [];
  const r = demoCutoffSummary(data, "2026-11-13", new Date("2026-12-01"));
  assert.equal(r.employees.length, 2);
  assert.equal(r.totals.gross_cents, 60937);
  assert.equal(r.totals.recovery_cents, 10000);
  assert.equal(r.totals.payable_cents, 50937);
  assert.equal(r.totals.paid_cents, 20000);
  assert.equal(r.totals.balance_cents, 30937);
  assert.equal(r.totals.finalized_payable_cents, 50937);
  assert.equal(r.totals.finalized_count, 1);
  assert.equal(r.totals.draft_count, 1);
  assert.equal(sumCutoffEmployees([]).payable_cents, 0);
});
