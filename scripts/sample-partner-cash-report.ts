import fs from "node:fs/promises";
import { EMPTY_DATA, type Dataset } from "../src/lib/types";
import { demoCash, type CashData } from "../src/lib/balances";
import { applyPartnerCashDemo } from "../src/lib/partner-cash-demo";
import { buildFinanceReport } from "../src/lib/finance-report";
import { createFinanceReportPdf } from "../src/lib/finance-report-pdf";
import { loadTimesheetPdfAssets } from "../src/lib/timesheet-pdf-assets";
let finance: Dataset = {
  ...structuredClone(EMPTY_DATA),
  categories: [
    {
      id: "expense",
      kind: "expense",
      name: "Equipment / maintenance",
      active: true,
    },
  ],
};
let balances: CashData = {
  ...demoCash(finance),
  settings: { start_date: "2026-11-01", cash: 0, bank: 5000000, booking: 0 },
};
function command(
  action: Parameters<typeof applyPartnerCashDemo>[2],
  p: Record<string, unknown>,
) {
  const id = crypto.randomUUID(),
    next = applyPartnerCashDemo(finance, balances, action, id, p, "2027-02-02");
  finance = next.data;
  balances = next.balances;
  return id;
}
const a = command("receive", {
  owner: "Genesis",
  purpose: "SAMPLE ONLY — equipment cash advance with separate repayments",
  received_on: "2026-11-24",
  amount_cents: 3000000,
  monthly_cents: 1000000,
  first_due: "2027-01-31",
  account: "cash",
  reference: "SAMPLE RECEIPT",
});
command("purchase", {
  advance_id: a,
  paid_on: "2026-11-25",
  amount_cents: 1800000,
  total_cents: 1800000,
  category_id: "expense",
  account: "cash",
  notes: "SAMPLE ONLY — equipment purchase",
  reference: "SAMPLE PURCHASE",
});
command("purchase", {
  advance_id: a,
  paid_on: "2026-11-26",
  amount_cents: 1200000,
  total_cents: 1500000,
  category_id: "expense",
  account: "cash",
  notes: "SAMPLE ONLY — partially advance-funded purchase",
  reference: "SAMPLE SPLIT FUNDING",
});
command("repay", {
  advance_id: a,
  paid_on: "2027-01-31",
  amount_cents: 500000,
  account: "bank",
  reference: "SAMPLE PARTIAL REPAYMENT",
});
command("receive", {
  owner: "Ken",
  purpose: "SAMPLE ONLY — unused advance, no purchase recorded",
  received_on: "2026-11-25",
  amount_cents: 1000000,
  monthly_cents: 1000000,
  first_due: "2027-01-12",
  account: "bank",
});
const options = {
  start: "2026-11-01",
  end: "2027-01-31",
  asOf: "2027-02-02",
  period: "custom" as const,
};
const source = {
  finance,
  balances,
  roi: { capital: [], exclusions: [] },
  generated_at: "2027-02-02T02:00:00Z",
  prepared_by: "FICTIONAL ADVANCE EXAMPLES",
};
await fs.mkdir("../output/pdf", { recursive: true });
await fs.mkdir("../tmp/pdfs", { recursive: true });
const assets = await loadTimesheetPdfAssets();
await fs.writeFile(
  "../output/pdf/The Gardens - Sample Partner Cash Advances.pdf",
  await createFinanceReportPdf(
    buildFinanceReport(source, options, true),
    assets,
  ),
);
finance.partner_cash!.advances[0].purpose =
  "Fictional long purpose for printed cash advance reporting and references. ".repeat(
    12,
  );
await fs.writeFile(
  "../tmp/pdfs/partner-cash-stress.pdf",
  await createFinanceReportPdf(
    buildFinanceReport(source, options, true),
    assets,
  ),
);
console.log(
  "Generated fictional cash-advance reports locally; no production records changed.",
);
