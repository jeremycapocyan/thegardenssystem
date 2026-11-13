import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PageSizes } from "pdf-lib";
import { demoTeam, previewPayroll } from "./team";
import {
  demoTimesheetReport,
  validateTimesheetRange,
  manilaDate,
} from "./timesheets";
import { createTimesheetPdf } from "./timesheet-pdf";
import { loadTimesheetPdfAssets } from "./timesheet-pdf-assets";
import { demoPinPunch } from "./demo-pin-clock";

test("timesheet ranges include leap days and year boundaries but never more than 31 days", () => {
  for (const [s, e] of [
    ["2028-02-01", "2028-02-29"],
    ["2026-12-20", "2027-01-19"],
  ])
    validateTimesheetRange(s, e);
  for (const [s, e] of [
    ["2026-11-01", "2026-12-02"],
    ["2026-02-30", "2026-03-01"],
    ["2026-11-02", "2026-11-01"],
    ["", ""],
  ])
    assert.throws(() => validateTimesheetRange(s, e));
  assert.equal(manilaDate("2026-11-14T16:30:00Z"), "2026-11-15");
});
function fixture() {
  const data = demoTeam(),
    e = data.employees[0];
  e.started_on = "2020-01-01";
  data.employees = [e];
  data.payroll = [];
  data.requests = [];
  data.cash = [];
  data.recoveries = [];
  data.schedules = [
    {
      id: "s",
      employee_id: e.id,
      effective_from: e.started_on,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
  ];
  data.attendance = [
    {
      id: "a",
      employee_id: e.id,
      work_date: "2020-01-01",
      clock_in: "2020-01-01T08:00:00Z",
      clock_out: "2020-01-01T15:30:00Z",
      ot_reviewed: true,
      approved_ot_seconds: 0,
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
  return data;
}
test("reports use net regular earnings once, clip dates, retain inactive employees and freeze finalized days", () => {
  const data = fixture(),
    e = data.employees[0];
  e.active = false;
  const report = demoTimesheetReport(
    data,
    "2020-01-01",
    "2020-01-02",
    e.id,
    new Date("2020-02-01"),
  );
  assert.equal(report.employees[0].totals.gross_cents, 134062);
  assert.equal(report.employees[0].totals.deduction_cents, 4063);
  assert.equal(report.employees[0].totals.recorded_seconds, 59400);
  const snapshot = previewPayroll(
    data,
    e.id,
    "2020-01-01",
    new Date("2020-02-01"),
  );
  data.payroll = [
    {
      id: "p",
      employee_id: e.id,
      period_start: "2020-01-01",
      period_end: "2020-01-15",
      snapshot,
      gross_cents: snapshot.gross_cents,
      recovery_cents: 0,
      payable_cents: snapshot.gross_cents,
      finalized_at: "2020-02-01",
    },
  ];
  data.attendance = [];
  const frozen = demoTimesheetReport(data, "2020-01-02", "2020-01-02", e.id)
    .employees[0];
  assert.equal(frozen.days.length, 1);
  assert.equal(frozen.days[0].finalized, true);
  assert.equal(frozen.totals.gross_cents, 73125);
  e.ended_on = "2019-12-31";
  assert.equal(
    demoTimesheetReport(data, "2020-01-01", "2020-01-02").employees.length,
    0,
  );
});
test("sample PIN attendance supports idempotent retry, overnight matching and deactivation without storing a PIN", () => {
  const data = fixture();
  data.attendance = [];
  data.qr = { id: "demo-court-qr" };
  const first = demoPinPunch(
    data,
    [],
    "TG-1",
    "123456",
    "clock_in",
    "in",
    new Date("2020-01-01T07:30:00Z"),
  );
  const retry = demoPinPunch(
    first.data,
    first.events,
    "TG-1",
    "123456",
    "clock_in",
    "in",
    new Date("2020-01-01T07:30:02Z"),
  );
  assert.equal(retry.data.attendance.length, 1);
  assert.throws(
    () =>
      demoPinPunch(
        first.data,
        first.events,
        "TG-1",
        "123456",
        "clock_in",
        "other",
      ),
    /already/,
  );
  const last = demoPinPunch(
    first.data,
    first.events,
    "TG-1",
    "123456",
    "clock_out",
    "out",
    new Date("2020-01-01T16:30:00Z"),
  );
  assert.equal(last.data.attendance[0].work_date, "2020-01-01");
  assert(!JSON.stringify(last).includes("123456"));
  last.data.employees[0].active = false;
  assert.throws(
    () =>
      demoPinPunch(
        last.data,
        last.events,
        "TG-1",
        "123456",
        "clock_in",
        "next",
      ),
    /inactive/,
  );
});
test("PDF embeds serif fonts with peso support, A4 landscape and multipage sections", async () => {
  const data = fixture();
  data.employees[0].name = "María de los Ángeles Peña Santos";
  const report = demoTimesheetReport(
    data,
    "2020-01-01",
    "2020-01-31",
    null,
    new Date("2020-02-01"),
  );
  const pdf = await PDFDocument.load(
    await createTimesheetPdf(report, await loadTimesheetPdfAssets()),
  );
  assert(pdf.getPageCount() >= 4);
  for (const page of pdf.getPages()) {
    assert.equal(page.getWidth(), PageSizes.A4[1]);
    assert.equal(page.getHeight(), PageSizes.A4[0]);
  }
});
