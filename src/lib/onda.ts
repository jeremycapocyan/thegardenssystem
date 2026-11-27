import { money } from "./finance";
import type { Income, Category, Expense } from "./types";
export const ONDA_MAX_BYTES = 4_000_000;
export type OndaKind = "BK" | "ER";
export interface OndaTransaction {
  reference: string;
  kind: OndaKind;
  date: string;
  status: string;
  gross: number;
  fee: number;
  net: number;
  method: string;
}
export interface OndaRefund {
  identity: string;
  reference: string;
  kind: OndaKind;
  date: string;
  amount: number;
  occurrence: number;
}
export interface OndaReport {
  version: 1;
  start: string;
  end: string;
  generatedAt: string;
  rows: number;
  transactionCount: number;
  gross: number;
  fees: number;
  cashReturned: number;
  net: number;
  transactions: OndaTransaction[];
  refunds: OndaRefund[];
  excluded: { reference: string; reason: string }[];
}
export interface OndaVersion<T> {
  data: T;
  generated_at: string;
  import_id?: string;
}
export interface OndaLink {
  business_date: string;
  category_id: string;
  income_id: string | null;
  source_amount: number;
  manual_amount: number;
  last_amount: number;
  last_notes: string;
  generated_notes: string;
}
export interface OndaContext {
  entries?: import("./onda-accounts").OndaEntryLink[];
  settings?: import("./balances").CashSettings | null;
  fingerprint: string;
  income: Income[];
  categories: Category[];
  expenses: Expense[];
  allocations: { income_id: string; amount_cents: number }[];
  transactions: OndaVersion<OndaTransaction>[];
  refunds: OndaVersion<OndaRefund>[];
  days: { day: string; kind: OndaKind; generated_at: string }[];
  links: OndaLink[];
}
export interface OndaProposal {
  key: string;
  date: string;
  kind: OndaKind;
  category_id: string;
  income_id: string | null;
  old_amount: number | null;
  old_notes: string;
  source_amount: number;
  manual_amount: number;
  notes: string;
  generated_notes: string;
  conflict: boolean;
  status: "new" | "updated" | "unchanged" | "conflict";
  allocated: number;
}
export interface OndaPreview {
  encoding_version?: 2;
  entries?: import("./onda-accounts").OndaAccountEntry[];
  opening_date?: string | null;
  replaced_allocations?: number;
  report: OndaReport;
  proposals: OndaProposal[];
  blockers: string[];
  warnings: string[];
  transactions: OndaVersion<OndaTransaction>[];
  refunds: OndaVersion<OndaRefund>[];
  days: { day: string; kind: OndaKind; generated_at: string }[];
  olderIgnored: number;
  change: number;
}
export interface OndaResolution {
  mode: "replace" | "manual";
  amount_cents?: number;
  replace_notes?: boolean;
}
export const ondaCategory = (kind: OndaKind) =>
  kind === "BK" ? "Court rental" : "Open play";
export const ondaContribution = (t: OndaTransaction) =>
  t.status === "Paid" ? t.net : 0;
export function ondaNotes(
  kind: OndaKind,
  count: number,
  cash: number,
  qrph: number,
  returned: number,
  other = 0,
) {
  const label =
    kind === "BK"
      ? `court booking${count === 1 ? "" : "s"}`
      : `open play payment${count === 1 ? "" : "s"}`;
  const payment = [
    cash ? `Cash ${money(cash)}` : "",
    qrph ? `QRPH ${money(qrph)}` : "",
    other ? `Other methods ${money(other)}` : "",
  ]
    .filter(Boolean)
    .join(" + ");
  return `${count} ${label}${payment ? `; ${payment} net` : ""}.${returned ? ` Cash returned ${money(returned)} included.` : ""}`;
}
const canonical = (a: unknown): unknown =>
  Array.isArray(a)
    ? a.map(canonical)
    : a && typeof a === "object"
      ? Object.fromEntries(
          Object.entries(a)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : a;
const identical = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function buildOndaPreview(
  report: OndaReport,
  ctx: OndaContext,
): OndaPreview {
  const blockers: string[] = [],
    warnings: string[] = [],
    incoming = new Map(report.transactions.map((t) => [t.reference, t])),
    incomingRefunds = new Map(report.refunds.map((r) => [r.identity, r]));
  const tx = new Map(ctx.transactions.map((t) => [t.data.reference, t])),
    refunds = new Map(ctx.refunds.map((r) => [r.data.identity, r]));
  const eligible = (date: string, kind: OndaKind) =>
    !ctx.days.some(
      (d) =>
        d.day === date &&
        d.kind === kind &&
        Date.parse(d.generated_at) > Date.parse(report.generatedAt),
    );
  const covered = (date: string) => date >= report.start && date <= report.end;
  const affected = new Set<string>(),
    newTx: OndaVersion<OndaTransaction>[] = [],
    newRefunds: OndaVersion<OndaRefund>[] = [],
    days: OndaPreview["days"] = [];
  let olderIgnored = 0;
  for (const t of ctx.transactions) {
    if (
      covered(t.data.date) &&
      eligible(t.data.date, t.data.kind) &&
      Date.parse(t.generated_at) <= Date.parse(report.generatedAt) &&
      ondaContribution(t.data) !== 0 &&
      !incoming.has(t.data.reference)
    )
      blockers.push(
        `Previously imported paid reference ${t.data.reference} is missing. Upload a complete report containing its current status.`,
      );
  }
  for (const r of ctx.refunds) {
    if (
      covered(r.data.date) &&
      eligible(r.data.date, r.data.kind) &&
      Date.parse(r.generated_at) <= Date.parse(report.generatedAt) &&
      !incomingRefunds.has(r.data.identity)
    )
      blockers.push(
        `A previously imported cash return for ${r.data.reference} is missing or changed. Reconcile the return before importing.`,
      );
  }
  for (const t of report.transactions) {
    const old = tx.get(t.reference);
    if (
      !eligible(t.date, t.kind) ||
      (old && Date.parse(old.generated_at) > Date.parse(report.generatedAt))
    ) {
      olderIgnored++;
      continue;
    }
    if (
      old &&
      Date.parse(old.generated_at) === Date.parse(report.generatedAt) &&
      !identical(old.data, t)
    ) {
      blockers.push(
        `Reference ${t.reference} differs between reports with the same generation time.`,
      );
      continue;
    }
    const value = { data: t, generated_at: report.generatedAt };
    tx.set(t.reference, value);
    newTx.push(value);
    affected.add(`${t.date}/${t.kind}`);
    if (old) affected.add(`${old.data.date}/${old.data.kind}`);
  }
  for (const r of report.refunds) {
    const old = refunds.get(r.identity);
    if (
      !eligible(r.date, r.kind) ||
      (old && Date.parse(old.generated_at) > Date.parse(report.generatedAt))
    ) {
      olderIgnored++;
      continue;
    }
    if (
      old &&
      Date.parse(old.generated_at) === Date.parse(report.generatedAt) &&
      !identical(old.data, r)
    ) {
      blockers.push(
        `Cash return ${r.reference} differs at the same generation time.`,
      );
      continue;
    }
    const value = { data: r, generated_at: report.generatedAt };
    refunds.set(r.identity, value);
    newRefunds.push(value);
    affected.add(`${r.date}/${r.kind}`);
    const possible = ctx.expenses.some(
      (e) =>
        e.amount_cents === r.amount &&
        e.paid_on === r.date &&
        (`${e.reference} ${e.notes}`.includes(r.reference) ||
          /refund|cash\s*return/i.test(`${e.reference} ${e.notes}`)),
    );
    if (possible)
      blockers.push(
        `A possible refund expense already exists for ${r.reference} on ${r.date}. Reconcile it in Expenses first so the return is not counted twice.`,
      );
  }
  for (const r of refunds.values()) {
    const original = tx.get(r.data.reference);
    if (original) {
      const total = [...refunds.values()]
        .filter((x) => x.data.reference === r.data.reference)
        .reduce((n, x) => n + x.data.amount, 0);
      if (total > original.data.net)
        blockers.push(
          `Cash returns exceed the recorded payment for ${r.data.reference}.`,
        );
    }
  }
  // A changed/cancelled transaction may reduce an existing source-managed day to zero.
  for (const link of ctx.links) {
    const kind =
      ctx.categories.find((c) => c.id === link.category_id)?.name ===
      "Court rental"
        ? "BK"
        : "ER";
    if (covered(link.business_date) && eligible(link.business_date, kind))
      affected.add(`${link.business_date}/${kind}`);
  }
  const oneDay = 86400000;
  for (
    let time = new Date(report.start + "T00:00:00Z").valueOf();
    time <= new Date(report.end + "T00:00:00Z").valueOf();
    time += oneDay
  ) {
    const day = new Date(time).toISOString().slice(0, 10);
    for (const kind of ["BK", "ER"] as const)
      if (eligible(day, kind))
        days.push({ day, kind, generated_at: report.generatedAt });
  }
  const proposals: OndaProposal[] = [];
  for (const key of [...affected].sort()) {
    const [date, rawKind] = key.split("/"),
      kind = rawKind as OndaKind,
      category = ctx.categories.find(
        (c) => c.kind === "income" && c.name === ondaCategory(kind),
      );
    if (!category || !category.active) {
      blockers.push(
        `Activate the ${ondaCategory(kind)} income category before importing.`,
      );
      continue;
    }
    const entries = [...tx.values()]
        .map((t) => t.data)
        .filter(
          (t) =>
            t.date === date &&
            t.kind === kind &&
            t.status === "Paid" &&
            t.net > 0,
        ),
      returns = [...refunds.values()]
        .map((r) => r.data)
        .filter((r) => r.date === date && r.kind === kind);
    const returned = returns.reduce((n, r) => n + r.amount, 0),
      source = entries.reduce((n, t) => n + t.net, 0) - returned;
    const current = ctx.income.find(
        (i) => i.business_date === date && i.category_id === category.id,
      ),
      link = ctx.links.find(
        (l) => l.business_date === date && l.category_id === category.id,
      );
    if (!current && !link && source === 0) continue;
    const generated = ondaNotes(
      kind,
      entries.length,
      entries
        .filter((t) => t.method === "Cash")
        .reduce((n, t) => n + t.net, 0) - returned,
      entries.filter((t) => t.method === "QRPH").reduce((n, t) => n + t.net, 0),
      returned,
      entries
        .filter((t) => t.method !== "Cash" && t.method !== "QRPH")
        .reduce((n, t) => n + t.net, 0),
    );
    const conflict =
      !!(current && !link) ||
      !!(
        link &&
        (!current ||
          current.id !== link.income_id ||
          current.amount_cents !== link.last_amount ||
          current.notes !== link.last_notes)
      );
    const manual = link?.manual_amount || 0,
      notes =
        current && (!link || current.notes !== link.generated_notes)
          ? current.notes
          : generated;
    const allocated = ctx.allocations
      .filter((a) => a.income_id === current?.id)
      .reduce((n, a) => n + a.amount_cents, 0);
    const proposal: OndaProposal = {
      key,
      date,
      kind,
      category_id: category.id,
      income_id: current?.id || null,
      old_amount: current?.amount_cents ?? null,
      old_notes: current?.notes || "",
      source_amount: source,
      manual_amount: manual,
      notes,
      generated_notes: generated,
      conflict,
      status: conflict
        ? "conflict"
        : !current
          ? "new"
          : current.amount_cents !== source + manual || current.notes !== notes
            ? "updated"
            : "unchanged",
      allocated,
    };
    if (!conflict && allocated > Math.max(0, source + manual))
      blockers.push(
        `${date} ${category.name} has ${money(allocated)} assigned to accounts. Reconcile those assignments before reducing its income.`,
      );
    proposals.push(proposal);
  }
  if (olderIgnored)
    warnings.push(
      `${olderIgnored} transaction/return versions are older than confirmed data and will not overwrite it.`,
    );
  return {
    report,
    proposals,
    blockers: [...new Set(blockers)],
    warnings,
    transactions: newTx,
    refunds: newRefunds,
    days,
    olderIgnored,
    change: proposals.reduce(
      (n, p) => n + p.source_amount + p.manual_amount - (p.old_amount || 0),
      0,
    ),
  };
}
export function resolvedOndaAmount(p: OndaProposal, r?: OndaResolution) {
  if (p.conflict && !r) throw Error("Resolve every manual-income conflict.");
  if (
    r &&
    (!["replace", "manual"].includes(r.mode) ||
      (r.mode === "manual" &&
        (!Number.isSafeInteger(r.amount_cents) ||
          Math.abs(r.amount_cents!) > 999999999999)))
  )
    throw Error("Enter the separate income outside Onda.");
  const amount =
    p.source_amount +
    (r ? (r.mode === "manual" ? r.amount_cents! : 0) : p.manual_amount);
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 999999999999)
    throw Error("Income total is too large.");
  if (p.allocated > Math.max(0, amount))
    throw Error(
      "Reconcile existing account assignments before reducing income.",
    );
  return amount;
}
