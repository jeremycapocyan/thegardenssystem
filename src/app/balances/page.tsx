import { FinanceApp } from "@/components/finance-app";
export const metadata = { title: "Cash & account balances" };
export default function Page() {
  return <FinanceApp view="balances" />;
}
