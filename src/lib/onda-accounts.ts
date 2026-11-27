import {
  buildOndaPreview,
  ondaCategory,
  type OndaContext,
  type OndaPreview,
} from "./onda";
import type { CashAccount, CashAllocation, CashSettings } from "./balances";

export interface OndaEntryLink {
  key: string;
  income_id: string;
  allocation_id: string | null;
  account: CashAccount;
  method: string;
  last_amount: number;
  last_notes: string;
}
export interface OndaAccountContext extends OndaContext {
  entries?: OndaEntryLink[];
  settings?: CashSettings | null;
}
export interface OndaAccountEntry {
  key: string;
  reference: string;
  date: string;
  category_id: string;
  kind: "BK" | "ER";
  method: string;
  amount_cents: number;
  notes: string;
  account: CashAccount | null;
  income_id: string | null;
  before_opening: boolean;
}
export interface OndaAccountPreview extends OndaPreview {
  encoding_version: 2;
  entries: OndaAccountEntry[];
  opening_date: string | null;
  replaced_allocations: number;
}
export function buildOndaAccountPreview(
  report: OndaPreview["report"],
  ctx: OndaAccountContext,
): OndaAccountPreview {
  const managed = new Set((ctx.entries || []).map((e) => e.income_id));
  const income = ctx.income
    .filter((i) => !managed.has(i.id))
    .map((i) => {
      const link = ctx.links.find((l) => l.income_id === i.id);
      return link &&
        (i as typeof i & { onda_hidden?: boolean; onda_split?: boolean })
          .onda_split
        ? { ...i, amount_cents: i.amount_cents + link.source_amount }
        : i;
    });
  const base = buildOndaPreview(report, { ...ctx, income, allocations: [] });
  const transactions = new Map(
    ctx.transactions.map((t) => [t.data.reference, t.data]),
  );
  const refunds = new Map(ctx.refunds.map((r) => [r.data.identity, r.data]));
  for (const t of base.transactions) transactions.set(t.data.reference, t.data);
  for (const r of base.refunds) refunds.set(r.data.identity, r.data);
  const entries: OndaAccountEntry[] = [];
  const add = (
    key: string,
    reference: string,
    date: string,
    kind: "BK" | "ER",
    method: string,
    amount_cents: number,
    notes: string,
  ) => {
    const proposal = base.proposals.find(
      (p) => p.date === date && p.kind === kind,
    );
    if (!proposal) return;
    const old = ctx.entries?.find((e) => e.key === key);
    const current = old && ctx.income.find((i) => i.id === old.income_id);
    if (
      old &&
      (!current ||
        current.amount_cents !== old.last_amount ||
        current.notes !== old.last_notes)
    )
      base.blockers.push(
        `${reference}: the imported entry changed. Review it before importing.`,
      );
    entries.push({
      key,
      reference,
      date,
      kind,
      method,
      amount_cents,
      notes,
      category_id: proposal.category_id,
      account:
        amount_cents === 0 && old
          ? old.account
          : old?.method === method
            ? old.account
            : method === "Cash"
              ? "cash"
              : method === "QRPH"
                ? "booking"
                : null,
      income_id: old?.income_id || null,
      before_opening: !!ctx.settings && date < ctx.settings.start_date,
    });
  };
  for (const t of transactions.values()) {
    const amount = t.status === "Paid" ? t.net : 0;
    if (!amount && !ctx.entries?.some((e) => e.key === `tx:${t.reference}`))
      continue;
    add(
      `tx:${t.reference}`,
      t.reference,
      t.date,
      t.kind,
      t.method,
      amount,
      `${ondaCategory(t.kind)} · ${t.reference} · ${t.method}${t.fee ? " · Onda fee included" : ""}${!amount ? ` · ${t.status}` : ""}`,
    );
  }
  for (const r of refunds.values())
    add(
      `refund:${r.identity}`,
      r.reference,
      r.date,
      r.kind,
      "Cash",
      -r.amount,
      `Cash return · ${r.reference}`,
    );
  if (!ctx.settings)
    base.blockers.push(
      "Set opening balances in Cash & balances before importing automatic account entries.",
    );
  const changedParents = new Set(
    base.proposals.map((p) => p.income_id).filter(Boolean),
  );
  return {
    ...base,
    encoding_version: 2,
    entries: entries.sort(
      (a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key),
    ),
    opening_date: ctx.settings?.start_date || null,
    replaced_allocations: ctx.allocations.filter((a) =>
      changedParents.has(a.income_id),
    ).length,
  };
}
export function ondaEntryAccount(
  e: OndaAccountEntry,
  overrides: Record<string, CashAccount> = {},
) {
  const account = overrides[e.key] || e.account;
  if (!account || !["cash", "bank", "booking"].includes(account))
    throw Error(`Choose an account for ${e.reference}.`);
  return account;
}

export function applyOndaAccountRows(
  income: OndaContext["income"],
  allocations: CashAllocation[],
  old: OndaEntryLink[],
  plan: OndaAccountPreview,
  accounts: Record<string, CashAccount>,
  manualAmounts: Record<string, number>,
) {
  let next = allocations.slice();
  const links = old.slice();
  for (const proposal of plan.proposals) {
    const row = income.find(
      (i) =>
        i.business_date === proposal.date &&
        i.category_id === proposal.category_id &&
        !i.onda_key,
    );
    if (!row) throw Error("Daily reconciliation row missing.");
    const manual = manualAmounts[proposal.key] || 0;
    row.amount_cents = manual;
    row.onda_split = true;
    row.onda_hidden = manual === 0;
    next = next.filter((a) => a.income_id !== row.id);
    if (manual && proposal.date >= plan.opening_date!) {
      const account = accounts[`manual:${proposal.key}`];
      if (!account) throw Error("Choose the account for income outside Onda.");
      if (manual < 0)
        throw Error("Keep negative non-Onda corrections separate.");
      next.push({
        id: crypto.randomUUID(),
        income_id: row.id,
        expense_id: null,
        payout_id: null,
        posted_on: proposal.date,
        amount_cents: manual,
        account,
      });
    }
  }
  for (const e of plan.entries) {
    const oldLink = links.find((l) => l.key === e.key),
      id = oldLink?.income_id || crypto.randomUUID(),
      allocation = oldLink?.allocation_id || crypto.randomUUID(),
      account = ondaEntryAccount(e, accounts);
    const row = {
      id,
      business_date: e.date,
      category_id: e.category_id,
      amount_cents: e.amount_cents,
      notes: e.notes,
      onda_key: e.key,
      onda_reference: e.reference,
      payment_method: e.method,
      payment_account: account,
      onda_hidden: e.amount_cents === 0,
    };
    const index = income.findIndex((i) => i.id === id);
    if (index < 0) income.push(row);
    else income[index] = row;
    next = next.filter((a) => a.income_id !== id);
    const posted = !!e.amount_cents && !e.before_opening;
    if (posted)
      next.push({
        id: allocation,
        account,
        income_id: id,
        expense_id: null,
        payout_id: null,
        posted_on: e.date,
        amount_cents: e.amount_cents,
        onda_key: e.key,
      });
    const link = {
      key: e.key,
      income_id: id,
      allocation_id: posted ? allocation : null,
      account,
      method: e.method,
      last_amount: e.amount_cents,
      last_notes: e.notes,
    };
    const n = links.findIndex((l) => l.key === e.key);
    if (n < 0) links.push(link);
    else links[n] = link;
  }
  return { allocations: next, entries: links };
}
