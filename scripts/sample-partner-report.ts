import fs from "node:fs/promises";
import { EMPTY_DATA, type Dataset } from "../src/lib/types";
import { demoCash, type CashData } from "../src/lib/balances";
import { applyPartnerDemo } from "../src/lib/partners-demo";
import { previewPartnerSettlement, emptyPartners } from "../src/lib/partners";
import { previewCapitalEqualization } from "../src/lib/capital-equality";
import { buildFinanceReport } from "../src/lib/finance-report";
import { createFinanceReportPdf } from "../src/lib/finance-report-pdf";
import { loadTimesheetPdfAssets } from "../src/lib/timesheet-pdf-assets";
let finance: Dataset = {
  ...structuredClone(EMPTY_DATA),
  partners: {
    ...emptyPartners(),
    capital_contributions: [
      {
        id: "sample-capital-g",
        owner: "Genesis",
        invested_on: "2026-11-01",
        amount_cents: 8000000,
      },
      {
        id: "sample-capital-k",
        owner: "Ken",
        invested_on: "2026-11-01",
        amount_cents: 6000000,
      },
    ],
  },
  categories: [
    { id: "income", name: "Court rental", kind: "income", active: true },
    {
      id: "expense",
      name: "Equipment / maintenance",
      kind: "expense",
      active: true,
    },
  ],
  income: [
    {
      id: "sample-income",
      business_date: "2026-11-01",
      category_id: "income",
      amount_cents: 1500000,
      notes: "Fictional sample receipts",
    },
  ],
};
let cash: CashData = {
  ...demoCash(finance),
  settings: { start_date: "2026-11-01", cash: 20000000, bank: 0, booking: 0 },
};
const command = (action: string, payload: Record<string, unknown>) => {
  const id = crypto.randomUUID(),
    next = applyPartnerDemo(finance, cash, action, id, payload, "2026-12-01");
  finance = next.data;
  cash = next.balances;
  return id;
};
const purchase = command("purchase", {
  owner: "Genesis",
  purchased_on: "2026-11-01",
  name: "SAMPLE Linix Sweeper",
  category_id: "expense",
  total_cents: 2500000,
  monthly_cents: 500000,
  first_due: "2026-11-30",
});
command("reimburse", {
  installment_id: purchase,
  paid_on: "2026-11-30",
  due_month: "2026-11-01",
  amount_cents: 500000,
  account: "cash",
  reference: "SAMPLE REIMBURSEMENT",
});
const equalization = previewCapitalEqualization(
  finance.partners!,
  11200000,
  "2026-12-01",
);
const funding = command("funding_draft", {
  supplier: "SAMPLE Court Supplier",
  purpose: "Fictional capital purchase funded for Genesis and Ken",
  total_cents: 11200000,
  start_month: "2026-11-01",
  equalize_capital: true,
  capital_fingerprint: equalization.fingerprint,
  partners: equalization.allocations.map((a) => ({ ...a, rate_bps: 5000 })),
});
command("fund", {
  funding_id: funding,
  paid_on: "2026-11-05",
  account: "cash",
  reference: "SAMPLE SUPPLIER PAYMENT",
});
const preview = previewPartnerSettlement(finance, "2026-11-01", "2026-12-01");
command("settle", { month: preview.month, fingerprint: preview.fingerprint });
const source = {
    finance,
    balances: cash,
    roi: {
      capital: finance.partners!.capital_contributions!.map((c) => ({
        ...c,
        reference: "SAMPLE CAPITAL",
        notes: "Fictional recorded contribution",
      })),
      exclusions: [],
    },
    generated_at: "2026-12-01T02:00:00Z",
    prepared_by: "FICTIONAL PARTNER EXAMPLES",
  },
  options = {
    start: "2026-11-01",
    end: "2026-11-30",
    asOf: "2026-12-01",
    period: "monthly" as const,
  },
  assets = await loadTimesheetPdfAssets();
await fs.mkdir("../output/pdf", { recursive: true });
await fs.mkdir("../tmp/pdfs", { recursive: true });
await fs.writeFile(
  "../output/pdf/The Gardens - Sample Partner Advances.pdf",
  await createFinanceReportPdf(
    buildFinanceReport(source, options, true),
    assets,
  ),
);
finance.partners!.fundings[0].purpose =
  "Fictional long capital-purpose description ₱112,000.00, with linked capital allocation and a long supplier reference. ".repeat(
    8,
  );
await fs.writeFile(
  "../tmp/pdfs/partner-stress.pdf",
  await createFinanceReportPdf(
    buildFinanceReport(source, options, true),
    assets,
  ),
);
console.log(
  "Generated fictional partner PDFs locally. No database changes or bank transfers.",
);
