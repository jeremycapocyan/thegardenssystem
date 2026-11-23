import { monthStart, monthEnd, ownerShares, totals } from "./finance";
import { OWNERS, type Dataset, type Owner } from "./types";

export interface PartnerPurchase {
  id: string;
  owner: Owner;
  purchased_on: string;
  created_at?: string;
}
export interface PartnerPayment {
  id: string;
  installment_id: string;
  expense_id: string | null;
  allocation_id: string | null;
  detail: {
    paid_on: string;
    amount_cents: number;
    account: string;
    reference: string;
  };
  voided_at: string | null;
  void_reason?: string;
  created_at?: string;
}
export interface PartnerFunding {
  id: string;
  supplier: string;
  purpose: string;
  total_cents: number;
  start_month: string;
  state: "draft" | "funded" | "void";
  funded_on: string | null;
  movement_id: string | null;
  funding_detail?: { account: string; reference: string };
  void_reason?: string;
  created_at?: string;
}
export interface PartnerDebt {
  id: string;
  funding_id: string;
  owner: Owner;
  amount_cents: number;
}
export interface PartnerRule {
  id: string;
  owner: Owner;
  effective_month: string;
  rate_bps: number;
  reason: string;
}
export interface OwnerRecovery {
  id: string;
  settlement_id: string;
  debt_id: string;
  owner: Owner;
  amount_cents: number;
  effective_on: string;
}
export interface PartnerOwnerPreview {
  owner: Owner;
  entitlement: number;
  paid: number;
  rate_bps: number | null;
  withheld: number;
  payable: number;
  debt_before: number;
  debt_after: number;
  allocations: { debt_id: string; amount_cents: number }[];
}
export interface PartnerPreview {
  month: string;
  net_cents: number;
  owners: PartnerOwnerPreview[];
  fingerprint: string;
  profit_hash: string;
  blockers: string[];
  can_post: boolean;
  active_settlement: OwnerSettlement | null;
  needs_review: boolean;
}
export interface OwnerSettlement {
  needs_review?:boolean;
  id: string;
  month: string;
  net_cents: number;
  profit_hash: string;
  snapshot: PartnerPreview;
  confirmed_at: string;
  confirmed_by?: string;
  reversed_at: string | null;
  reversal_reason?: string;
}
export interface PartnerData {
  purchases: PartnerPurchase[];
  payments: PartnerPayment[];
  fundings: PartnerFunding[];
  debts: PartnerDebt[];
  rules: PartnerRule[];
  settlements: OwnerSettlement[];
  recoveries: OwnerRecovery[];
}
export const emptyPartners = (): PartnerData => ({
  purchases: [],
  payments: [],
  fundings: [],
  debts: [],
  rules: [],
  settlements: [],
  recoveries: [],
});
export function parseRecoveryRate(value: string) {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value.trim()))
    throw Error(
      "Enter a percentage from 0 to 100, with up to two decimal places.",
    );
  const [whole, fraction = ""] = value.trim().split(".");
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (bps > 10000) throw Error("Recovery percentage cannot exceed 100%.");
  return bps;
}
export function recoveryAmount(entitlement: number, rateBps: number) {
  return Number((BigInt(entitlement) * BigInt(rateBps) + 5000n) / 10000n);
}
export function partnerDebtBalances(data: PartnerData, asOf: string) {
  return data.debts.map((d) => {
    const funding = data.fundings.find((f) => f.id === d.funding_id)!;
    const recovered = data.recoveries
      .filter(
        (r) =>
          r.debt_id === d.id &&
          r.effective_on <= asOf &&
          data.settlements.some(
            (s) => s.id === r.settlement_id && !s.reversed_at,
          ),
      )
      .reduce((n, r) => n + r.amount_cents, 0);
    const active =
      funding?.state === "funded" &&
      !!funding.funded_on &&
      funding.funded_on <= asOf;
    return {
      ...d,
      funding,
      recovered: active ? recovered : 0,
      remaining: active ? Math.max(0, d.amount_cents - recovered) : 0,
    };
  });
}
export const activeOwnerSettlement = (data: Dataset, month: string) =>
  data.partners?.settlements.find(
    (s) => s.month === monthStart(month) && !s.reversed_at,
  );
function sampleFingerprint(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16) + "-" + value.length;
}
export function partnerProfitKey(data: Dataset, month: string) {
  const start = monthStart(month),
    end = monthEnd(month);
  return sampleFingerprint(
    JSON.stringify([
      data.income
        .filter((i) => i.business_date >= start && i.business_date <= end)
        .map((i) => [i.id, i.business_date, i.amount_cents])
        .sort(),
      data.expenses
        .filter((e) => e.paid_on >= start && e.paid_on <= end)
        .map((e) => [e.id, e.paid_on, e.amount_cents])
        .sort(),
    ]),
  );
}
/** Browser-only estimates for isolated samples. Production uses the transactional SQL preview. */
export function previewPartnerSettlement(
  data: Dataset,
  month: string,
  today: string,
): PartnerPreview {
  if (
    month !== monthStart(month) ||
    month <= "1999-12-31" ||
    month > monthStart(today)
  )
    throw Error("Choose a current or past calendar month.");
  const p = data.partners || emptyPartners(),
    net = totals(data, monthStart(month), monthEnd(month)).net,
    shares = ownerShares(net),
    blockers: string[] = [];
  const debtBalances = partnerDebtBalances(p, "2100-12-31")
    .filter(
      (d) =>
        d.funding?.start_month <= month &&
        d.funding.funded_on! <= monthEnd(month),
    )
    .sort((a, b) =>
      (
        a.funding.funded_on! +
        (a.funding.created_at || "") +
        a.funding.id +
        a.id
      ).localeCompare(
        b.funding.funded_on! +
          (b.funding.created_at || "") +
          b.funding.id +
          b.id,
      ),
    );
  const owners = OWNERS.map((owner) => {
    const entitlement = shares[owner],
      paid = data.payouts
        .filter((v) => v.owner === owner && v.settlement_month === month)
        .reduce((n, v) => n + v.amount_cents, 0),
      rule = p.rules
        .filter((r) => r.owner === owner && r.effective_month <= month)
        .sort((a, b) => b.effective_month.localeCompare(a.effective_month))[0];
    let budget = Math.min(
      Math.max(0, entitlement - paid),
      recoveryAmount(entitlement, rule?.rate_bps || 0),
    );
    const debts = debtBalances.filter((d) => d.owner === owner),
      debt_before = debts.reduce((n, d) => n + d.remaining, 0),
      allocations: PartnerOwnerPreview["allocations"] = [];
    if (debt_before > 0 && !rule)
      blockers.push(`Set a recovery rate for ${owner}.`);
    for (const d of debts) {
      const amount_cents = Math.min(d.remaining, budget);
      if (amount_cents > 0) {
        allocations.push({ debt_id: d.id, amount_cents });
        budget -= amount_cents;
      }
    }
    const withheld = allocations.reduce((n, r) => n + r.amount_cents, 0);
    return {
      owner,
      entitlement,
      paid,
      rate_bps: rule?.rate_bps ?? null,
      withheld,
      payable: entitlement - paid - withheld,
      debt_before,
      debt_after: debt_before - withheld,
      allocations,
    };
  });
  const active = activeOwnerSettlement(data, month) || null,
    profit_hash = partnerProfitKey(data, month);
  return {
    month,
    net_cents: net,
    owners,
    profit_hash,
    fingerprint: sampleFingerprint(
      JSON.stringify([
        profit_hash,
        p,
        data.payouts.filter((v) => v.settlement_month === month),
      ]),
    ),
    blockers,
    active_settlement: active,
    can_post: month < monthStart(today) && !active && !blockers.length,
    needs_review: !!active && active.profit_hash !== profit_hash,
  };
}
