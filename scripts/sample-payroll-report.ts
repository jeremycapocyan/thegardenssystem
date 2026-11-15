import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { payrollReportFixture } from "./report-fixture";
import { createPayrollReportPdf } from "../src/lib/payroll-report-pdf";
import { loadTimesheetPdfAssets } from "../src/lib/timesheet-pdf-assets";
const { report } = payrollReportFixture(),
  assets = await loadTimesheetPdfAssets(),
  out = path.resolve("../output/pdf");
await mkdir(out, { recursive: true });
await writeFile(
  path.join(out, "The Gardens - Sample Finalized Payroll.pdf"),
  await createPayrollReportPdf(report, assets),
);
const tmp = path.resolve("../tmp/pdfs");
await mkdir(tmp, { recursive: true });
report.payments = Array.from({ length: 28 }, (_, i) => ({
  paid_on: "2026-11-13",
  amount_cents: 100,
  reference: `Fictional stress reference ${i} with a long reference to test wrapping and page breaks without clipping.`,
}));
await writeFile(
  path.join(tmp, "payroll-report-stress.pdf"),
  await createPayrollReportPdf(report, assets),
);
console.log(
  "Created fictional finalized payroll PDFs locally; no database connection.",
);
