export type Role = "admin" | "viewer" | "employee";
export type Owner = "Genesis" | "Ken" | "Jeremy";
export type Period = "daily" | "weekly" | "monthly";
export type View =
  | "dashboard"
  | "income"
  | "expenses"
  | "bills"
  | "installments"
  | "payouts"
  | "settings";
export type PaymentKind = "operating" | "fixed" | "installment";

export interface Profile {
  id: string;
  display_name: string;
  role: Role;
  active?: boolean;
  is_owner?: boolean;
  finance_access?: boolean;
  team_access?: boolean;
  manage_accounts?: boolean;
}
export interface Category {
  id: string;
  kind: "income" | "expense";
  name: string;
  active: boolean;
}
export interface Income {
  id: string;
  business_date: string;
  category_id: string;
  amount_cents: number;
  notes: string;
  created_at?: string;
}
export interface Expense {
  staff_payment_id?: string | null;
  id: string;
  paid_on: string;
  category_id: string;
  payment_kind: PaymentKind;
  fixed_bill_id: string | null;
  installment_id: string | null;
  due_month: string | null;
  amount_cents: number;
  reference: string;
  notes: string;
  created_at?: string;
}
export interface FixedBill {
  id: string;
  code: string;
  name: string;
  category_id: string;
  notes: string;
}
export interface BillTerm {
  id: string;
  bill_id: string;
  start_month: string;
  end_month: string | null;
  amount_cents: number;
  due_day: number;
}
export interface Installment {
  id: string;
  code: string;
  name: string;
  category_id: string;
  total_cents: number;
  monthly_cents: number;
  first_due: string;
  notes: string;
}
export interface Payout {
  id: string;
  paid_on: string;
  owner: Owner;
  settlement_month: string;
  amount_cents: number;
  reference: string;
  notes: string;
}
export interface AuditEvent {
  id: number;
  table_name: string;
  action: string;
  occurred_at: string;
}
export interface Dataset {
  categories: Category[];
  income: Income[];
  expenses: Expense[];
  bills: FixedBill[];
  terms: BillTerm[];
  installments: Installment[];
  payouts: Payout[];
  audit: AuditEvent[];
}
export type Collection =
  "categories" | "income" | "expenses" | "installments" | "payouts";
export const OWNERS: Owner[] = ["Genesis", "Ken", "Jeremy"];
export const EMPTY_DATA: Dataset = {
  categories: [],
  income: [],
  expenses: [],
  bills: [],
  terms: [],
  installments: [],
  payouts: [],
  audit: [],
};
