import { emptyPartners, previewPartnerSettlement } from "./partners";
import { monthStart, monthEnd, todayInManila } from "./finance";
import type { Dataset, Owner } from "./types";
import type { CashData, CashAccount } from "./balances";
type DemoAction = {
  id: string;
  action: string;
  payload: string;
  result: Record<string, unknown>;
};
type DemoPartners = ReturnType<typeof emptyPartners> & {
  demo_actions?: DemoAction[];
};
export function applyPartnerDemo(
  finance: Dataset,
  cash: CashData,
  action: string,
  id: string,
  payload: Record<string, unknown>,
  today = todayInManila(),
) {
  const data = structuredClone(finance),
    p = (data.partners ??= emptyPartners()) as DemoPartners,
    balances = structuredClone(cash),
    v = payload as Record<string, any>,
    prior = p.demo_actions?.find((a) => a.id === id);
  const clock = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  const recordedAt = new Date(`${today}T${clock}+08:00`).toISOString();
  if (prior) {
    if (prior.action !== action || prior.payload !== JSON.stringify(payload))
      throw Error("Retry key belongs to another action.");
    return { data, balances, result: prior.result };
  }
  let result: Record<string, unknown> = {};
  const requireReason = () => {
    if (typeof v.reason !== "string" || v.reason.trim().length < 3)
      throw Error("Enter a correction reason.");
  };
  const checkDate = (date: string) => {
    if (
      !balances.settings ||
      date < balances.settings.start_date ||
      date > today
    )
      throw Error(
        "Set opening balances and use an actual payment date on or after opening.",
      );
  };
  const rule = (owner: Owner, month: string, rate: number, reason: string) => {
    if (p.settlements.some((s) => !s.reversed_at && s.month >= month))
      throw Error(
        "Rules cannot rewrite confirmed settlements. Reverse the affected settlement first.",
      );
    if (!Number.isInteger(rate) || rate < 0 || rate > 10000)
      throw Error("Enter a recovery percentage between 0 and 100.");
    const existing = p.rules.find(
      (r) => r.owner === owner && r.effective_month === month,
    );
    if (existing) Object.assign(existing, { rate_bps: rate, reason });
    else
      p.rules.push({
        id: crypto.randomUUID(),
        owner,
        effective_month: month,
        rate_bps: rate,
        reason,
      });
  };
  if (action === "purchase") {
    const item = v.existing_id || id;
    if (v.purchased_on > today) throw Error("Use the actual purchase date.");
    if (p.purchases.some((x) => x.id === item))
      throw Error("Agreement already linked.");
    if (!v.existing_id)
      data.installments.push({
        id: item,
        code: "PARTNER-" + id.slice(0, 8).toUpperCase(),
        name: v.name,
        category_id: v.category_id,
        total_cents: v.total_cents,
        monthly_cents: v.monthly_cents,
        first_due: v.first_due,
        notes: v.notes || "",
      });
    if (!data.installments.some((x) => x.id === item))
      throw Error("Agreement not found.");
    p.purchases.push({
      id: item,
      owner: v.owner,
      purchased_on: v.purchased_on,
    });
    result = { installment_id: item };
  } else if (action === "reimburse") {
    const purchase = p.purchases.find((x) => x.id === v.installment_id),
      a = data.installments.find((x) => x.id === v.installment_id);
    if (!purchase || !a) throw Error("Choose a partner-funded purchase.");
    checkDate(v.paid_on);
    const paid = data.expenses
      .filter((e) => e.installment_id === a.id)
      .reduce((n, e) => n + e.amount_cents, 0);
    if (v.amount_cents <= 0 || paid + v.amount_cents > a.total_cents)
      throw Error("Reimbursement exceeds the outstanding obligation.");
    const first = monthStart(a.first_due),
      last = monthStart(
        new Date(
          Date.UTC(
            Number(first.slice(0, 4)),
            Number(first.slice(5, 7)) -
              1 +
              Math.ceil(a.total_cents / a.monthly_cents) -
              1,
            1,
          ),
        )
          .toISOString()
          .slice(0, 10),
      );
    if (
      v.paid_on < purchase.purchased_on ||
      v.due_month < first ||
      v.due_month > last
    )
      throw Error("Check purchase date and installment due month.");
    const expense = crypto.randomUUID(),
      allocation = crypto.randomUUID();
    data.expenses.push({
      id: expense,
      paid_on: v.paid_on,
      category_id: a.category_id,
      payment_kind: "installment",
      installment_id: a.id,
      fixed_bill_id: null,
      due_month: v.due_month,
      amount_cents: v.amount_cents,
      reference: v.reference || "",
      notes: `Reimbursement to ${purchase.owner}: ${a.name}`,
    });
    balances.allocations.push({
      id: allocation,
      posted_on: v.paid_on,
      account: v.account as CashAccount,
      income_id: null,
      payout_id: null,
      expense_id: expense,
      amount_cents: v.amount_cents,
    });
    p.payments.push({
      id,
      installment_id: a.id,
      expense_id: expense,
      allocation_id: allocation,
      detail: {
        paid_on: v.paid_on,
        amount_cents: v.amount_cents,
        account: v.account,
        reference: v.reference || "",
      },
      voided_at: null,
    });
    result = { payment_id: id, expense_id: expense };
  } else if (action === "void_reimbursement") {
    requireReason();
    const payment = p.payments.find(
      (x) => x.id === v.payment_id && !x.voided_at,
    );
    if (!payment) throw Error("Active reimbursement not found.");
    data.expenses = data.expenses.filter((e) => e.id !== payment.expense_id);
    balances.allocations = balances.allocations.filter(
      (a) => a.id !== payment.allocation_id,
    );
    payment.expense_id = null;
    payment.allocation_id = null;
    payment.voided_at = recordedAt;
    payment.void_reason = v.reason;
    result = { voided_payment: payment.id };
  } else if (action === "funding_draft") {
    if (
      !v.partners?.length ||
      v.partners.reduce((n: number, x: any) => n + x.amount_cents, 0) !==
        v.total_cents
    )
      throw Error("Partner allocations must equal the supplier payment.");
    p.fundings.push({
      id,
      supplier: v.supplier,
      purpose: v.purpose,
      total_cents: v.total_cents,
      start_month: v.start_month,
      state: "draft",
      funded_on: null,
      movement_id: null,
      created_at: recordedAt,
    });
    for (const person of v.partners) {
      if (person.amount_cents <= 0)
        throw Error("Allocations must be positive.");
      p.debts.push({
        id: crypto.randomUUID(),
        funding_id: id,
        owner: person.owner,
        amount_cents: person.amount_cents,
      });
      rule(
        person.owner,
        v.start_month,
        person.rate_bps,
        "Capital recovery setup",
      );
    }
    result = { funding_id: id };
  } else if (action === "fund") {
    checkDate(v.paid_on);
    const f = p.fundings.find(
      (x) => x.id === v.funding_id && x.state === "draft",
    );
    if (!f) throw Error("Choose an unpaid draft capital advance.");
    const movement = crypto.randomUUID();
    balances.movements.push({
      id: movement,
      moved_on: v.paid_on,
      kind: "partner_capital",
      from_account: v.account as CashAccount,
      to_account: null,
      amount_cents: f.total_cents,
      reference: v.reference || "",
      reason: "Capital advance: " + f.purpose,
    });
    Object.assign(f, {
      state: "funded",
      funded_on: v.paid_on,
      movement_id: movement,
      funding_detail: { account: v.account, reference: v.reference || "" },
    });
    result = { funding_id: f.id, movement_id: movement };
  } else if (action === "void_funding") {
    requireReason();
    const f = p.fundings.find(
      (x) => x.id === v.funding_id && x.state !== "void",
    );
    if (!f) throw Error("Active capital advance not found.");
    if (
      p.recoveries.some(
        (r) =>
          p.debts.some((d) => d.id === r.debt_id && d.funding_id === f.id) &&
          p.settlements.some((s) => s.id === r.settlement_id && !s.reversed_at),
      )
    )
      throw Error(
        "Reverse its owner settlements before correcting funded capital.",
      );
    balances.movements = balances.movements.filter(
      (m) => m.id !== f.movement_id,
    );
    f.movement_id = null;
    f.state = "void";
    f.void_reason = v.reason;
    result = { voided_funding: f.id };
  } else if (action === "rule") {
    requireReason();
    rule(v.owner, v.effective_month, v.rate_bps, v.reason);
    result = { rule_saved: true };
  } else if (action === "settle") {
    const preview = previewPartnerSettlement(data, v.month, today);
    if (!preview.can_post)
      throw Error("Use a completed, unconfirmed month with rates configured.");
    if (preview.fingerprint !== v.fingerprint)
      throw Error("Records changed after preview. Refresh and review again.");
    p.settlements.push({
      id,
      month: v.month,
      net_cents: preview.net_cents,
      profit_hash: preview.profit_hash,
      snapshot: preview,
      confirmed_at: recordedAt,
      reversed_at: null,
    });
    for (const owner of preview.owners)
      for (const allocation of owner.allocations)
        p.recoveries.push({
          id: crypto.randomUUID(),
          settlement_id: id,
          debt_id: allocation.debt_id,
          owner: owner.owner,
          amount_cents: allocation.amount_cents,
          effective_on: monthEnd(v.month),
        });
    result = { settlement_id: id, snapshot: preview };
  } else if (action === "reverse_settlement") {
    requireReason();
    const s = p.settlements.find(
      (x) => x.id === v.settlement_id && !x.reversed_at,
    );
    if (!s) throw Error("Confirmed settlement not found.");
    s.reversed_at = recordedAt;
    s.reversal_reason = v.reason;
    result = { reversed_settlement: s.id };
  } else throw Error("Unknown partner finance action.");
  (p.demo_actions ??= []).push({
    id,
    action,
    payload: JSON.stringify(payload),
    result,
  });
  balances.finance = data;
  return { data, balances, result };
}

export function guardPartnerManual(
  data: Dataset,
  kind: string,
  row: Record<string, unknown>,
) {
  const p = data.partners;
  if (!p) return;
  if (
    (kind === "installments" && p.purchases.some((x) => x.id === row.id)) ||
    (kind === "expenses" &&
      data.expenses.some(
        (e) =>
          e.id === row.id && p.purchases.some((x) => x.id === e.installment_id),
      ))
  )
    throw Error("Use Partner advances to change this linked record.");
  if (
    kind === "expenses" &&
    p.purchases.some((x) => x.id === row.installment_id)
  )
    throw Error("Record this reimbursement in Partner advances.");
  if (kind === "payouts") {
    const s = p.settlements.find(
        (s) => s.month === row.settlement_month && !s.reversed_at,
      ),
      o = s?.snapshot.owners.find((o) => o.owner === row.owner);
    const paid = data.payouts
      .filter(
        (v) =>
          v.owner === row.owner &&
          v.settlement_month === row.settlement_month &&
          v.id !== row.id,
      )
      .reduce((n, v) => n + v.amount_cents, 0);
    if (o && paid + Number(row.amount_cents) > o.entitlement - o.withheld)
      throw Error(
        "Payout exceeds the confirmed entitlement after capital deductions.",
      );
  }
}
