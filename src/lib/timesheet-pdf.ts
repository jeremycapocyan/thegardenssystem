import {
  PDFDocument,
  PageSizes,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { displayDate, money } from "./finance";
import { timeInManila } from "./team";
import {
  clockDuration,
  manilaDate,
  type TimesheetReport,
  type TimesheetEmployee,
  type TimesheetDay,
} from "./timesheets";

const navy = rgb(0, 27 / 255, 61 / 255),
  burgundy = rgb(142 / 255, 48 / 255, 48 / 255),
  cream = rgb(1, 250 / 255, 220 / 255),
  gold = rgb(181 / 255, 139 / 255, 37 / 255),
  ink = rgb(0.09, 0.17, 0.26),
  muted = rgb(0.4, 0.36, 0.3),
  line = rgb(0.89, 0.86, 0.79);
const clean = (value: string) =>
  value
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
function wrap(
  text: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const result: string[] = [];
  for (const paragraph of clean(text).split("\n")) {
    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (!word) continue;
      if (
        font.widthOfTextAtSize(current ? `${current} ${word}` : word, size) <=
        width
      ) {
        current = current ? `${current} ${word}` : word;
        continue;
      }
      if (current) {
        result.push(current);
        current = "";
      }
      for (const character of Array.from(word)) {
        if (
          font.widthOfTextAtSize(current + character, size) > width &&
          current
        ) {
          result.push(current);
          current = "";
        }
        current += character;
      }
    }
    result.push(current);
  }
  return result.length ? result : [""];
}
function punch(stamp: string | null, day: string) {
  if (!stamp) return "-";
  const time = timeInManila(stamp);
  return manilaDate(stamp) === day
    ? time
    : `${displayDate(manilaDate(stamp), { month: "short", year: "2-digit" })}\n${time}`;
}
export interface TimesheetPdfAssets {
  regular: Uint8Array;
  bold: Uint8Array;
  crest: Uint8Array;
  wordmark: Uint8Array;
}
export async function createTimesheetPdf(
  report: TimesheetReport,
  assets: TimesheetPdfAssets,
): Promise<Uint8Array> {
  const {
    regular: regularBytes,
    bold: boldBytes,
    crest: crestBytes,
    wordmark: wordmarkBytes,
  } = assets;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`The Gardens timesheet ${report.start} to ${report.end}`);
  doc.setAuthor("The Gardens");
  doc.setSubject("Private attendance and earnings report");
  const regular = await doc.embedFont(regularBytes, { subset: true }),
    bold = await doc.embedFont(boldBytes, { subset: true });
  // Fail visibly instead of producing a missing-glyph square for peso amounts.
  if (!regular.getCharacterSet().includes(0x20b1))
    throw Error("The PDF font must support the Philippine peso symbol.");
  const crest = await doc.embedJpg(crestBytes),
    wordmark = await doc.embedPng(wordmarkBytes);
  const [width, height] = PageSizes.A4.slice().reverse(),
    margin = 32,
    tableWidth = width - margin * 2;
  const generated = new Intl.DateTimeFormat("en-PH", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Manila",
  }).format(new Date(report.generated_at));
  function newPage(employee: TimesheetEmployee | null, section: string) {
    const page = doc.addPage([width, height]);
    page.drawRectangle({
      x: 0,
      y: height - 78,
      width,
      height: 78,
      color: navy,
    });
    page.drawImage(crest, { x: margin, y: height - 61, width: 44, height: 44 });
    page.drawImage(wordmark, {
      x: 82,
      y: height - 78,
      width: 218,
      height: 80.7,
    });
    page.drawText("TIMESHEET", {
      x: width - 260,
      y: height - 32,
      size: 17,
      font: bold,
      color: cream,
    });
    page.drawText(`${displayDate(report.start)} - ${displayDate(report.end)}`, {
      x: width - 260,
      y: height - 53,
      size: 10,
      font: regular,
      color: cream,
    });
    page.drawRectangle({ x: 0, y: height - 81, width, height: 3, color: gold });
    let y = height - 105;
    if (employee) {
      for (const text of wrap(employee.name, bold, 14, tableWidth - 150)) {
        page.drawText(text, { x: margin, y, size: 14, font: bold, color: ink });
        y -= 18;
      }
      const final = employee.periods.every((p) => p.finalized),
        mixed = !final && employee.periods.some((p) => p.finalized);
      page.drawText(
        `${employee.employee_code}  |  ${final ? "Finalized payroll figures" : mixed ? "Mixed: Draft rows are provisional" : "DRAFT - earnings may change"}`,
        {
          x: margin,
          y: y - 1,
          size: 9,
          font: regular,
          color: final ? muted : burgundy,
        },
      );
      y -= 25;
    }
    page.drawText(section, {
      x: margin,
      y,
      size: 12,
      font: bold,
      color: burgundy,
    });
    return { page, y: y - 16 };
  }
  function text(
    page: PDFPage,
    value: string,
    x: number,
    y: number,
    size = 8.6,
    font = regular,
    color = ink,
  ) {
    page.drawText(clean(value), { x, y, size, font, color });
  }
  function table(
    employee: TimesheetEmployee,
    title: string,
    headers: string[],
    weights: number[],
    rows: string[][],
    summary: string,
  ) {
    const widths = weights.map(
      (w) => (w / weights.reduce((n, v) => n + v, 0)) * tableWidth,
    );
    let { page, y } = newPage(employee, title);
    const header = () => {
      const lines = headers.map((h, i) => wrap(h, bold, 8.2, widths[i] - 12)),
        h = Math.max(...lines.map((l) => l.length)) * 11 + 12;
      page.drawRectangle({
        x: margin,
        y: y - h,
        width: tableWidth,
        height: h,
        color: cream,
      });
      let x = margin;
      lines.forEach((cells, i) => {
        cells.forEach((s, j) =>
          text(page, s, x + 6, y - 12 - j * 11, 8.2, bold),
        );
        x += widths[i];
      });
      y -= h;
    };
    header();
    rows.forEach((row, index) => {
      const lines = row.map((cell, i) =>
          wrap(cell, regular, 8.6, widths[i] - 12),
        ),
        h = Math.max(21, Math.max(...lines.map((l) => l.length)) * 11 + 10);
      if (y - h < 72) {
        ({ page, y } = newPage(employee, `${title} (continued)`));
        header();
      }
      if (index % 2 === 0)
        page.drawRectangle({
          x: margin,
          y: y - h,
          width: tableWidth,
          height: h,
          color: rgb(0.985, 0.978, 0.95),
        });
      let x = margin;
      lines.forEach((cells, i) => {
        cells.forEach((s, j) => text(page, s, x + 6, y - 12 - j * 11));
        x += widths[i];
      });
      page.drawLine({
        start: { x: margin, y: y - h },
        end: { x: width - margin, y: y - h },
        thickness: 0.4,
        color: line,
      });
      y -= h;
    });
    const summaryLines = wrap(summary, bold, 9, tableWidth - 16),
      needed = summaryLines.length * 13 + 22;
    if (y - needed < 72) ({ page, y } = newPage(employee, `${title} totals`));
    page.drawRectangle({
      x: margin,
      y: y - needed - 6,
      width: tableWidth,
      height: needed,
      color: cream,
    });
    summaryLines.forEach((s, i) =>
      text(page, s, margin + 8, y - 21 - i * 13, 9, bold),
    );
  }
  if (!report.employees.length) {
    const { page, y } = newPage(null, "No employees in this date range");
    text(
      page,
      "No employee employment dates overlap the selected reporting dates.",
      margin,
      y - 22,
      11,
    );
  }
  for (const employee of report.employees) {
    const t = employee.totals,
      mixed =
        employee.periods.some((p) => p.finalized) &&
        employee.periods.some((p) => !p.finalized);
    const status = (d: TimesheetDay) =>
      `${d.status}${mixed && !d.finalized ? " [Draft]" : ""}`;
    table(
      employee,
      "Attendance",
      [
        "Work date",
        "Scheduled shift",
        "Time in (Manila)",
        "Time out (Manila)",
        "Recorded time",
        "Late",
        "Undertime",
        "Recorded OT",
        "Approved OT",
        "Status",
      ],
      [75, 85, 100, 100, 70, 55, 60, 65, 65, 100],
      employee.days.map((d) => [
        displayDate(d.date, { month: "short", year: "2-digit" }),
        d.scheduled_shift,
        punch(d.clock_in, d.date),
        punch(d.clock_out, d.date),
        d.clock_in && !d.clock_out
          ? "Open / missing time out"
          : d.recorded_seconds === null
            ? "-"
            : clockDuration(d.recorded_seconds),
        clockDuration(d.late_seconds),
        clockDuration(d.undertime_seconds),
        clockDuration(d.overtime_seconds),
        `${clockDuration(d.approved_ot_seconds)}${d.overtime_seconds > 0 && !d.ot_reviewed ? " (pending review)" : ""}`,
        status(d),
      ]),
      `Recorded time: ${clockDuration(t.recorded_seconds)}   |   Late: ${clockDuration(t.late_seconds)}   |   Undertime: ${clockDuration(t.undertime_seconds)}   |   Approved overtime: ${clockDuration(t.approved_ot_seconds)}. Open shifts are excluded from recorded-time totals.`,
    );
    table(
      employee,
      "Earnings",
      [
        "Work date",
        "Status",
        "Regular earned",
        "Missed deduction (already applied)",
        "Approved OT pay",
        "Paid leave",
        "Gross earned",
      ],
      [75, 155, 100, 125, 105, 105, 110],
      employee.days.map((d) => [
        displayDate(d.date, { month: "short", year: "2-digit" }),
        status(d),
        money(d.regular_cents),
        money(d.deduction_cents),
        money(d.ot_cents),
        money(d.leave_cents),
        money(d.total_cents),
      ]),
      `Regular earned: ${money(t.regular_cents)}   |   Missed-time deduction (already applied): ${money(t.deduction_cents)}   |   Approved OT: ${money(t.ot_cents)}   |   Paid leave: ${money(t.leave_cents)}   |   Gross earnings: ${money(t.gross_cents)}. Gross = regular earned + approved OT + paid leave. Do not subtract the deduction again.`,
    );
  }
  const pages = doc.getPages();
  pages.forEach((page, index) => {
    page.drawLine({
      start: { x: margin, y: 59 },
      end: { x: width - margin, y: 59 },
      thickness: 0.6,
      color: line,
    });
    text(
      page,
      "Private HR report. Times use Asia/Manila; another date is shown for overnight punches.",
      margin,
      45,
      8,
      regular,
      muted,
    );
    const prepared = `Generated ${generated}  |  Prepared by ${report.prepared_by}`;
    wrap(prepared, regular, 7.5, tableWidth - 75)
      .slice(0, 2)
      .forEach((s, i) =>
        text(page, s, margin, 31 - i * 10, 7.5, regular, muted),
      );
    text(
      page,
      `${index + 1} / ${pages.length}`,
      width - margin - 44,
      31,
      8,
      regular,
      muted,
    );
  });
  return doc.save();
}
