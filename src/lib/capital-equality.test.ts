import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_DATA, type Dataset } from "./types";
import { emptyPartners, previewPartnerSettlement } from "./partners";
import {
  capitalPositions,
  previewCapitalEqualization,
} from "./capital-equality";
import { applyPartnerDemo } from "./partners-demo";
import { demoCash, type CashData } from "./balances";
const today = "2026-12-01";
const fixture = () => ({
  ...emptyPartners(),
  capital_contributions: [
    {
      id: "g",
      owner: "Genesis" as const,
      invested_on: "2026-11-01",
      amount_cents: 8000000,
    },
    {
      id: "k",
      owner: "Ken" as const,
      invested_on: "2026-11-01",
      amount_cents: 6000000,
    },
  ],
});
test("unequal recorded contributions produce unequal advances and equal total credited capital", () => {
  const p = fixture(),
    v = previewCapitalEqualization(p, 11200000, today);
  assert.equal(v.target_cents, 12600000);
  assert.deepEqual(
    v.allocations.map((a) => a.amount_cents),
    [4600000, 6600000],
  );
  assert.equal(p.capital_contributions[0].amount_cents, 8000000);
  assert.throws(
    () => previewCapitalEqualization(p, 1000000, today),
    /too small/,
  );
  assert.throws(
    () => previewCapitalEqualization(p, 11200001, today),
    /half a centavo/,
  );
  const gapOnly = previewCapitalEqualization(p, 2000000, today);
  assert.deepEqual(
    gapOnly.allocations.map((a) => a.amount_cents),
    [0, 2000000],
  );
});
test("funding changes credited capital once; share repayments never double-credit capital", () => {
  let data: Dataset = {
    ...structuredClone(EMPTY_DATA),
    partners: fixture(),
    categories: [
      { id: "inc", name: "Court rental", kind: "income", active: true },
    ],
    income: [
      {
        id: "income",
        business_date: "2026-11-01",
        category_id: "inc",
        amount_cents: 1000000,
        notes: "",
      },
    ],
  };
  let cash: CashData = {
    ...demoCash(data),
    settings: { start_date: "2026-11-01", cash: 20000000, bank: 0, booking: 0 },
  };
  const command = (
    a: string,
    p: Record<string, unknown>,
    id = crypto.randomUUID(),
  ) => {
    const next = applyPartnerDemo(data, cash, a, id, p, today);
    data = next.data;
    cash = next.balances;
    return id;
  };
  const v = previewCapitalEqualization(data.partners!, 11200000, today),
    base = {
      supplier: "Fictional supplier",
      purpose: "Equal capital example",
      total_cents: 11200000,
      start_month: "2026-11-01",
    };
  assert.throws(
    () =>
      command("funding_draft", {
        ...base,
        partners: [
          { owner: "Genesis", amount_cents: 5600000, rate_bps: 5000 },
          { owner: "Ken", amount_cents: 5600000, rate_bps: 5000 },
        ],
      }),
    /equalize/,
  );
  const draft = command("funding_draft", {
    ...base,
    equalize_capital: true,
    capital_fingerprint: v.fingerprint,
    partners: v.allocations.map((a) => ({ ...a, rate_bps: 5000 })),
  });
  assert.deepEqual(
    capitalPositions(data.partners!, today).map((p) => p.credited_cents),
    [8000000, 6000000],
  );
  command("fund", {
    funding_id: draft,
    paid_on: "2026-11-05",
    account: "cash",
  });
  assert.deepEqual(
    capitalPositions(data.partners!, today).map((p) => p.credited_cents),
    [12600000, 12600000],
  );
  const monthly = previewPartnerSettlement(data, "2026-11-01", today);
  command("settle", { month: monthly.month, fingerprint: monthly.fingerprint });
  const rows = capitalPositions(data.partners!, today);
  assert.deepEqual(
    rows.map((p) => p.credited_cents),
    [12600000, 12600000],
  );
  assert.deepEqual(
    rows.map((p) => p.outstanding_cents),
    [4400000, 6400000],
  );
  assert.deepEqual(
    rows.map((p) => p.personally_funded_cents),
    [8200000, 6200000],
  );
  assert.equal(data.partners!.capital_contributions!.length, 2);
  const next = previewCapitalEqualization(data.partners!, 11200000, today);
  assert.deepEqual(
    next.allocations.map((a) => a.amount_cents),
    [5600000, 5600000],
  );
});
test("changed contribution records invalidate drafts; voided funding is excluded from credited capital", () => {
  let data: Dataset = { ...structuredClone(EMPTY_DATA), partners: fixture() },
    cash: CashData = {
      ...demoCash(data),
      settings: {
        start_date: "2026-11-01",
        cash: 20000000,
        bank: 0,
        booking: 0,
      },
    };
  const v = previewCapitalEqualization(data.partners!, 11200000, today),
    id = crypto.randomUUID();
  let next = applyPartnerDemo(
    data,
    cash,
    "funding_draft",
    id,
    {
      supplier: "Sample",
      purpose: "Example",
      total_cents: 11200000,
      start_month: "2026-11-01",
      capital_fingerprint: v.fingerprint,
      partners: v.allocations.map((a) => ({ ...a, rate_bps: 5000 })),
    },
    today,
  );
  data = next.data;
  cash = next.balances;
  data.partners!.capital_contributions![1].amount_cents += 2000;
  assert.throws(
    () =>
      applyPartnerDemo(
        data,
        cash,
        "fund",
        crypto.randomUUID(),
        { funding_id: id, paid_on: "2026-11-05", account: "cash" },
        today,
      ),
    /Capital changed|equalize/,
  );
  data.partners!.capital_contributions![1].amount_cents -= 2000;
  next = applyPartnerDemo(
    data,
    cash,
    "fund",
    crypto.randomUUID(),
    { funding_id: id, paid_on: "2026-11-05", account: "cash" },
    today,
  );
  next = applyPartnerDemo(
    next.data,
    next.balances,
    "void_funding",
    crypto.randomUUID(),
    { funding_id: id, reason: "Fictional incorrect entry" },
    today,
  );
  assert.deepEqual(
    capitalPositions(next.data.partners!, today).map((p) => p.credited_cents),
    [8000000, 6000000],
  );
});
