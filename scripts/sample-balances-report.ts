import fs from "node:fs/promises";
import { demoData } from "../src/lib/demo";
import { demoRoi } from "../src/lib/roi";
import { demoCash } from "../src/lib/balances";
import { buildFinanceReport } from "../src/lib/finance-report";
import { createFinanceReportPdf } from "../src/lib/finance-report-pdf";
import { loadTimesheetPdfAssets } from "../src/lib/timesheet-pdf-assets";
const data = demoCash(demoData());
data.settings = {
  start_date: "2026-11-01",
  cash: 100000,
  bank: 500000,
  booking: 200000,
};
for (const row of data.finance.income)
  data.allocations.push({
    id: row.id,
    account: "booking",
    income_id: row.id,
    expense_id: null,
    payout_id: null,
    posted_on: row.business_date,
    amount_cents: row.amount_cents,
  });
for (const row of data.finance.expenses)
  data.allocations.push({
    id: row.id,
    account: "bank",
    income_id: null,
    expense_id: row.id,
    payout_id: null,
    posted_on: row.paid_on,
    amount_cents: row.amount_cents,
  });
data.movements = [
  {
    id: "fictional",
    moved_on: "2026-11-15",
    kind: "transfer",
    from_account: "booking",
    to_account: "bank",
    amount_cents: 500000,
    reference: "FICTIONAL-WITHDRAWAL",
    reason: "Sample booking withdrawal; no real transaction.",
  },
];
const { finance, ...balances } = data;
const report = buildFinanceReport(
  {
    finance,
    roi: demoRoi(),
    balances,
    prepared_by: "FICTIONAL SAMPLE ONLY",
    generated_at: "2026-12-01T02:00:00Z",
  },
  {
    start: "2026-11-01",
    end: "2026-11-30",
    asOf: "2026-11-30",
    period: "monthly",
  },
  true,
);
await fs.mkdir("../output/pdf", { recursive: true });
await fs.writeFile(
  "../output/pdf/The Gardens - Sample Account Balances Report.pdf",
  await createFinanceReportPdf(report, await loadTimesheetPdfAssets()),
);
console.log("Fictional balances PDF generated locally. No live changes.");
