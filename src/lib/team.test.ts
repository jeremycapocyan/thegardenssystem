import test from "node:test";
import assert from "node:assert/strict";
import {
  demoTeam,
  shiftHours,
  payrollShiftLabel,
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

test("custom hours pay four-hour shifts, follow effective dates and preserve frozen report labels", () => {
  const data = demoTeam(),
    e = data.employees[0];
  data.cutoff_rules = [];
  e.started_on = "2020-01-01";
  data.schedules = [
    {
      id: "s",
      employee_id: e.id,
      effective_from: "2020-01-01",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start_time: "05:30:00",
      end_time: "09:30:00",
    },
    {
      id: "s2",
      employee_id: e.id,
      effective_from: "2020-01-08",
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start_time: "15:30",
      end_time: "23:30",
    },
  ];
  data.requests = [];
  data.attendance = [
    {
      id: "a",
      employee_id: e.id,
      work_date: "2020-01-01",
      clock_in: "2020-01-01T05:30:00+08:00",
      clock_out: "2020-01-01T10:30:00+08:00",
      approved_ot_seconds: 3600,
      ot_reviewed: true,
      correction_reason: "",
    },
  ];
  const preview = previewPayroll(
    data,
    e.id,
    "2020-01-01",
    new Date("2020-01-03T00:00:00Z"),
  );
  assert.equal(preview.days[0].regular_cents, 32500);
  assert.equal(preview.days[0].ot_cents, 8125);
  assert.equal(preview.days[0].total_cents, 40625);
  assert.equal(preview.days[1].deduction_cents, 32500);
  assert.equal(preview.days[3].status, "Upcoming");
  assert.equal(preview.days[7].scheduled_cents, 65000);
  assert.equal(payrollShiftLabel(preview.days[0]), "05:30 - 09:30");
  const frozen = structuredClone(preview.days[0]);
  data.schedules[0].start_time = "07:30";
  assert.equal(payrollShiftLabel(frozen), "05:30 - 09:30");
  assert.equal(
    payrollShiftLabel({
      ...frozen,
      scheduled_start: undefined,
      scheduled_end: undefined,
    }),
    "15:30 - 23:30",
  );
  assert.deepEqual(shiftHours("05:30", "09:30"), {
    seconds: 14400,
    cents: 32500,
  });
  for (const [start, end] of [
    ["09:30", "05:30"],
    ["05:30", "05:30"],
    ["25:00", "09:30"],
    ["05:30:01", "09:30"],
  ])
    assert.throws(() => shiftHours(start, end));
});
