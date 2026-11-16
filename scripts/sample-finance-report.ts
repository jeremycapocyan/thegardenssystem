import fs from "node:fs/promises";
import { demoData } from "../src/lib/demo";
import { demoRoi } from "../src/lib/roi";
import { buildFinanceReport } from "../src/lib/finance-report";
import { createFinanceReportPdf } from "../src/lib/finance-report-pdf";
import { loadTimesheetPdfAssets } from "../src/lib/timesheet-pdf-assets";
const source = {
  finance: demoData(),
  roi: demoRoi(),
  generated_at: "2026-12-01T02:00:00Z",
  prepared_by: "SAMPLE WORKSPACE - fictional records only",
};
const examplePayment = source.finance.expenses.find(
  (e) => e.paid_on >= "2026-11-01" && e.paid_on <= "2026-11-30",
)!;
examplePayment.notes =
  "Fictional court payment. Includes the full reference, obligation link, due month and notes for review.";
const options = {
  start: "2026-11-01",
  end: "2026-11-30",
  asOf: "2026-12-01",
  period: "monthly" as const,
};
const assets = await loadTimesheetPdfAssets();
await fs.mkdir("../output/pdf", { recursive: true });
await fs.mkdir("../tmp/pdfs", { recursive: true });
await fs.writeFile(
  "../output/pdf/The Gardens - Sample Finance Report.pdf",
  await createFinanceReportPdf(
    buildFinanceReport(source, options, true),
    assets,
  ),
);
examplePayment.notes =
  "Fictional stress test with long notes and reference text ₱205,457.96. ".repeat(
    200,
  );
await fs.writeFile(
  "../tmp/pdfs/finance-stress.pdf",
  await createFinanceReportPdf(
    buildFinanceReport(source, options, true),
    assets,
  ),
);
console.log(
  "Generated fictional finance PDFs locally. No database changes or emails.",
);
