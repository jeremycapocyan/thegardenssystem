import type { Dataset, Owner } from "./types";
import type { CashData, CashMovement, CashAllocation } from "./balances";
import { emptyPartnerCash, type PartnerCashAction } from "./partner-cash";
import { toDate } from "./finance";

/** Isolated browser samples only. Production commands are PostgreSQL transactions. */
export function applyPartnerCashDemo(
  data: Dataset,
  balances: CashData,
  action: PartnerCashAction,
  id: string,
  v: Record<string, unknown>,
  today: string,
) {
  const next = structuredClone(data),
    cash = structuredClone(balances),
    p = (next.partner_cash ??= emptyPartnerCash()) as ReturnType<
      typeof emptyPartnerCash
    > & { demo_actions?: { id: string; action: string; payload: string }[] };
  const prior = p.demo_actions?.find((a) => a.id === id),
    signature = JSON.stringify(v);
  if (prior) {
    if (prior.action !== action || prior.payload !== signature)
      throw Error("Retry key belongs to another action.");
    cash.finance = next;
    return { data: next, balances: cash };
  }
  const text = (key: string) => String(v[key] ?? ""),
    num = (key: string) => Number(v[key]);
  const positive = (n: number) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > 999999999999)
      throw Error("Enter a positive peso amount.");
    return n;
  };
  const opening = cash.settings?.start_date;
  if (!opening)
    throw Error("Configure opening balances in Cash & balances first.");
  const date = (value: string, min = opening) => {
    toDate(value);
    if (value < min || value > today)
      throw Error(
        "Use an actual date on or after receipt and opening balances.",
      );
    return value;
  };
  const account = text("account");
  const move = (
    incoming: boolean,
    amount: number,
    on: string,
    reason: string,
  ) => {
    if (!["cash", "bank"].includes(account))
      throw Error("Choose Cash or Bank.");
    const existing = cash.movements.find((m) => m.id === text("movement_id"));
    if (text("movement_id") && !existing)
      throw Error("Existing movement no longer exists.");
    if (existing) {
      if (
        existing.kind !== "funding" ||
        existing.amount_cents !== amount ||
        existing.moved_on !== on ||
        (incoming
          ? existing.to_account !== account || !!existing.from_account
          : existing.from_account !== account || !!existing.to_account)
      )
        throw Error("Existing movement does not match.");
      if (
        p.advances.some((a) => !a.voided_at && a.receipt_id === existing.id) ||
        p.repayments.some((r) => !r.voided_at && r.movement_id === existing.id)
      )
        throw Error("This movement is already linked.");
      return { m: existing, owned: false };
    }
    const m: CashMovement = {
      id: crypto.randomUUID(),
      moved_on: on,
      kind: "funding",
      amount_cents: amount,
      from_account: incoming ? null : (account as "cash" | "bank"),
      to_account: incoming ? (account as "cash" | "bank") : null,
      reference: text("reference"),
      reason,
    };
    cash.movements.push(m);
    return { m, owned: true };
  };
  if (action === "receive") {
    const amount = positive(num("amount_cents")),
      monthly = positive(num("monthly_cents")),
      on = date(text("received_on")),
      first = text("first_due");
    toDate(first);
    if (first < on || monthly > amount || first > "2100-12-31")
      throw Error("Check repayment dates and monthly amount.");
    const due = toDate(first);
    if (
      Math.ceil(amount / monthly) - 1 >
      (2100 - due.getUTCFullYear()) * 12 + 11 - due.getUTCMonth()
    )
      throw Error("Choose repayment terms ending by December 2100.");
    if (
      !["Genesis", "Ken", "Jeremy"].includes(text("owner")) ||
      !text("purpose").trim()
    )
      throw Error("Choose a partner and enter the purpose.");
    const { m, owned } = move(
      true,
      amount,
      on,
      "Partner cash advance received: " +
        text("owner") +
        " — " +
        text("purpose"),
    );
    p.advances.push({
      id,
      owner: text("owner") as Owner,
      purpose: text("purpose"),
      received_on: on,
      amount_cents: amount,
      monthly_cents: monthly,
      first_due: first,
      receipt_id: m.id,
      owned_receipt: owned,
      detail: m,
      voided_at: null,
    });
  } else if (action === "purchase" || action === "repay") {
    const a = p.advances.find(
      (a) => a.id === text("advance_id") && !a.voided_at,
    );
    if (!a) throw Error("Choose an active cash advance.");
    const amount = positive(num("amount_cents")),
      on = date(text("paid_on"), a.received_on);
    if (action === "repay") {
      const paid = p.repayments
        .filter((r) => r.advance_id === a.id && !r.voided_at)
        .reduce((n, r) => n + r.amount_cents, 0);
      if (paid + amount > a.amount_cents)
        throw Error("Repayment cannot exceed the outstanding debt.");
      const { m, owned } = move(
        false,
        amount,
        on,
        "Partner cash advance repayment: " + a.owner + " — " + a.purpose,
      );
      p.repayments.push({
        id,
        advance_id: a.id,
        paid_on: on,
        amount_cents: amount,
        movement_id: m.id,
        owned_movement: owned,
        detail: m,
        voided_at: null,
      });
    } else {
      if (!["cash", "bank"].includes(account))
        throw Error("Choose Cash or Bank.");
      if (
        p.spends
          .filter((s) => s.advance_id === a.id && !s.voided_at)
          .reduce((n, s) => n + s.amount_cents, 0) +
          amount >
        a.amount_cents
      )
        throw Error("Purchase links cannot exceed the advance received.");
      let e = next.expenses.find((e) => e.id === text("expense_id")),
        owned = false;
      if (text("expense_id")) {
        if (
          !e ||
          e.payment_kind !== "operating" ||
          e.staff_payment_id ||
          e.paid_on !== on ||
          e.amount_cents !== num("expected_total_cents") ||
          e.category_id !== text("category_id") ||
          e.reference !== text("reference") ||
          e.notes !== text("notes")
        )
          throw Error("Existing expense changed. Refresh and review it.");
      } else {
        const total = positive(num("total_cents"));
        if (total < amount)
          throw Error("Total purchase must cover the funded portion.");
        if (
          !next.categories.some(
            (c) =>
              c.id === text("category_id") && c.kind === "expense" && c.active,
          )
        )
          throw Error("Choose an active expense category.");
        e = {
          id: crypto.randomUUID(),
          paid_on: on,
          category_id: text("category_id"),
          amount_cents: total,
          payment_kind: "operating",
          fixed_bill_id: null,
          installment_id: null,
          due_month: null,
          notes: text("notes"),
          reference: text("reference"),
        };
        next.expenses.push(e);
        owned = true;
      }
      if (
        p.spends
          .filter((s) => s.expense_id === e!.id && !s.voided_at)
          .reduce((n, s) => n + s.amount_cents, 0) +
          amount >
        e.amount_cents
      )
        throw Error("Funding links cannot exceed the purchase amount.");
      let allocation = cash.allocations.find(
          (c) => c.id === text("allocation_id"),
        ),
        allocated = false;
      if (text("allocation_id")) {
        if (
          !allocation ||
          allocation.expense_id !== e.id ||
          allocation.account !== account ||
          (allocation.posted_on || e.paid_on) !== on ||
          p.spends
            .filter((s) => s.allocation_id === allocation!.id && !s.voided_at)
            .reduce((n, s) => n + s.amount_cents, 0) +
            amount >
            allocation.amount_cents
        )
          throw Error(
            "Account assignment changed or has insufficient unlinked funds.",
          );
      } else {
        const n = owned ? e.amount_cents : amount;
        if (
          cash.allocations
            .filter((c) => c.expense_id === e!.id)
            .reduce((n, c) => n + c.amount_cents, 0) +
            n >
          e.amount_cents
        )
          throw Error(
            "Select an existing assignment; this expense is already assigned.",
          );
        allocation = {
          id: crypto.randomUUID(),
          expense_id: e.id,
          income_id: null,
          payout_id: null,
          posted_on: on,
          account: account as "cash" | "bank",
          amount_cents: n,
        };
        cash.allocations.push(allocation);
        allocated = true;
      }
      p.spends.push({
        id,
        advance_id: a.id,
        expense_id: e.id,
        allocation_id: allocation.id,
        amount_cents: amount,
        owned_expense: owned,
        owned_allocation: allocated,
        detail: { expense: e, allocation },
        voided_at: null,
      });
    }
  } else {
    if (!text("reason").trim()) throw Error("A correction reason is required.");
    const stamp = new Date().toISOString(),
      record = text("record_id");
    if (action === "void_receipt") {
      const a = p.advances.find((a) => a.id === record && !a.voided_at);
      if (!a) throw Error("Active advance not found.");
      if (
        p.spends.some((s) => s.advance_id === record && !s.voided_at) ||
        p.repayments.some((r) => r.advance_id === record && !r.voided_at)
      )
        throw Error("Correct linked purchases and repayments first.");
      if (a.owned_receipt)
        cash.movements = cash.movements.filter((m) => m.id !== a.receipt_id);
      a.receipt_id = null;
      a.voided_at = stamp;
      a.void_reason = text("reason");
    } else if (action === "void_repayment") {
      const r = p.repayments.find((r) => r.id === record && !r.voided_at);
      if (!r) throw Error("Active repayment not found.");
      if (r.owned_movement)
        cash.movements = cash.movements.filter((m) => m.id !== r.movement_id);
      r.movement_id = null;
      r.voided_at = stamp;
      r.void_reason = text("reason");
    } else {
      const s = p.spends.find((s) => s.id === record && !s.voided_at);
      if (!s) throw Error("Active purchase not found.");
      if (
        p.spends.some(
          (x) =>
            x.id !== s.id &&
            !x.voided_at &&
            ((s.owned_expense && x.expense_id === s.expense_id) ||
              (s.owned_allocation && x.allocation_id === s.allocation_id)),
        )
      )
        throw Error("Unlink other advances from this purchase first.");
      if (s.owned_expense) {
        next.expenses = next.expenses.filter((e) => e.id !== s.expense_id);
        cash.allocations = cash.allocations.filter(
          (c) => c.expense_id !== s.expense_id,
        );
      } else if (s.owned_allocation)
        cash.allocations = cash.allocations.filter(
          (c) => c.id !== s.allocation_id,
        );
      s.voided_at = stamp;
      s.void_reason = text("reason");
    }
  }
  (p.demo_actions ??= []).push({ id, action, payload: signature });
  cash.finance = next;
  return { data: next, balances: cash };
}

export function guardPartnerCashManual(
  data: Dataset,
  collection: string,
  id: unknown,
) {
  if (
    collection === "expenses" &&
    data.partner_cash?.spends.some((s) => s.expense_id === id && !s.voided_at)
  )
    throw Error("Use Partner cash advances to correct this linked entry.");
}
