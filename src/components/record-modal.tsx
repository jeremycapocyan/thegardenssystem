"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X, LoaderCircle, Info } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import {
  addMonths,
  billTerm,
  installmentSummary,
  monthStart,
  parseMoney,
} from "@/lib/finance";
import {
  OWNERS,
  type BillTerm,
  type Collection,
  type PaymentKind,
} from "@/lib/types";

export interface Editor {
  kind: Collection | "bills";
  record?: Record<string, unknown>;
  term?: BillTerm;
  revise?: boolean;
  categoryKind?: "income" | "expense";
}
function Field({
  label,
  children,
  hint,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  wide?: boolean;
}) {
  return (
    <label className={`field ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function RecordModal({
  editor,
  reference,
  onClose,
  onSaved,
}: {
  editor: Editor;
  reference: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ws = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const reviewedDuplicate = useRef("");
  const record = editor.record;
  const str = (key: string, fallback = "") => String(record?.[key] ?? fallback);
  const [id] = useState(() => str("id") || crypto.randomUUID());
  const [termId] = useState(() =>
    editor.revise
      ? crypto.randomUUID()
      : editor.term?.id || crypto.randomUUID(),
  );
  const [paymentKind, setPaymentKind] = useState<PaymentKind>(
    str("payment_kind", "operating") as PaymentKind,
  );
  const [obligation, setObligation] = useState(
    () => str("fixed_bill_id") || str("installment_id"),
  );
  const [category, setCategory] = useState(() => str("category_id"));
  const [dueMonth, setDueMonth] = useState(() =>
    str("due_month", monthStart(reference)).slice(0, 7),
  );
  const [code] = useState(
    () =>
      str("code") ||
      `${editor.kind === "bills" ? "BILL" : "INST"}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
  );
  const editing = Boolean(record);
  const titles = {
    income: "Record income",
    expenses: "Record a payment",
    bills: "Add a fixed bill",
    installments: "Add an installment",
    payouts: "Record owner payout",
    categories: "Add a category",
  };
  const title = editor.revise
    ? "Change bill terms"
    : editing
      ? `Edit ${editor.kind === "bills" ? "fixed bill" : editor.kind === "categories" ? "category" : "record"}`
      : titles[editor.kind];
  const categoryKind = editor.kind === "income" ? "income" : "expense";
  const categoryOptions = ws.data.categories.filter(
    (c) => c.kind === categoryKind && (c.active || c.id === category),
  );
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  function chooseObligation(value: string) {
    setObligation(value);
    setCategory(
      paymentKind === "fixed"
        ? ws.data.bills.find((b) => b.id === value)?.category_id || ""
        : ws.data.installments.find((b) => b.id === value)?.category_id || "",
    );
  }
  function changeKind(value: PaymentKind) {
    setPaymentKind(value);
    setObligation("");
    setCategory("");
  }
  const peso = (key: string, fallback?: number) =>
    record?.[key] != null
      ? (Number(record[key]) / 100).toFixed(2)
      : fallback != null
        ? (fallback / 100).toFixed(2)
        : "";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);
    try {
      const form = new FormData(event.currentTarget);
      const get = (name: string) => String(form.get(name) || "").trim();
      const positive = (name: string) => {
        const cents = parseMoney(get(name));
        if (cents <= 0)
          throw new Error("Payment amounts must be greater than zero.");
        return cents;
      };
      const requiredCategory = () => {
        if (!category) throw new Error("Choose a category.");
        return category;
      };
      let payload: Record<string, unknown> = { id };
      if (editor.kind === "income")
        payload = {
          id,
          business_date: get("date"),
          category_id: requiredCategory(),
          amount_cents: parseMoney(get("amount")),
          notes: get("notes"),
        };
      if (editor.kind === "expenses") {
        const month = `${dueMonth}-01`;
        if (paymentKind !== "operating" && !obligation)
          throw new Error("Choose the bill or installment you are paying.");
        if (paymentKind === "fixed" && !billTerm(ws.data, obligation, month))
          throw new Error(
            "This bill has no terms for the selected due month. Choose its correct month or add bill terms first.",
          );
        if (paymentKind === "installment") {
          const agreement = ws.data.installments.find(
            (i) => i.id === obligation,
          );
          if (!agreement) throw new Error("Choose an installment agreement.");
          const last = installmentSummary(
            ws.data,
            agreement,
            get("date"),
          ).lastMonth;
          if (month < monthStart(agreement.first_due) || month > last)
            throw new Error(
              "The due month is outside this installment’s payment schedule.",
            );
        }
        payload = {
          id,
          paid_on: get("date"),
          category_id: requiredCategory(),
          payment_kind: paymentKind,
          fixed_bill_id: paymentKind === "fixed" ? obligation : null,
          installment_id: paymentKind === "installment" ? obligation : null,
          due_month: paymentKind === "operating" ? null : month,
          amount_cents: positive("amount"),
          reference: get("reference"),
          notes: get("notes"),
        };
      }
      if (editor.kind === "installments")
        payload = {
          id,
          code: get("code"),
          name: get("name"),
          category_id: requiredCategory(),
          total_cents: positive("total"),
          monthly_cents: positive("monthly"),
          first_due: get("first_due"),
          notes: get("notes"),
        };
      if (editor.kind === "payouts")
        payload = {
          id,
          paid_on: get("date"),
          owner: get("owner"),
          settlement_month: `${get("settlement_month")}-01`,
          amount_cents: positive("amount"),
          reference: get("reference"),
          notes: get("notes"),
        };
      if (editor.kind === "categories")
        payload = {
          id,
          kind: str("kind") || get("kind"),
          name: get("name"),
          active: record?.active ?? true,
        };
      if (editor.kind === "expenses" || editor.kind === "payouts") {
        const fields =
          editor.kind === "expenses"
            ? [
                "paid_on",
                "category_id",
                "payment_kind",
                "fixed_bill_id",
                "installment_id",
                "due_month",
                "amount_cents",
              ]
            : ["paid_on", "owner", "settlement_month", "amount_cents"];
        const signature = JSON.stringify(fields.map((field) => payload[field]));
        const duplicate = (
          ws.data[editor.kind] as unknown as Record<string, unknown>[]
        ).some(
          (row) =>
            row.id !== id &&
            fields.every((field) => row[field] === payload[field]),
        );
        if (duplicate && reviewedDuplicate.current !== signature) {
          reviewedDuplicate.current = signature;
          throw new Error(
            "Possible duplicate: a matching payment is already recorded. Check the date, amount, and reference. If this is a separate payment, choose Save record again.",
          );
        }
      }
      if (editor.kind === "bills") {
        const start = `${get("start_month")}-01`;
        const end = get("end_month") ? `${get("end_month")}-01` : null;
        if (end && end < start)
          throw new Error(
            "End month must be the same as or later than start month.",
          );
        const dueDay = Number(get("due_day"));
        if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)
          throw new Error("Due day must be between 1 and 31.");
        await ws.saveBill(
          {
            bill_id: id,
            term_id: termId,
            code: get("code"),
            name: get("name"),
            category_id: requiredCategory(),
            amount_cents: positive("amount"),
            due_day: dueDay,
            start_month: start,
            end_month: end,
            notes: get("notes"),
          },
          editing ? id : undefined,
          editor.revise,
        );
      } else await ws.save(editor.kind, payload);
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to save this record.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="record-dialog"
      aria-labelledby="editor-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">THE GARDENS</span>
          <h2 id="editor-title">{title}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close form"
        >
          <X size={20} />
        </button>
      </div>
      <form onSubmit={submit}>
        <div className="form-grid">
          {(editor.kind === "income" ||
            editor.kind === "expenses" ||
            editor.kind === "payouts") && (
            <Field
              label={
                editor.kind === "income" ? "Business date" : "Payment date"
              }
            >
              <input
                type="date"
                name="date"
                required
                defaultValue={str(
                  editor.kind === "income" ? "business_date" : "paid_on",
                  reference,
                )}
              />
            </Field>
          )}
          {editor.kind === "expenses" && (
            <Field label="Payment type">
              <select
                value={paymentKind}
                onChange={(e) => changeKind(e.target.value as PaymentKind)}
              >
                <option value="operating">Operating expense</option>
                <option value="fixed">Fixed bill</option>
                <option value="installment">Installment</option>
              </select>
            </Field>
          )}
          {editor.kind === "expenses" && paymentKind !== "operating" && (
            <>
              <Field
                label="Month being paid"
                hint="Choose the month this payment settles."
              >
                <input
                  type="month"
                  required
                  value={dueMonth}
                  onChange={(e) => setDueMonth(e.target.value)}
                />
              </Field>
              <Field
                label={
                  paymentKind === "fixed"
                    ? "Fixed bill"
                    : "Installment agreement"
                }
              >
                <select
                  required
                  value={obligation}
                  onChange={(e) => chooseObligation(e.target.value)}
                >
                  <option value="">Choose an agreement</option>
                  {(paymentKind === "fixed"
                    ? ws.data.bills
                    : ws.data.installments
                  ).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.code}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {(editor.kind === "bills" || editor.kind === "installments") && (
            <>
              <Field
                label={editor.kind === "bills" ? "Bill name" : "Agreement name"}
              >
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={str("name")}
                  placeholder={
                    editor.kind === "bills"
                      ? "e.g. Court rent"
                      : "e.g. Court lighting upgrade"
                  }
                />
              </Field>
              <Field
                label="Reference code"
                hint="Generated for you; used to link payments."
              >
                <input
                  name="code"
                  required
                  maxLength={40}
                  defaultValue={code}
                  readOnly={editing}
                />
              </Field>
            </>
          )}
          {["income", "expenses", "bills", "installments"].includes(
            editor.kind,
          ) && (
            <Field label="Category">
              <select
                required
                value={category}
                disabled={
                  editor.kind === "expenses" && paymentKind !== "operating"
                }
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="">Choose a category</option>
                {categoryOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {!c.active ? " (archived)" : ""}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {["income", "expenses", "payouts", "bills"].includes(editor.kind) && (
            <Field
              label={editor.kind === "bills" ? "Monthly amount" : "Amount"}
            >
              <div className="money-input">
                <span>₱</span>
                <input
                  name="amount"
                  required
                  inputMode="decimal"
                  placeholder="0.00"
                  defaultValue={peso("amount_cents", editor.term?.amount_cents)}
                />
              </div>
            </Field>
          )}
          {editor.kind === "bills" && (
            <>
              <Field label="Due day" hint="Short months use their last day.">
                <input
                  type="number"
                  name="due_day"
                  min={1}
                  max={31}
                  required
                  defaultValue={editor.term?.due_day || 1}
                />
              </Field>
              <Field
                label={editor.revise ? "New terms start in" : "Start month"}
              >
                <input
                  type="month"
                  name="start_month"
                  required
                  defaultValue={(editor.revise
                    ? addMonths(monthStart(reference), 1)
                    : editor.term?.start_month || monthStart(reference)
                  ).slice(0, 7)}
                />
              </Field>
              <Field
                label="End month (optional)"
                hint="Leave blank for an ongoing bill."
              >
                <input
                  type="month"
                  name="end_month"
                  defaultValue={editor.term?.end_month?.slice(0, 7) || ""}
                />
              </Field>
            </>
          )}
          {editor.kind === "installments" && (
            <>
              <Field
                label="Total agreed payable"
                hint="Include interest and fees in this total."
              >
                <div className="money-input">
                  <span>₱</span>
                  <input
                    name="total"
                    inputMode="decimal"
                    required
                    defaultValue={peso("total_cents")}
                    placeholder="0.00"
                  />
                </div>
              </Field>
              <Field label="Regular monthly payment">
                <div className="money-input">
                  <span>₱</span>
                  <input
                    name="monthly"
                    inputMode="decimal"
                    required
                    defaultValue={peso("monthly_cents")}
                    placeholder="0.00"
                  />
                </div>
              </Field>
              <Field label="First due date">
                <input
                  type="date"
                  name="first_due"
                  required
                  defaultValue={str("first_due", reference)}
                />
              </Field>
            </>
          )}
          {editor.kind === "payouts" && (
            <>
              <Field label="Owner">
                <select
                  name="owner"
                  required
                  defaultValue={str("owner", "Genesis")}
                >
                  {OWNERS.map((owner) => (
                    <option key={owner}>{owner}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Settlement month"
                hint="The month whose owner share is being paid."
              >
                <input
                  type="month"
                  name="settlement_month"
                  required
                  defaultValue={str(
                    "settlement_month",
                    monthStart(reference),
                  ).slice(0, 7)}
                />
              </Field>
            </>
          )}
          {editor.kind === "categories" && (
            <>
              <Field label="Category name">
                <input
                  name="name"
                  required
                  maxLength={80}
                  defaultValue={str("name")}
                  placeholder="e.g. Court rental"
                />
              </Field>
              <Field label="Used for">
                <select
                  name="kind"
                  defaultValue={str("kind", editor.categoryKind || "expense")}
                  disabled={editing}
                >
                  <option value="income">Income</option>
                  <option value="expense">Expenses</option>
                </select>
              </Field>
            </>
          )}
          {(editor.kind === "expenses" || editor.kind === "payouts") && (
            <Field label="Receipt / transfer reference (optional)">
              <input
                name="reference"
                maxLength={120}
                defaultValue={str("reference")}
                placeholder="Receipt number or bank reference"
              />
            </Field>
          )}
          {editor.kind !== "categories" && (
            <Field label="Notes (optional)" wide>
              <textarea
                name="notes"
                rows={2}
                maxLength={1000}
                defaultValue={str("notes")}
                placeholder="Anything useful to remember"
              />
            </Field>
          )}
        </div>
        {editor.kind === "bills" && (
          <p className="form-note">
            <Info size={16} />
            {editor.revise
              ? "Earlier months keep their previous terms. The new amount starts in the month you select."
              : "Payments are recorded in Expenses and automatically linked to this bill."}
          </p>
        )}
        {editor.kind === "installments" && (
          <p className="form-note">
            <Info size={16} />
            Record actual payments in Expenses. The final installment adjusts to
            the amount remaining.
          </p>
        )}
        {editor.kind === "payouts" && (
          <p className="form-note">
            <Info size={16} />
            Owner payouts settle monthly shares. They do not reduce business net
            income.
          </p>
        )}
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button className="button primary" disabled={pending}>
            {pending && <LoaderCircle size={17} className="spin" />}
            {pending ? "Saving…" : "Save record"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
