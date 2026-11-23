import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import fs from "node:fs/promises";
import { parseOndaPdf } from "./onda-pdf";
import { buildOndaPreview, resolvedOndaAmount, type OndaContext } from "./onda";
import { fixturePdf, report, refund, tx } from "../../scripts/onda-fixtures";
import { parseIncomeMoney } from "./finance";
import { cashSummary, demoCash } from "./balances";
import { EMPTY_DATA } from "./types";
const context = (): OndaContext => ({
  fingerprint: "sample",
  income: [],
  categories: [
    { id: "court", name: "Court rental", kind: "income", active: true },
    { id: "open", name: "Open play", kind: "income", active: true },
  ],
  expenses: [],
  allocations: [],
  transactions: [],
  refunds: [],
  days: [],
  links: [],
});
test("PDF.js reads a sanitized multipage Onda export with excluded rows and a cash return", async () => {
  const rows = [
    tx("BK-AAA111", "2020-11-01", 90000),
    tx("ER-AAA222", "2020-11-01", 25000, {
      method: "Cash",
      gross: 25000,
      fee: 0,
    }),
    tx("BK-CANCEL3", "2020-11-02", 80000, {
      status: "Cancelled",
      method: "Original Paym...",
      fee: 0,
      gross: 80000,
    }),
    tx("ER-ZERO444", "2020-11-03", 0, {
      method: "Complimentary",
      fee: 0,
      gross: 0,
    }),
    tx("ER-AAA555", "2020-11-04", 50000),
  ];
  const r = report(rows, [refund("ER-AAA222", "2020-11-05", 25000)]),
    parsed = await parseOndaPdf(await fixturePdf(r, { extraPayout: true }));
  assert.equal(parsed.net, 140000);
  assert.equal(parsed.rows, 7);
  assert.equal(parsed.refunds.length, 1);
  assert.equal(parsed.excluded.length, 3);
  assert.equal(parsed.generatedAt, r.generatedAt);
});
test("reject wrong venues, totals, duplicate/missing pages, damaged and scanned PDFs", async () => {
  const r = report(
    Array.from({ length: 7 }, (_, i) => tx("BK-CASE" + i, "2020-11-01", 30000)),
  );
  await assert.rejects(
    parseOndaPdf(await fixturePdf(r, { venue: "Another venue" })),
    /venue/,
  );
  await assert.rejects(
    parseOndaPdf(await fixturePdf(r, { summaryNet: 1 })),
    /summary totals/,
  );
  await assert.rejects(
    parseOndaPdf(await fixturePdf(r, { duplicatePage: true })),
    /pages/,
  );
  const damaged = await fixturePdf(r);
  await assert.rejects(
    parseOndaPdf(damaged.slice(0, 50)),
    /damaged|incomplete/,
  );
  const blank = await PDFDocument.create();
  blank.addPage();
  await assert.rejects(parseOndaPdf(await blank.save()), /Scanned/);
  await assert.rejects(parseOndaPdf(new Uint8Array(4000001)), /4 MB/);
  for (const name of ["onda-encrypted", "onda-password"]) {
    await assert.rejects(
      parseOndaPdf(
        new Uint8Array(await fs.readFile(`scripts/fixtures/${name}.pdf`)),
      ),
      /Encrypted|Password-protected/,
    );
  }
  const tooMany = await PDFDocument.create();
  for (let i = 0; i < 101; i++) tooMany.addPage();
  await assert.rejects(parseOndaPdf(await tooMany.save()), /100 pages/);
});
test("overlapping imports reconcile references; older and identical exports do not inflate income", () => {
  const c = context(),
    first = report([tx("BK-PAID01", "2020-11-01", 90000)]),
    p = buildOndaPreview(first, c);
  assert.equal(p.proposals[0].source_amount, 90000);
  c.transactions = p.transactions;
  c.days = p.days;
  c.income = [
    {
      id: "income",
      business_date: "2020-11-01",
      category_id: "court",
      amount_cents: 90000,
      notes: p.proposals[0].notes,
    },
  ];
  c.links = [
    {
      business_date: "2020-11-01",
      category_id: "court",
      income_id: "income",
      source_amount: 90000,
      manual_amount: 0,
      last_amount: 90000,
      last_notes: p.proposals[0].notes,
      generated_notes: p.proposals[0].generated_notes,
    },
  ];
  assert.equal(buildOndaPreview(first, c).change, 0);
  const newer = report(
      [...first.transactions, tx("BK-PAID02", "2020-11-01", 30000)],
      [],
      { generatedAt: "2020-11-07T04:00:00.000Z" },
    ),
    newPlan = buildOndaPreview(newer, c);
  assert.equal(newPlan.change, 30000);
  c.transactions = newPlan.transactions;
  c.days = newPlan.days;
  assert.equal(buildOndaPreview(first, c).olderIgnored, 1);
  assert.equal(buildOndaPreview(first, c).proposals.length, 0);
});
test("manual amounts need explicit reconciliation; note preservation and allocation caps remain intact", () => {
  const c = context();
  c.income = [
    {
      id: "manual",
      business_date: "2020-11-01",
      category_id: "court",
      amount_cents: 100000,
      notes: "Manual highlight",
    },
  ];
  const p = buildOndaPreview(report([tx("BK-TEST01", "2020-11-01", 90000)]), c)
    .proposals[0];
  assert(p.conflict);
  assert.equal(p.notes, "Manual highlight");
  assert.throws(() => resolvedOndaAmount(p), /Resolve/);
  assert.equal(resolvedOndaAmount(p, { mode: "replace" }), 90000);
  assert.equal(
    resolvedOndaAmount(p, { mode: "manual", amount_cents: 10000 }),
    100000,
  );
  assert.throws(
    () => resolvedOndaAmount({ ...p, allocated: 95000 }, { mode: "replace" }),
    /account assignments/,
  );
});
test("missing paid references, changed refund identities, duplicate expense refunds and over-refunds block imports", () => {
  const c = context(),
    r = report(
      [tx("ER-OLD001", "2020-11-01", 50000)],
      [refund("ER-OLD001", "2020-11-02", 10000)],
    ),
    p = buildOndaPreview(r, c);
  c.transactions = p.transactions;
  c.refunds = p.refunds;
  c.days = p.days;
  const next = report([], [], { generatedAt: "2020-11-08T00:00:00.000Z" });
  assert(buildOndaPreview(next, c).blockers.length >= 2);
  const excess = report(
    r.transactions,
    [refund("ER-OLD001", "2020-11-02", 60000)],
    { generatedAt: "2020-11-08T00:00:00.000Z" },
  );
  assert(
    buildOndaPreview(excess, c).blockers.some((b) => b.includes("exceed")),
  );
  const other = context();
  other.expenses = [
    {
      id: "expense",
      paid_on: "2020-11-02",
      category_id: "exp",
      payment_kind: "operating",
      fixed_bill_id: null,
      installment_id: null,
      due_month: null,
      amount_cents: 10000,
      reference: "ER-OLD001",
      notes: "Customer refund",
    },
  ];
  assert(
    buildOndaPreview(r, other).blockers.some((b) =>
      b.includes("expense already"),
    ),
  );
});
test("refund-only dates produce signed income and separate unassigned refund warnings", () => {
  const r = report([], [refund("ER-OLD001", "2020-11-02", 25000)]),
    p = buildOndaPreview(r, context());
  assert.equal(p.proposals[0].source_amount, -25000);
  assert.equal(parseIncomeMoney("-250.00"), -25000);
  const cash = demoCash({
    ...EMPTY_DATA,
    income: [
      {
        id: "refund",
        business_date: "2020-11-02",
        category_id: "open",
        amount_cents: -25000,
        notes: "Refund",
      },
    ],
  });
  cash.settings = { start_date: "2020-11-01", cash: 0, bank: 0, booking: 0 };
  const totals = cashSummary(cash, "2020-11-03");
  assert.equal(totals.unassignedIn, 0);
  assert.equal(totals.unassignedRefunds, 25000);
  assert.equal(totals.total, 0);
});

test("newer cancellations remove revenue; identical generation times cannot conceal changes", () => {
  const c = context(),
    original = report([tx("BK-CANCEL1", "2020-11-01", 90000)]);
  const first = buildOndaPreview(original, c);
  c.transactions = first.transactions.map((v) => ({
    ...v,
    generated_at: "2020-11-06T04:00:00+00:00",
  }));
  c.days = first.days;
  assert.equal(buildOndaPreview(original, c).blockers.length, 0);
  const changed = report([tx("BK-CANCEL1", "2020-11-01", 80000)]);
  assert(
    buildOndaPreview(changed, c).blockers.some((b) =>
      b.includes("same generation time"),
    ),
  );
  c.income = [
    {
      id: "stable",
      business_date: "2020-11-01",
      category_id: "court",
      amount_cents: 90000,
      notes: first.proposals[0].notes,
    },
  ];
  c.links = [
    {
      business_date: "2020-11-01",
      category_id: "court",
      income_id: "stable",
      source_amount: 90000,
      manual_amount: 0,
      last_amount: 90000,
      last_notes: first.proposals[0].notes,
      generated_notes: first.proposals[0].generated_notes,
    },
  ];
  const cancelled = buildOndaPreview(
    report([{ ...original.transactions[0], status: "Cancelled" }], [], {
      generatedAt: "2020-11-07T04:00:00.000Z",
    }),
    c,
  );
  assert.equal(cancelled.blockers.length, 0);
  assert.equal(cancelled.change, -90000);
  assert.equal(cancelled.proposals[0].income_id, "stable");
  assert.equal(cancelled.proposals[0].source_amount, 0);
});

test("identical cash returns retain occurrence identities across regenerated exports", async () => {
  const r = report(
    [tx("ER-RETURN1", "2020-11-01", 50000)],
    [
      refund("ER-RETURN1", "2020-11-02", 5000),
      refund("ER-RETURN1", "2020-11-02", 5000, 2),
    ],
  );
  const parsed = await parseOndaPdf(await fixturePdf(r));
  assert.deepEqual(
    parsed.refunds.map((x) => x.occurrence),
    [1, 2],
  );
  const c = context(),
    p = buildOndaPreview(parsed, c);
  c.transactions = p.transactions;
  c.refunds = p.refunds;
  c.days = p.days;
  const next = buildOndaPreview(
    { ...parsed, generatedAt: "2020-11-07T04:00:00.000Z" },
    c,
  );
  assert.equal(next.blockers.length, 0);
  assert.equal(
    next.proposals.find((x) => x.date === "2020-11-02")!.source_amount,
    -10000,
  );
  const missing = buildOndaPreview(
    report(r.transactions, [r.refunds[0]], {
      generatedAt: "2020-11-08T04:00:00.000Z",
    }),
    c,
  );
  assert(missing.blockers.some((x) => x.includes("missing or changed")));
});

test("non-QRPH payments are not mislabeled in income highlights", () => {
  const p = buildOndaPreview(
    report([tx("BK-CARD01", "2020-11-01", 90000, { method: "Card" })]),
    context(),
  );
  assert.match(p.proposals[0].generated_notes, /Other methods/);
  assert(!p.proposals[0].generated_notes.includes("QRPH"));
});
