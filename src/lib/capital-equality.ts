import type { Owner } from "./types";
import type { PartnerData } from "./partners";
import { partnerDebtBalances } from "./partners";
export const CAPITAL_PARTNERS = ["Genesis", "Ken"] as const;
export interface CapitalContribution {
  id: string;
  owner: Owner;
  invested_on: string;
  amount_cents: number;
}
export interface CapitalPosition {
  owner: "Genesis" | "Ken";
  recorded_cents: number;
  gardens_funded_cents: number;
  repaid_cents: number;
  personally_funded_cents: number;
  outstanding_cents: number;
  credited_cents: number;
}
export interface CapitalEqualization {
  total_cents: number;
  target_cents: number;
  positions: CapitalPosition[];
  allocations: { owner: "Genesis" | "Ken"; amount_cents: number }[];
  fingerprint: string;
}
export function capitalPositions(
  data: PartnerData,
  asOf: string,
): CapitalPosition[] {
  const debts = partnerDebtBalances(data, asOf);
  return CAPITAL_PARTNERS.map((owner) => {
    const recorded_cents = (data.capital_contributions || [])
      .filter((c) => c.owner === owner && c.invested_on <= asOf)
      .reduce((n, c) => n + c.amount_cents, 0);
    const funded = debts.filter(
      (d) =>
        d.owner === owner &&
        d.funding.state === "funded" &&
        d.funding.funded_on! <= asOf,
    );
    const gardens_funded_cents = funded.reduce((n, d) => n + d.amount_cents, 0),
      repaid_cents = funded.reduce((n, d) => n + d.recovered, 0);
    return {
      owner,
      recorded_cents,
      gardens_funded_cents,
      repaid_cents,
      personally_funded_cents: recorded_cents + repaid_cents,
      outstanding_cents: gardens_funded_cents - repaid_cents,
      credited_cents: recorded_cents + gardens_funded_cents,
    };
  });
}
export function previewCapitalEqualization(
  data: PartnerData,
  total: number,
  today: string,
): CapitalEqualization {
  if (!Number.isSafeInteger(total) || total <= 0 || total > 999999999999)
    throw Error(
      "Enter a positive capital payment within the supported amount.",
    );
  const positions = capitalPositions(data, today),
    combined = positions.reduce(
      (n, p) => n + BigInt(p.credited_cents),
      BigInt(total),
    );
  if (combined % 2n !== 0n)
    throw Error(
      "This total would require half a centavo. Review the actual payment or record a genuine capital correction before equalizing.",
    );
  const target = Number(combined / 2n),
    allocations = positions.map((p) => ({
      owner: p.owner,
      amount_cents: target - p.credited_cents,
    }));
  if (
    !Number.isSafeInteger(target) ||
    allocations.some((a) => a.amount_cents < 0)
  )
    throw Error(
      "This payment is too small to equalize total capital. It must cover the current capital difference.",
    );
  const source = JSON.stringify([
    (data.capital_contributions || [])
      .filter((c) => c.invested_on <= today)
      .map((c) => [c.id, c.owner, c.invested_on, c.amount_cents])
      .sort(),
    data.debts
      .filter((d) =>
        data.fundings.some(
          (f) =>
            f.id === d.funding_id &&
            f.state === "funded" &&
            f.funded_on! <= today,
        ),
      )
      .map((d) => [d.id, d.funding_id, d.owner, d.amount_cents])
      .sort(),
  ]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++)
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  return {
    total_cents: total,
    target_cents: target,
    positions,
    allocations,
    fingerprint: (hash >>> 0).toString(16) + "-" + source.length,
  };
}
export function checkCapitalAllocations(
  data: PartnerData,
  total: number,
  partners: { owner: string; amount_cents: number }[],
  today: string,
) {
  if (!partners.some((p) => p.owner === "Genesis" || p.owner === "Ken"))
    return null;
  const preview = previewCapitalEqualization(data, total, today),
    expected = preview.allocations.filter((a) => a.amount_cents > 0);
  if (
    partners.length !== expected.length ||
    partners.some(
      (p) =>
        !expected.some(
          (a) => a.owner === p.owner && a.amount_cents === p.amount_cents,
        ),
    )
  )
    throw Error(
      "Allocations must equalize Genesis and Ken’s total credited capital. Calculate the equal capital preview again.",
    );
  return preview;
}
