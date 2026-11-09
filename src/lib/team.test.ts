import test from "node:test";
import assert from "node:assert/strict";
import {
  demoTeam,
  previewPayroll,
  employeePeriod,
  payrollEnd,
  fromManilaInput,
  manilaInput,
} from "./team";
test("semi-monthly boundaries include February and calendar month ends", () => {
  assert.equal(employeePeriod("2028-02-15"), "2028-02-01");
  assert.equal(employeePeriod("2028-02-16"), "2028-02-16");
  assert.equal(payrollEnd("2028-02-16"), "2028-02-29");
  assert.equal(payrollEnd("2026-12-16"), "2026-12-31");
});
test("Manila correction inputs convert to UTC and back without device timezone assumptions", () => {
  const value = fromManilaInput("2026-11-10T15:30");
  assert.equal(value, "2026-11-10T07:30:00.000Z");
  assert.equal(manilaInput(value), "2026-11-10T15:30");
});
test("demo payroll preserves server salary, overtime, and centavo rules", () => {
  const data = demoTeam(),
    e = data.employees[0];
  e.started_on = "2020-01-01";
  data.schedules = [
    {
      id: "s",
      employee_id: e.id,
      effective_from: e.started_on,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
  ];
  data.requests = [];
  data.attendance = [
    {
      id: "a",
      employee_id: e.id,
      work_date: "2020-01-01",
      clock_in: "2020-01-01T08:00:00Z",
      clock_out: "2020-01-01T15:30:00Z",
      ot_reviewed: false,
      approved_ot_seconds: null,
      correction_reason: "",
    },
    {
      id: "b",
      employee_id: e.id,
      work_date: "2020-01-02",
      clock_in: "2020-01-02T07:30:00Z",
      clock_out: "2020-01-02T16:30:00Z",
      ot_reviewed: true,
      approved_ot_seconds: 3600,
      correction_reason: "",
    },
  ];
  const p = previewPayroll(data, e.id, "2020-01-01", new Date("2020-02-01"));
  assert.equal(p.days[0].regular_cents, 60937);
  assert.equal(p.days[1].total_cents, 73125);
  assert.equal(p.gross_cents, 134062);
  assert.equal(p.blockers.length, 0);
});
