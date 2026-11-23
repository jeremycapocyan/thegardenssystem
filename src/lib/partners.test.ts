import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_DATA, type Dataset } from "./types";
import {
  parseRecoveryRate,
  recoveryAmount,
  previewPartnerSettlement,
  partnerDebtBalances,
} from "./partners";
import { applyPartnerDemo, guardPartnerManual } from "./partners-demo";
import { cashSummary, demoCash, type CashData } from "./balances";
import { settlements, installmentSummary, totals } from "./finance";
import { buildFinanceReport } from "./finance-report";
import { createFinanceReportPdf } from "./finance-report-pdf";
import { loadTimesheetPdfAssets } from "./timesheet-pdf-assets";
import { emptyRoi } from "./roi";
function fixture() {
  let data: Dataset = {
    ...structuredClone(EMPTY_DATA),
    categories: [
      { id: "income", name: "Court rental", kind: "income", active: true },
      { id: "expense", name: "Equipment", kind: "expense", active: true },
    ],
    income: [
      {
        id: "sale",
        business_date: "2026-11-01",
        category_id: "income",
        amount_cents: 1500000,
        notes: "",
      },
    ],
  };
  let cash: CashData = {
    ...demoCash(data),
    settings: { start_date: "2026-11-01", cash: 20000000, bank: 0, booking: 0 },
  };
  const command = (
    action: string,
    payload: Record<string, unknown>,
    id = crypto.randomUUID(),
  ) => {
    const next = applyPartnerDemo(
      data,
      cash,
      action,
      id,
      payload,
      "2026-12-01",
    );
    data = next.data;
    cash = next.balances;
    return { id, ...next.result };
  };
  const purchase = command("purchase", {
    owner: "Genesis",
    purchased_on: "2026-11-01",
    name: "Fictional Linix Sweeper",
    category_id: "expense",
    total_cents: 2500000,
    monthly_cents: 500000,
    first_due: "2026-11-30",
  }).id;
  const reimbursement = command("reimburse", {
    installment_id: purchase,
    paid_on: "2026-11-30",
    due_month: "2026-11-01",
    amount_cents: 500000,
    account: "cash",
    reference: "Fictional reimbursement",
  }).id;
  const funding = command("funding_draft", {
    supplier: "Fictional supplier",
    purpose: "Fictional capital purchase",
    total_cents: 11200000,
    start_month: "2026-11-01",
    partners: [
      { owner: "Genesis", amount_cents: 5600000, rate_bps: 5000 },
      { owner: "Ken", amount_cents: 5600000, rate_bps: 5000 },
    ],
  }).id;
  command("fund", {
    funding_id: funding,
    paid_on: "2026-11-05",
    account: "cash",
    reference: "Fictional supplier payment",
  });
  return {
    get data() {
      return data;
    },
    get cash() {
      return cash;
    },
    command,
    purchase,
    reimbursement,
    funding,
  };
}
test("recovery percentages validate precision, centavo rounding and large values", () => {
  assert.equal(parseRecoveryRate("0"), 0);
  assert.equal(parseRecoveryRate("33.33"), 3333);
  assert.equal(parseRecoveryRate("100.00"), 10000);
  for (const v of ["", "-1", "100.01", "1.001", "abc"])
    assert.throws(() => parseRecoveryRate(v));
  assert.equal(recoveryAmount(1, 5000), 1);
  assert.equal(recoveryAmount(1, 3333), 0);
  assert.equal(recoveryAmount(999999999999, 9999), 999899999999);
});
test("partner purchases, capital cash outflow and share withholding remain separate", () => {
  const f = fixture(),
    p = previewPartnerSettlement(f.data, "2026-11-01", "2026-12-01");
  assert.equal(totals(f.data, "2026-11-01", "2026-11-30").net, 1000000);
  assert.equal(cashSummary(f.cash, "2026-12-01").total, 8300000);
  assert.equal(
    installmentSummary(f.data, f.data.installments[0], "2026-12-01").remaining,
    2000000,
  );
  assert.deepEqual(
    p.owners.map((o) => o.withheld),
    [200000, 200000, 0],
  );
  const id = f.command("settle", {
    month: p.month,
    fingerprint: p.fingerprint,
  }).id;
  assert.equal(cashSummary(f.cash, "2026-12-01").total, 8300000);
  assert.equal(f.data.expenses.length, 1);
  assert.equal(f.data.payouts.length, 0);
  assert.deepEqual(
    partnerDebtBalances(f.data.partners!, "2026-12-01").map((d) => d.remaining),
    [5400000, 5400000],
  );
  assert.deepEqual(
    settlements(f.data, "2026-11-01", "2026-12-01").map((o) => o.balance),
    [200000, 200000, 200000],
  );
  f.command("reverse_settlement", {
    settlement_id: id,
    reason: "Fictional correction",
  });
  assert.deepEqual(
    partnerDebtBalances(f.data.partners!, "2026-12-01").map((d) => d.remaining),
    [5600000, 5600000],
  );
});
test("single per-owner recovery budget pays oldest funded debts and caps final recovery", () => {
  const f = fixture();
  f.command("void_funding", {
    funding_id: f.funding,
    reason: "Fictional replacement",
  });
  for (const [amount, paid_on] of [
    [10000, "2026-11-02"],
    [20000, "2026-11-03"],
  ] as const) {
    const id = f.command("funding_draft", {
      supplier: "Sample",
      purpose: "Older first",
      total_cents: amount * 2,
      start_month: "2026-11-01",
      partners: [
        { owner: "Genesis", amount_cents: amount, rate_bps: 5000 },
        { owner: "Ken", amount_cents: amount, rate_bps: 0 },
      ],
    }).id;
    f.command("fund", { funding_id: id, paid_on, account: "cash" });
  }
  const p = previewPartnerSettlement(f.data, "2026-11-01", "2026-12-01");
  assert.equal(p.owners[0].withheld, 30000);
  assert.deepEqual(
    p.owners[0].allocations.map((a) => a.amount_cents),
    [10000, 20000],
  );
  assert.equal(p.owners[0].payable, 370000);
});
test("prior payouts, losses, pausing, open months and manual edits are guarded", () => {
  const f = fixture();
  f.data.payouts.push({
    id: "prior",
    owner: "Genesis",
    settlement_month: "2026-11-01",
    paid_on: "2026-11-30",
    amount_cents: 300000,
    reference: "",
    notes: "",
  });
  let p = previewPartnerSettlement(f.data, "2026-11-01", "2026-12-01");
  assert.equal(p.owners[0].withheld, 100000);
  assert.equal(
    previewPartnerSettlement(f.data, "2026-11-01", "2026-11-24").can_post,
    false,
  );
  f.command("rule", {
    owner: "Genesis",
    effective_month: "2026-11-01",
    rate_bps: 0,
    reason: "Pause recovery",
  });
  p = previewPartnerSettlement(f.data, "2026-11-01", "2026-12-01");
  assert.equal(p.owners[0].withheld, 0);
  f.command("settle", { month: p.month, fingerprint: p.fingerprint });
  assert.throws(
    () =>
      guardPartnerManual(f.data, "payouts", {
        id: "new",
        owner: "Ken",
        settlement_month: "2026-11-01",
        amount_cents: 200001,
      }),
    /exceeds/,
  );
  assert.throws(
    () => guardPartnerManual(f.data, "expenses", { id: f.data.expenses[0].id }),
    /Partner advances/,
  );
  f.data.income[0].amount_cents = -100;
  const changed = previewPartnerSettlement(f.data, "2026-11-01", "2026-12-01");
  assert.equal(changed.needs_review, true);
  assert(changed.owners.every((o) => o.withheld === 0));
});
test("final reimbursement adjusts to the obligation and a correction retains history", () => {
  const f = fixture();
  for (let i = 0; i < 4; i++)
    f.command("reimburse", {
      installment_id: f.purchase,
      paid_on: "2026-12-01",
      due_month: "2026-12-01",
      amount_cents: 500000,
      account: "cash",
    });
  assert.equal(
    installmentSummary(f.data, f.data.installments[0], "2026-12-01").remaining,
    0,
  );
  assert.throws(
    () =>
      f.command("reimburse", {
        installment_id: f.purchase,
        paid_on: "2026-12-01",
        due_month: "2026-12-01",
        amount_cents: 1,
        account: "cash",
      }),
    /outstanding/,
  );
  f.command("void_reimbursement", {
    payment_id: f.reimbursement,
    reason: "Incorrect recording",
  });
  assert.equal(
    installmentSummary(f.data, f.data.installments[0], "2026-12-01").remaining,
    500000,
  );
  assert(f.data.partners!.payments[0].voided_at);
});
test("finance PDF shows both debt directions, frozen shares and separate capital cash movement", async () => {
  const f = fixture(),
    p = previewPartnerSettlement(f.data, "2026-11-01", "2026-12-01");
  f.command("settle", { month: p.month, fingerprint: p.fingerprint });
  f.data.income[0].amount_cents = 1000000;
  const report = buildFinanceReport(
    {
      finance: f.data,
      balances: f.cash,
      roi: emptyRoi(),
      generated_at: "2026-12-01T02:00:00Z",
      prepared_by: "Fictional partner test",
    },
    {
      start: "2026-11-01",
      end: "2026-11-30",
      asOf: "2026-12-01",
      period: "monthly",
    },
    true,
  );
  assert.equal(report.ownerMonths[0].net, 1000000);
  assert.equal(report.ownerMonths[0].currentNet, 500000);
  assert.equal(report.ownerMonths[0].owners[0].withheld, 200000);
  assert.equal(report.partnerCapitalOut, 11200000);
  assert.equal(report.afterCapitalAdvances, 500000 - 11200000);
  assert.equal(report.roi.invested, 0);
  assert(report.warnings.some((w) => w.includes("frozen net")));
  const bytes = await createFinanceReportPdf(
      report,
      await loadTimesheetPdfAssets(),
    ),
    { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs"),
    task = getDocument({ data: bytes.slice(), verbosity: 0 });
  try {
    const doc = await task.promise;
    let text = "";
    for (let i = 1; i <= doc.numPages; i++)
      text += (await (await doc.getPage(i)).getTextContent()).items
        .map((x) => ("str" in x ? x.str : ""))
        .join(" ");
    assert.match(text, /Gardens owes partners/);
    assert.match(text, /Capital amounts owed by partners/);
    assert.match(text, /₱112,000\.00/);
    assert.match(text, /₱54,000\.00/);
    assert.match(text, /Capital withheld/);
  } finally {
    await task.destroy();
  }
});
