"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  getBackend,
  loadWorkspace,
  tables,
  friendlyError,
} from "@/lib/backend";
import { demoData, DEMO_REFERENCE, DEMO_AS_OF } from "@/lib/demo";
import { todayInManila } from "@/lib/finance";
import {
  EMPTY_DATA,
  type Collection,
  type Dataset,
  type Profile,
  type Period,
} from "@/lib/types";

type Mode =
  "loading" | "live" | "demo" | "signed-out" | "unconfigured" | "denied";
interface Workspace {
  mode: Mode;
  data: Dataset;
  profile: Profile | null;
  error: string;
  syncedAt: Date | null;
  busy: boolean;
  period: Period;
  reference: string;
  asOf: string;
  setPeriod: Dispatch<SetStateAction<Period>>;
  setReference: Dispatch<SetStateAction<string>>;
  setAsOf: Dispatch<SetStateAction<string>>;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  enterDemo: () => void;
  resetDemo: () => void;
  previewRole: (role: "admin" | "viewer") => void;
  save: (
    collection: Collection,
    values: Record<string, unknown>,
  ) => Promise<void>;
  remove: (collection: Collection | "bills", id: string) => Promise<void>;
  saveBill: (
    values: Record<string, unknown>,
    billId?: string,
    revise?: boolean,
  ) => Promise<void>;
}
const Context = createContext<Workspace | null>(null);
const DEMO_STORE = "gardens.sample.v1";
const DEMO_SESSION = "gardens.sample.active";
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("loading");
  const [data, setData] = useState<Dataset>(EMPTY_DATA);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [period, setPeriod] = useState<Period>("monthly");
  const [reference, setReference] = useState(todayInManila);
  const [asOf, setAsOf] = useState(todayInManila);
  const refreshRunning = useRef(false);
  const refresh = useCallback(async () => {
    if (refreshRunning.current) return;
    refreshRunning.current = true;
    try {
      const result = await loadWorkspace();
      setData(result.data);
      setProfile(result.profile);
      setMode("live");
      setError("");
      setSyncedAt(new Date());
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to load the workspace.";
      setError(message);
      if (message.includes("does not have access")) setMode("denied");
      else
        setMode((previous) =>
          previous === "loading" ? "signed-out" : previous,
        );
    } finally {
      refreshRunning.current = false;
    }
  }, []);
  function enterDemo() {
    let demo = demoData();
    try {
      const stored = JSON.parse(localStorage.getItem(DEMO_STORE) || "null");
      if (
        stored &&
        [
          "categories",
          "income",
          "expenses",
          "bills",
          "terms",
          "installments",
          "payouts",
          "audit",
        ].every((key) => Array.isArray(stored[key]))
      )
        demo = stored as Dataset;
    } catch {
      /* A damaged sample cache can be safely replaced with the original samples. */
    }
    sessionStorage.setItem(DEMO_SESSION, "yes");
    setPeriod("monthly");
    setReference(DEMO_REFERENCE);
    setAsOf(DEMO_AS_OF);
    setData(demo);
    setProfile({ id: "sample-jeremy", display_name: "Jeremy", role: "admin" });
    setMode("demo");
    setError("");
    setSyncedAt(new Date());
  }
  useEffect(() => {
    if (sessionStorage.getItem(DEMO_SESSION) === "yes") {
      enterDemo();
      return;
    }
    const api = getBackend();
    if (!api) {
      setMode("unconfigured");
      return;
    }
    let active = true;
    api.auth.getSession().then(({ data: auth }) => {
      if (!active) return;
      if (auth.session) void refresh();
      else setMode("signed-out");
    });
    const { data: subscription } = api.auth.onAuthStateChange(
      (event, session) => {
        if (!active) return;
        if (sessionStorage.getItem(DEMO_SESSION) === "yes") return;
        if (event === "SIGNED_OUT") {
          setMode("signed-out");
          setData(EMPTY_DATA);
          setProfile(null);
        } else if (session && event !== "INITIAL_SESSION")
          setTimeout(() => void refresh(), 0);
      },
    );
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [refresh]);
  useEffect(() => {
    if (mode !== "live") return;
    const api = getBackend();
    if (!api) return;
    let timer: ReturnType<typeof setTimeout>;
    const channel = api
      .channel("gardens-finance")
      .on("postgres_changes", { event: "*", schema: "public" }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 300);
      })
      .subscribe();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      void api.removeChannel(channel);
    };
  }, [mode, refresh]);
  function commitDemo(next: Dataset) {
    localStorage.setItem(DEMO_STORE, JSON.stringify(next));
    setData(next);
    setSyncedAt(new Date());
  }
  function assertAdmin() {
    if (profile?.role !== "admin")
      throw new Error(
        "Your account has viewing access. Jeremy manages the records.",
      );
    if (mode === "live" && !navigator.onLine)
      throw new Error("You are offline. Reconnect before saving a change.");
  }
  async function finishSave() {
    await refresh();
  }
  const value: Workspace = {
    mode,
    data,
    profile,
    error,
    syncedAt,
    busy,
    refresh,
    enterDemo,
    period,
    reference,
    asOf,
    setPeriod,
    setReference,
    setAsOf,
    async signIn(email, password) {
      const api = getBackend();
      if (!api)
        throw new Error(
          "The shared workspace is not connected yet. You can explore the sample workspace.",
        );
      setBusy(true);
      setError("");
      try {
        const result = await api.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (result.error)
          throw new Error("Unable to sign in. Check your email and password.");
        sessionStorage.removeItem(DEMO_SESSION);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    async signOut() {
      if (mode === "live" || mode === "denied") {
        const result = await getBackend()?.auth.signOut({ scope: "local" });
        if (result?.error)
          throw new Error(
            "Unable to sign out. Please reconnect and try again.",
          );
      }
      sessionStorage.removeItem(DEMO_SESSION);
      setData(EMPTY_DATA);
      setProfile(null);
      setError("");
      setPeriod("monthly");
      setReference(todayInManila());
      setAsOf(todayInManila());
      setMode(getBackend() ? "signed-out" : "unconfigured");
    },
    resetDemo() {
      if (mode !== "demo") return;
      commitDemo(demoData());
    },
    previewRole(role) {
      if (mode === "demo")
        setProfile({
          id: `sample-${role}`,
          display_name: role === "admin" ? "Jeremy" : "Genesis",
          role,
        });
    },
    async save(collection, values) {
      assertAdmin();
      if (mode === "demo") {
        const items = data[collection] as unknown as Record<string, unknown>[];
        if (
          collection === "income" &&
          items.some(
            (row) =>
              row.id !== values.id &&
              row.business_date === values.business_date &&
              row.category_id === values.category_id,
          )
        )
          throw new Error(
            "Income is already logged for this date and category. Edit the existing row.",
          );
        const exists = items.some((row) => row.id === values.id);
        commitDemo({
          ...data,
          [collection]: exists
            ? items.map((row) => (row.id === values.id ? values : row))
            : [...items, values],
        });
        return;
      }
      const api = getBackend();
      if (!api) throw new Error("The shared workspace is not connected.");
      const result = await api.from(tables[collection]).upsert(values);
      if (result.error) throw new Error(friendlyError(result.error));
      await finishSave();
    },
    async remove(collection, id) {
      assertAdmin();
      if (mode === "demo") {
        if (collection === "bills") {
          if (data.expenses.some((e) => e.fixed_bill_id === id))
            throw new Error(
              "This bill has payments. Keep it to preserve its history.",
            );
          commitDemo({
            ...data,
            bills: data.bills.filter((r) => r.id !== id),
            terms: data.terms.filter((r) => r.bill_id !== id),
          });
          return;
        }
        if (
          collection === "installments" &&
          data.expenses.some((e) => e.installment_id === id)
        )
          throw new Error(
            "This agreement has payments. Keep it to preserve its history.",
          );
        commitDemo({
          ...data,
          [collection]: data[collection].filter((row) => row.id !== id),
        });
        return;
      }
      const api = getBackend();
      if (!api) throw new Error("The shared workspace is not connected.");
      const result = await api
        .from(
          collection === "bills" ? "garden_fixed_bills" : tables[collection],
        )
        .delete()
        .eq("id", id)
        .select("id")
        .single();
      if (result.error) throw new Error(friendlyError(result.error));
      await finishSave();
    },
    async saveBill(values, billId, revise = false) {
      assertAdmin();
      if (mode === "demo") {
        const id = billId || String(values.bill_id);
        const start = String(values.start_month);
        const previous = data.terms.find(
          (t) =>
            t.bill_id === id &&
            t.start_month <= start &&
            (!t.end_month || t.end_month >= start),
        );
        if (revise && previous && start <= previous.start_month)
          throw new Error(
            "New terms must start after the previous terms started.",
          );
        const { addMonths } = await import("@/lib/finance");
        let terms = data.terms.filter(
          (t) => !(t.bill_id === id && t.id === values.term_id),
        );
        if (revise && previous)
          terms = terms.map((t) =>
            t.id === previous.id
              ? { ...t, end_month: addMonths(start, -1) }
              : t,
          );
        const end = values.end_month ? String(values.end_month) : null;
        if (
          terms.some(
            (t) =>
              t.bill_id === id &&
              t.start_month <= (end || "9999-12-01") &&
              (!t.end_month || t.end_month >= start),
          )
        )
          throw new Error(
            "These bill terms overlap an existing version. Use Change terms for a new monthly amount.",
          );
        const bill = {
          id,
          code: String(values.code),
          name: String(values.name),
          category_id: String(values.category_id),
          notes: String(values.notes || ""),
        };
        const term = {
          id: String(values.term_id),
          bill_id: id,
          start_month: start,
          end_month: end,
          amount_cents: Number(values.amount_cents),
          due_day: Number(values.due_day),
        };
        commitDemo({
          ...data,
          bills: data.bills.some((b) => b.id === id)
            ? data.bills.map((b) => (b.id === id ? bill : b))
            : [...data.bills, bill],
          terms: [...terms, term],
        });
        return;
      }
      const api = getBackend();
      if (!api) throw new Error("The shared workspace is not connected.");
      const result = await api.rpc(
        revise ? "garden_revise_bill" : "garden_save_bill",
        { p_payload: values, p_bill_id: billId || values.bill_id },
      );
      if (result.error) throw new Error(friendlyError(result.error));
      await finishSave();
    },
  };
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("WorkspaceProvider is missing.");
  return value;
}
