import { payrollShiftLabel } from "./team";
import { PDFDocument, PageSizes, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { createTimesheetPdf, type TimesheetPdfAssets } from "./timesheet-pdf";
import { sumTimesheetDays, type TimesheetDay } from "./timesheets";
import { displayDate, money } from "./finance";
import type { PayrollReportData } from "./payroll-reports";
export async function createPayrollReportPdf(
  r: PayrollReportData,
  assets: TimesheetPdfAssets,
) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(
    `Finalized payroll - ${r.employee.employee_code} - ${r.statement.period_start}`,
  );
  doc.setAuthor("The Gardens");
  doc.setCreationDate(new Date(r.generated_at));
  doc.setModificationDate(new Date(r.generated_at));
  const regular = await doc.embedFont(assets.regular, { subset: true }),
    bold = await doc.embedFont(assets.bold, { subset: true });
  const crest = await doc.embedJpg(assets.crest),
    wordmark = await doc.embedPng(assets.wordmark);
  const navy = rgb(0, 27 / 255, 61 / 255),
    burgundy = rgb(142 / 255, 48 / 255, 48 / 255),
    cream = rgb(1, 250 / 255, 220 / 255),
    gold = rgb(181 / 255, 139 / 255, 37 / 255);
  const [w, h] = PageSizes.A4,
    margin = 40;
  let page = doc.addPage(PageSizes.A4),
    y = h - 110;
  const clean = (s: string) =>
    s.replace(/[\u0000-\u001f]/g, " ").replace(/[\u2010-\u2015]/g, "-");
  function text(s: string, x: number, at: number, size = 10, strong = false) {
    page.drawText(clean(s), {
      x,
      y: at,
      size,
      font: strong ? bold : regular,
      color: navy,
    });
  }
  function lines(s: string, width: number, size = 10, strong = false) {
    const out: string[] = [];
    let line = "";
    const font = strong ? bold : regular;
    for (const word of clean(s).split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
        continue;
      }
      if (line) {
        out.push(line);
        line = "";
      }
      for (const c of Array.from(word)) {
        if (font.widthOfTextAtSize(line + c, size) > width && line) {
          out.push(line);
          line = "";
        }
        line += c;
      }
    }
    if (line) out.push(line);
    return out;
  }
  function header() {
    page.drawRectangle({ x: 0, y: h - 80, width: w, height: 80, color: navy });
    page.drawImage(crest, { x: margin, y: h - 62, width: 44, height: 44 });
    page.drawImage(wordmark, { x: 110, y: h - 76, width: 220, height: 81.5 });
    page.drawRectangle({ x: 0, y: h - 83, width: w, height: 3, color: gold });
  }
  header();
  text("FINALIZED CUTOFF PAYROLL", margin, y, 17, true);
  y -= 28;
  for (const line of lines(r.employee.name, w - margin * 2, 14, true)) {
    text(line, margin, y, 14, true);
    y -= 19;
  }
  text(`Employee code: ${r.employee.employee_code}`, margin, y);
  y -= 20;
  text(
    `${displayDate(r.statement.period_start)} - ${displayDate(r.statement.period_end)}`,
    margin,
    y,
    12,
    true,
  );
  y -= 26;
  const stamp = (s: string) =>
    new Intl.DateTimeFormat("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila",
    }).format(new Date(s));
  text(`Finalized: ${stamp(r.statement.finalized_at)} (Manila)`, margin, y, 9);
  y -= 17;
  text(
    `Report / payment status as of: ${stamp(r.generated_at)} (Manila)`,
    margin,
    y,
    9,
  );
  y -= 25;
  const snapshot = r.statement.snapshot;
  const entries: [string, number][] = [
    ["Regular earnings after missed-time deduction", snapshot.regular_cents],
    ["Missed-time deduction (already applied)", snapshot.deduction_cents],
    ["Approved overtime pay", snapshot.ot_cents],
    ["Paid leave", snapshot.leave_cents],
    ["Gross earnings", r.statement.gross_cents],
    ["Salary advance recovery", r.statement.recovery_cents],
    ["NET SALARY PAYABLE", r.statement.payable_cents],
    ["Actual salary paid as of this report", r.paid_cents],
    ["REMAINING SALARY BALANCE", r.balance_cents],
  ];
  for (const [label, value] of entries) {
    const strong = /NET SALARY|REMAINING|Gross/.test(label);
    if (strong)
      page.drawRectangle({
        x: margin - 8,
        y: y - 8,
        width: w - margin * 2 + 16,
        height: 27,
        color: cream,
      });
    text(label, margin, y, 9.7, strong);
    const amount = money(value);
    text(
      amount,
      w - margin - (strong ? bold : regular).widthOfTextAtSize(amount, 11),
      y,
      11,
      strong,
    );
    y -= 30;
  }
  text(`Payment status: ${r.payment_status}`, margin, y, 12, true);
  y -= 20;
  for (const line of lines(
    "Gross = regular earnings + approved overtime + paid leave. The missed-time deduction is already reflected above; it is not deducted again.",
    w - margin * 2,
    8.5,
  )) {
    text(line, margin, y, 8.5);
    y -= 12;
  }
  y -= 16;
  function paymentHeader() {
    text("SALARY PAYMENTS INCLUDED", margin, y, 11, true);
    y -= 22;
    text("Payment date", margin, y, 9, true);
    text("Amount", 200, y, 9, true);
    text("Reference / paid from", 300, y, 9, true);
    y -= 18;
  }
  paymentHeader();
  if (!r.payments.length) {
    text("No salary payments were recorded as of this report.", margin, y, 9);
    y -= 17;
  }
  for (const p of r.payments) {
    const reference = lines(
      `${p.reference || "-"}${p.funding_account ? ` · ${p.funding_account === "cash" ? "Cash on hand" : "Bank"}` : ""}`,
      w - 300 - margin,
      8.5,
    );
    const needed = Math.max(18, reference.length * 12 + 6);
    if (y - needed < 100) {
      page = doc.addPage(PageSizes.A4);
      header();
      y = h - 110;
      for (const line of lines(
        `${r.employee.name} | ${r.employee.employee_code}`,
        w - margin * 2,
        9,
      )) {
        text(line, margin, y, 9);
        y -= 14;
      }
      text(
        `${r.statement.period_start} - ${r.statement.period_end}`,
        margin,
        y,
        9,
      );
      y -= 24;
      paymentHeader();
    }
    text(displayDate(p.paid_on), margin, y, 9);
    text(money(p.amount_cents), 200, y, 9);
    reference.forEach((s, i) => text(s, 300, y - i * 12, 8.5));
    y -= needed;
  }
  const coverPages = doc.getPageCount();
  const days: TimesheetDay[] = snapshot.days.map((d) => ({
    ...d,
    finalized: true,
    scheduled_shift: payrollShiftLabel(d),
    recorded_seconds:
      d.clock_in && d.clock_out
        ? Math.max(
            0,
            (new Date(d.clock_out).valueOf() - new Date(d.clock_in).valueOf()) /
              1000,
          )
        : null,
  }));
  const appendix = await PDFDocument.load(
    await createTimesheetPdf(
      {
        start: r.statement.period_start,
        end: r.statement.period_end,
        generated_at: r.generated_at,
        prepared_by: r.prepared_by,
        employees: [
          {
            id: r.employee.id,
            name: r.employee.name,
            employee_code: r.employee.employee_code,
            days,
            periods: [
              {
                start: r.statement.period_start,
                end: r.statement.period_end,
                finalized: true,
              },
            ],
            warnings: [],
            totals: sumTimesheetDays(days),
          },
        ],
      },
      assets,
      { attendanceOnly: true, pageOffset: coverPages },
    ),
  );
  for (const copied of await doc.copyPages(appendix, appendix.getPageIndices()))
    doc.addPage(copied);
  const pages = doc.getPages();
  for (let i = 0; i < coverPages; i++) {
    page = pages[i];
    text(`Report ${r.id}`, margin, 66, 7);
    for (const [n, line] of lines(
      `Prepared by ${r.prepared_by}. Private employee payroll report.`,
      w - margin * 2 - 40,
      7,
    ).entries())
      text(line, margin, 51 - n * 10, 7);
    text(`${i + 1} / ${pages.length}`, w - margin - 35, 35, 8);
  }
  return doc.save();
}
