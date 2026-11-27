"use client";
import {
  buildOndaAccountPreview,
  applyOndaAccountRows,
  ondaEntryAccount,
  type OndaAccountPreview,
} from "@/lib/onda-accounts";
import { ACCOUNTS, type CashAccount } from "@/lib/balances";
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Upload, LoaderCircle, RefreshCw, Download } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { getBackend } from "@/lib/backend";
import { canManage } from "@/lib/access";
import { money, displayDate } from "@/lib/finance";
import { signedMoney } from "@/lib/balances";
import {
  resolvedOndaAmount,
  ondaCategory,
  type OndaContext,
  type OndaPreview,
  type OndaResolution,
} from "@/lib/onda";
import { demoOndaReport } from "@/lib/onda-demo";
type Result = {
  import_id: string;
  inserted: number;
  updated: number;
  unchanged: number;
  change_cents: number;
  source_net_cents: number;
  changes?: {
    income_id: string;
    date: string;
    kind: "BK" | "ER";
    before_cents: number | null;
    after_cents: number;
    before_notes: string;
    after_notes: string;
  }[];
};
type Preview = {
  id: string;
  filename: string;
  state: "preview" | "confirmed";
  created_at: string;
  expires_at: string;
  preview: OndaPreview;
  result: Result | null;
  already_imported?: boolean;
};
type History = {
  id: string;
  filename: string;
  state: string;
  created_at: string;
  expires_at: string;
  confirmed_at: string | null;
  start: string;
  end: string;
  net: number;
  actor_id: string;
  actor: { display_name: string } | null;
  result: Result | null;
};
type Choice = {
  mode: "" | "replace" | "manual";
  amount: string;
  replaceNotes: boolean;
};
const DEMO_STORE = "gardens.onda.sample.v1";
export function OndaImportDialog({ onClose }: { onClose: () => void }) {
  const ws = useWorkspace(),
    dialog = useRef<HTMLDialogElement>(null),
    working = useRef(false),
    uploadId = useRef(crypto.randomUUID());
  const [file, setFile] = useState<File | null>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<Preview | null>(null),
    [choices, setChoices] = useState<Record<string, Choice>>({}),
    [accounts, setAccounts] = useState<Record<string, CashAccount>>({}),
    [replaceAllocations, setReplaceAllocations] = useState(false),
    [history, setHistory] = useState<History[]>([]),
    [offset, setOffset] = useState(0),
    [hasMore, setHasMore] = useState(false);
  const demoData = () => {
    try {
      return JSON.parse(localStorage.getItem(DEMO_STORE) || "null") as {
        context: Pick<
          OndaContext,
          "transactions" | "refunds" | "days" | "links" | "entries"
        >;
        history: History[];
      } | null;
    } catch {
      return null;
    }
  };
  const demoBalances = () => {
    try {
      return JSON.parse(
        localStorage.getItem("gardens.balances.sample.v1") || "null",
      );
    } catch {
      return null;
    }
  };
  const demoContext = (): OndaContext => ({
    fingerprint: JSON.stringify({ data: ws.data, balances: demoBalances() }),
    income: ws.data.income,
    categories: ws.data.categories,
    expenses: ws.data.expenses,
    allocations: demoBalances()?.allocations || [],
    settings: demoBalances()?.settings || {
      start_date: "2026-11-01",
      cash: 0,
      bank: 0,
      booking: 0,
    },
    transactions: [],
    refunds: [],
    days: [],
    links: [],
    ...demoData()?.context,
  });
  async function response(path: string, init: RequestInit = {}) {
    if (!canManage(ws.profile, "finance"))
      throw Error("Finance management permission required.");
    if (!navigator.onLine)
      throw Error(
        "Reconnect before importing. Retry the same action after a connection failure.",
      );
    const auth = await getBackend()?.auth.getSession();
    if (!auth?.data.session) throw Error("Sign in again.");
    return fetch("/api/finance/imports/onda/" + path, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${auth.data.session.access_token}`,
      },
      cache: "no-store",
    });
  }
  async function request(path: string, init: RequestInit = {}) {
    const r = await response(path, init),
      data = await r.json().catch(() => ({
        message:
          r.status === 413
            ? "Choose a PDF smaller than 4 MB."
            : "The request could not be completed. Retry or refresh.",
      }));
    if (!r.ok) throw Error(data.message || "Unable to import.");
    return data;
  }
  async function run(action: string, fn: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(action);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The import could not be completed.",
      );
    } finally {
      setBusy("");
      working.current = false;
    }
  }
  const loadHistory = useCallback(
    async (page = 0) => {
      if (ws.mode === "demo") {
        setHistory(demoData()?.history || []);
        setHasMore(false);
        return;
      }
      const r = await request(`?offset=${page}`);
      setHistory(r.imports);
      setHasMore(r.next_offset !== null);
      setOffset(page);
      // The dialog's account stays fixed; server permissions are rechecked per request.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [ws.mode, ws.profile?.id],
  );
  useEffect(() => {
    dialog.current?.showModal();
    void run("history", () => loadHistory());
  }, []);
  function show(p: Preview) {
    setPreview(p);
    setChoices({});
    setAccounts({});
    setReplaceAllocations(false);
  }
  async function upload(event: React.FormEvent) {
    event.preventDefault();
    await run("upload", async () => {
      if (!file) throw Error("Choose an Onda PDF.");
      if (file.size > 4000000) throw Error("Choose a PDF smaller than 4 MB.");
      const data = new FormData();
      data.set("file", file);
      data.set("id", uploadId.current);
      show(await request("preview/", { method: "POST", body: data }));
      await loadHistory();
    });
  }
  function sample() {
    void run("sample", async () => {
      const ctx = demoContext(),
        parsed = demoOndaReport();
      show({
        id: crypto.randomUUID(),
        filename: "Fictional Onda sample.pdf",
        state: "preview",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 1800000).toISOString(),
        preview: buildOndaAccountPreview(parsed, ctx),
        result: null,
      });
      demoFingerprint.current = ctx.fingerprint;
    });
  }
  const demoFingerprint = useRef("");
  async function refresh(id = preview?.id) {
    if (!id) return;
    await run("refresh", async () => {
      if (ws.mode === "demo") {
        sampleRefresh();
        return;
      }
      show(await request(`${id}/refresh/`, { method: "POST" }));
      await loadHistory();
    });
  }
  function sampleRefresh() {
    const ctx = demoContext();
    show({
      ...preview!,
      preview: buildOndaAccountPreview(demoOndaReport(), ctx),
      state: "preview",
      expires_at: new Date(Date.now() + 1800000).toISOString(),
      result: null,
    });
    demoFingerprint.current = ctx.fingerprint;
  }
  function resolve() {
    const result: Record<string, OndaResolution> = {};
    for (const p of preview?.preview.proposals || []) {
      const c = choices[p.key];
      if (c?.mode)
        result[p.key] = {
          mode: c.mode,
          ...(c.mode === "manual"
            ? { amount_cents: signedMoney(c.amount) }
            : {}),
          replace_notes: c.replaceNotes,
        };
      else if (c?.replaceNotes)
        result[p.key] = {
          mode: "manual",
          amount_cents: p.manual_amount,
          replace_notes: true,
        };
    }
    return result;
  }
  let valid = true,
    change = 0;
  const calculated = new Map<
    string,
    { amount: number | null; message: string }
  >();
  if (preview) {
    for (const p of preview.preview.proposals) {
      try {
        const c = choices[p.key],
          r = c?.mode
            ? {
                mode: c.mode,
                amount_cents:
                  c.mode === "manual" ? signedMoney(c.amount) : undefined,
                replace_notes: c.replaceNotes,
              }
            : undefined;
        const amount = resolvedOndaAmount(p, r);
        calculated.set(p.key, { amount, message: "" });
        change += amount - (p.old_amount || 0);
      } catch (e) {
        valid = false;
        calculated.set(p.key, {
          amount: null,
          message: e instanceof Error ? e.message : "Resolve this row.",
        });
      }
    }
  }
  async function confirm() {
    if (!preview) return;
    await run("confirm", async () => {
      const resolutions = resolve();
      if (preview.preview.encoding_version === 2) {
        for (const e of preview.preview.entries || [])
          ondaEntryAccount(e, accounts);
        if (
          (preview.preview.replaced_allocations || 0) > 0 &&
          !replaceAllocations
        )
          throw Error(
            "Review replacement of existing daily account assignments.",
          );
      }
      for (const p of preview.preview.proposals)
        resolvedOndaAmount(p, resolutions[p.key]);
      if (ws.mode === "demo") {
        if (demoContext().fingerprint !== demoFingerprint.current)
          throw Error("Records changed after preview. Refresh it.");
        const ctx = demoContext(),
          data = ws.data.income.slice(),
          links = ctx.links.slice();
        let inserted = 0,
          updated = 0,
          unchanged = 0,
          delta = 0;
        for (const p of preview.preview.proposals) {
          const r = resolutions[p.key],
            amount = resolvedOndaAmount(p, r),
            notes = r?.replace_notes ? p.generated_notes : p.notes,
            id = p.income_id || crypto.randomUUID(),
            index = data.findIndex((i) => i.id === id);
          if (index < 0) {
            data.push({
              id,
              business_date: p.date,
              category_id: p.category_id,
              amount_cents: amount,
              notes,
            });
            inserted++;
          } else if (
            data[index].amount_cents !== amount ||
            data[index].notes !== notes
          ) {
            data[index] = { ...data[index], amount_cents: amount, notes };
            updated++;
          } else unchanged++;
          delta += amount - (p.old_amount || 0);
          const link = {
            business_date: p.date,
            category_id: p.category_id,
            income_id: id,
            source_amount: p.source_amount,
            manual_amount: amount - p.source_amount,
            last_amount: amount,
            last_notes: notes,
            generated_notes: p.generated_notes,
          };
          const n = links.findIndex(
            (l) =>
              l.business_date === p.date && l.category_id === p.category_id,
          );
          if (n < 0) links.push(link);
          else links[n] = link;
        }
        let accountResult: ReturnType<typeof applyOndaAccountRows> | undefined;
        if (preview.preview.encoding_version === 2) {
          accountResult = applyOndaAccountRows(
            data,
            ctx.allocations as import("@/lib/balances").CashAllocation[],
            ctx.entries || [],
            preview.preview as OndaAccountPreview,
            accounts,
            Object.fromEntries(
              preview.preview.proposals.map((p) => [
                p.key,
                resolvedOndaAmount(p, resolutions[p.key]) - p.source_amount,
              ]),
            ),
          );
          const cash = demoBalances() || {
            settings: ctx.settings,
            movements: [],
          };
          localStorage.setItem(
            "gardens.balances.sample.v1",
            JSON.stringify({ ...cash, allocations: accountResult.allocations }),
          );
          inserted = (preview.preview.entries || []).filter(
            (e) => !e.income_id,
          ).length;
          updated = (preview.preview.entries || []).filter((e) => {
            const old = ctx.entries?.find((l) => l.key === e.key);
            return (
              old &&
              (old.last_amount !== e.amount_cents ||
                old.last_notes !== e.notes ||
                old.account !== ondaEntryAccount(e, accounts))
            );
          }).length;
          unchanged =
            (preview.preview.entries || []).length - inserted - updated;
        }
        const result = {
          import_id: preview.id,
          inserted,
          updated,
          unchanged,
          change_cents: delta,
          source_net_cents: preview.preview.report.net,
        };
        const combine = <T,>(
          old: T[],
          incoming: T[],
          key: (v: T) => string,
        ) => [
          ...old.filter((o) => !incoming.some((i) => key(i) === key(o))),
          ...incoming,
        ];
        const record: History = {
          id: preview.id,
          filename: preview.filename,
          state: "confirmed",
          created_at: preview.created_at,
          expires_at: preview.expires_at,
          confirmed_at: new Date().toISOString(),
          start: preview.preview.report.start,
          end: preview.preview.report.end,
          net: preview.preview.report.net,
          actor_id: ws.profile!.id,
          actor: { display_name: ws.profile!.display_name },
          result,
        };
        localStorage.setItem(
          DEMO_STORE,
          JSON.stringify({
            context: {
              transactions: combine(
                ctx.transactions,
                preview.preview.transactions,
                (t) => t.data.reference,
              ),
              refunds: combine(
                ctx.refunds,
                preview.preview.refunds,
                (r) => r.data.identity,
              ),
              days: combine(
                ctx.days,
                preview.preview.days,
                (d) => d.day + "/" + d.kind,
              ),
              links,
              entries: accountResult?.entries || ctx.entries || [],
            },
            history: [record, ...history],
          }),
        );
        ws.commitDemoIncome(data);
        setPreview({ ...preview, state: "confirmed", result });
        await loadHistory();
        return;
      }
      const result = await request(`${preview.id}/confirm/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resolutions,
          accounts,
          replace_allocations: replaceAllocations,
        }),
      });
      setPreview({ ...preview, state: "confirmed", result });
      await ws.refresh();
      await loadHistory();
    });
  }
  async function download(id: string) {
    await run("download", async () => {
      const r = await response(`${id}/pdf/`);
      if (!r.ok) {
        const b = await r.json();
        throw Error(b.message || "Unable to download.");
      }
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = `Onda-import-${id}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  const setChoice = (key: string, value: Partial<Choice>) =>
    setChoices((old) => ({
      ...old,
      [key]: {
        ...(old[key] || { mode: "", amount: "", replaceNotes: false }),
        ...value,
      },
    }));
  return (
    <dialog
      ref={dialog}
      className="record-dialog onda-dialog"
      aria-labelledby="onda-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="onda-header">
        <div>
          <span className="eyebrow">THE GARDENS · INCOME</span>
          <h2 id="onda-title">Upload Onda PDF</h2>
          <p>Upload → Review changes → Resolve conflicts → Confirm Import</p>
        </div>
        <button
          className="icon-button"
          aria-label="Close Onda import"
          disabled={!!busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="onda-body">
        <p className="onda-notice">
          Each imported transaction updates Income and its selected account
          once. Onda fees and cash returns already reduce net receipts; no
          additional expense is created.
        </p>
        {error && (
          <div className="error-box" role="alert">
            {error}
          </div>
        )}
        {ws.mode === "demo" ? (
          <div className="onda-notice">
            <p>
              Fictional sample workspace. Real PDFs require a live Finance admin
              login. Sample imports stay in this browser.
            </p>
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={sample}
            >
              Load sample Onda report
            </button>
          </div>
        ) : (
          <form className="onda-upload" onSubmit={upload}>
            <label className="field">
              <span>Onda Transaction Export PDF</span>
              <input
                type="file"
                accept=".pdf,application/pdf"
                disabled={!!busy}
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  uploadId.current = crypto.randomUUID();
                  setPreview(null);
                  setChoices({});
                  setError("");
                }}
              />
              <small>
                One original text-based PDF, up to 4 MB / 100 pages. Scans and
                password-protected reports are unsupported.
              </small>
            </label>
            <button className="button primary" disabled={!!busy || !file}>
              {busy === "upload" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Upload size={16} />
              )}{" "}
              Read and preview
            </button>
          </form>
        )}
        {busy && (
          <p role="status">
            {busy === "upload"
              ? "Reading and validating the PDF…"
              : busy === "confirm"
                ? "Confirming import…"
                : "Loading…"}
          </p>
        )}
        {preview && (
          <section aria-label="Onda import preview" className="onda-preview">
            <div className="panel-heading">
              <div>
                <h3>{preview.filename}</h3>
                <p>
                  {displayDate(preview.preview.report.start)} –{" "}
                  {displayDate(preview.preview.report.end)} · Generated{" "}
                  {new Date(preview.preview.report.generatedAt).toLocaleString(
                    "en-PH",
                    { timeZone: "Asia/Manila" },
                  )}{" "}
                  Manila
                </p>
              </div>
              {preview.state === "preview" && (
                <button
                  className="button secondary"
                  disabled={!!busy}
                  onClick={() => void refresh()}
                >
                  <RefreshCw size={15} />
                  Refresh preview
                </button>
              )}
            </div>
            <div className="onda-totals">
              {[
                ["Gross", preview.preview.report.gross],
                ["Onda fees", preview.preview.report.fees],
                ["Cash returned", preview.preview.report.cashReturned],
                ["Source net income", preview.preview.report.net],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <small>{label}</small>
                  <strong>{money(Number(value))}</strong>
                </div>
              ))}
            </div>
            <p>
              {preview.preview.report.rows} source rows ·{" "}
              {preview.preview.report.excluded.length} excluded ·{" "}
              {preview.preview.olderIgnored} older versions ignored
            </p>
            {preview.already_imported && (
              <p className="onda-notice" role="status">
                This exact file was already imported. No duplicate income has
                been added.
              </p>
            )}
            {preview.preview.blockers.map((b, i) => (
              <p className="error-box" key={i}>
                {b}
              </p>
            ))}
            {preview.preview.warnings.map((b, i) => (
              <p className="onda-notice" key={i}>
                {b}
              </p>
            ))}
            {preview.state === "confirmed" ? (
              <div className="onda-success" role="status">
                <strong>Import confirmed</strong>
                <p>
                  {preview.result?.inserted || 0} new ·{" "}
                  {preview.result?.updated || 0} updated ·{" "}
                  {preview.result?.unchanged || 0} unchanged. Income change:{" "}
                  {money(preview.result?.change_cents || 0)}.
                </p>
              </div>
            ) : (
              <>
                {preview.preview.encoding_version === 2 && (
                  <section
                    className="onda-transactions"
                    aria-label="Transaction account preview"
                  >
                    <h3>Individual transactions and accounts</h3>
                    <p>
                      Cash → Cash. QRPH → Booking System. Fees are already
                      included in net receipts. Cash returns reduce Cash.
                      Transactions before {preview.preview.opening_date} are
                      kept in Income but do not post over the opening balances.
                    </p>
                    <div className="table-scroll">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Date / reference</th>
                            <th>Method</th>
                            <th>Net income</th>
                            <th>Account</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(preview.preview.entries || []).map((e) => (
                            <tr key={e.key}>
                              <td>
                                {e.date}
                                <small>{e.reference}</small>
                                {e.before_opening && (
                                  <small>
                                    Before opening · no balance posting
                                  </small>
                                )}
                              </td>
                              <td>{e.method}</td>
                              <td>{money(e.amount_cents)}</td>
                              <td>
                                <select
                                  aria-label={`Account ${e.key}`}
                                  value={accounts[e.key] || e.account || ""}
                                  disabled={!!busy}
                                  onChange={(event) =>
                                    setAccounts((old) => ({
                                      ...old,
                                      [e.key]: event.target
                                        .value as CashAccount,
                                    }))
                                  }
                                >
                                  <option value="">Choose account</option>
                                  {Object.entries(ACCOUNTS).map(
                                    ([value, label]) => (
                                      <option key={value} value={value}>
                                        {label}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {(preview.preview.replaced_allocations || 0) > 0 && (
                      <label className="partner-check">
                        <input
                          type="checkbox"
                          checked={replaceAllocations}
                          onChange={(event) =>
                            setReplaceAllocations(event.target.checked)
                          }
                        />
                        Replace the {preview.preview.replaced_allocations}{" "}
                        existing daily account assignment(s) with these
                        transaction accounts. No additional income is created.
                      </label>
                    )}
                    <p>
                      Daily rows below reconcile totals only. The saved Income
                      entries will be individual transactions.
                    </p>
                  </section>
                )}
                <div className="table-scroll">
                  <table className="data-table onda-table">
                    <thead>
                      <tr>
                        <th>Date / category</th>
                        <th>Existing total</th>
                        <th>Onda total</th>
                        <th>Status / reconciliation</th>
                        <th>Proposed total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.preview.proposals.map((p) => (
                        <tr key={p.key}>
                          <td>
                            {displayDate(p.date)}
                            <small>{ondaCategory(p.kind)}</small>
                          </td>
                          <td>
                            {p.old_amount === null
                              ? "No entry"
                              : money(p.old_amount)}
                          </td>
                          <td>{money(p.source_amount)}</td>
                          <td>
                            <strong>
                              {p.status === "conflict"
                                ? "Manual income needs review"
                                : p.status}
                            </strong>
                            {p.conflict && (
                              <div className="onda-choice">
                                <label>
                                  <span>
                                    How should this total be reconciled?
                                  </span>
                                  <select
                                    aria-label={`Reconcile ${p.date} ${ondaCategory(p.kind)}`}
                                    disabled={!!busy}
                                    value={choices[p.key]?.mode || ""}
                                    onChange={(e) =>
                                      setChoice(p.key, {
                                        mode: e.target.value as Choice["mode"],
                                      })
                                    }
                                  >
                                    <option value="">Choose…</option>
                                    <option value="replace">
                                      Use Onda total
                                    </option>
                                    <option value="manual">
                                      Keep income outside Onda
                                    </option>
                                  </select>
                                </label>
                                {choices[p.key]?.mode === "manual" && (
                                  <label>
                                    <span>
                                      Separate amount outside Onda (₱)
                                    </span>
                                    <input
                                      aria-label={`Outside Onda ${p.date} ${ondaCategory(p.kind)}`}
                                      inputMode="decimal"
                                      disabled={!!busy}
                                      value={choices[p.key]?.amount || ""}
                                      onChange={(e) =>
                                        setChoice(p.key, {
                                          amount: e.target.value,
                                        })
                                      }
                                    />
                                    <small>
                                      Enter only the extra amount, not the
                                      entire existing daily total.
                                    </small>
                                  </label>
                                )}
                              </div>
                            )}
                            <label className="onda-note-choice">
                              <input
                                type="checkbox"
                                disabled={!!busy}
                                checked={choices[p.key]?.replaceNotes || false}
                                onChange={(e) =>
                                  setChoice(p.key, {
                                    replaceNotes: e.target.checked,
                                  })
                                }
                              />
                              Use transaction highlights for Notes
                            </label>
                            <small>Highlights: {p.generated_notes}</small>
                          </td>
                          <td>
                            {preview.preview.encoding_version === 2 &&
                              calculated.get(p.key)?.amount != null &&
                              p.date >= (preview.preview.opening_date || "") &&
                              (calculated.get(p.key)?.amount || 0) -
                                p.source_amount !==
                                0 && (
                                <label>
                                  Account for income outside Onda
                                  <select
                                    aria-label={`Manual account ${p.key}`}
                                    value={accounts[`manual:${p.key}`] || ""}
                                    onChange={(e) =>
                                      setAccounts((old) => ({
                                        ...old,
                                        [`manual:${p.key}`]: e.target
                                          .value as CashAccount,
                                      }))
                                    }
                                  >
                                    <option value="">Choose account</option>
                                    {Object.entries(ACCOUNTS).map(
                                      ([value, label]) => (
                                        <option key={value} value={value}>
                                          {label}
                                        </option>
                                      ),
                                    )}
                                  </select>
                                </label>
                              )}
                            <strong>
                              {calculated.get(p.key)?.amount === null
                                ? "Choose resolution"
                                : money(calculated.get(p.key)?.amount || 0)}
                            </strong>
                            {calculated.get(p.key)?.message && (
                              <small>{calculated.get(p.key)?.message}</small>
                            )}
                          </td>
                        </tr>
                      ))}
                      {!preview.preview.proposals.length && (
                        <tr>
                          <td colSpan={5}>
                            No daily income changes are needed.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="onda-confirm">
                  <p>
                    <strong>
                      Proposed tracker change:{" "}
                      {valid ? money(change) : "Resolve conflicts above"}
                    </strong>
                    <small>
                      Every unresolved conflict must be reviewed. Confirming
                      uses the current preview; changed records require a fresh
                      preview.
                    </small>
                  </p>
                  <button
                    className="button primary"
                    disabled={
                      !!busy || !valid || preview.preview.blockers.length > 0
                    }
                    onClick={() => void confirm()}
                  >
                    Confirm Import
                  </button>
                </div>
              </>
            )}
            <details>
              <summary>
                Excluded source rows ({preview.preview.report.excluded.length})
              </summary>
              <ul>
                {preview.preview.report.excluded.map((e, i) => (
                  <li key={i}>
                    {e.reference} — {e.reason}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        )}
        <section className="onda-history">
          <div className="panel-heading">
            <h3>Import history</h3>
            <button
              className="button secondary compact"
              disabled={!!busy}
              onClick={() => void run("history", () => loadHistory(offset))}
            >
              Refresh history
            </button>
          </div>
          {!history.length ? (
            <p>No imports yet.</p>
          ) : (
            <div className="table-scroll">
              <table className="data-table onda-table">
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Uploaded / admin</th>
                    <th>Status</th>
                    <th>Outcome</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>
                        {h.filename}
                        <small>
                          {h.start} – {h.end}
                        </small>
                      </td>
                      <td>
                        {new Date(h.created_at).toLocaleString("en-PH", {
                          timeZone: "Asia/Manila",
                        })}
                        <small>
                          {h.actor?.display_name || "Finance admin"}
                        </small>
                      </td>
                      <td>
                        {h.state === "confirmed"
                          ? "Confirmed"
                          : new Date(h.expires_at).valueOf() < Date.now()
                            ? "Expired preview"
                            : "Preview only"}
                      </td>
                      <td>
                        {h.result
                          ? `${h.result.inserted} new / ${h.result.updated} updated / ${h.result.unchanged} unchanged`
                          : "No income changes saved"}
                        {!!h.result?.changes?.length && (
                          <details>
                            <summary>View income changes</summary>
                            <ul>
                              {h.result.changes.map((c) => (
                                <li key={c.income_id}>
                                  {displayDate(c.date)} · {ondaCategory(c.kind)}
                                  :{" "}
                                  {c.before_cents === null
                                    ? "New entry"
                                    : money(c.before_cents)}{" "}
                                  → {money(c.after_cents)}
                                  {c.before_notes !== c.after_notes ? (
                                    <small>
                                      Notes: {c.after_notes || "(empty)"}
                                    </small>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td>
                        {ws.mode === "live" && (
                          <>
                            <button
                              className="text-button"
                              disabled={!!busy}
                              onClick={() => void download(h.id)}
                            >
                              <Download size={13} /> Original PDF
                            </button>
                            {h.state !== "confirmed" &&
                              h.actor_id === ws.profile?.id && (
                                <button
                                  className="text-button"
                                  disabled={!!busy}
                                  onClick={() => void refresh(h.id)}
                                >
                                  Review preview
                                </button>
                              )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {ws.mode === "live" && (
            <div className="onda-pagination">
              <button
                className="button secondary"
                disabled={!!busy || offset === 0}
                onClick={() =>
                  void run("history", () =>
                    loadHistory(Math.max(0, offset - 20)),
                  )
                }
              >
                Previous
              </button>
              <button
                className="button secondary"
                disabled={!!busy || !hasMore}
                onClick={() =>
                  void run("history", () => loadHistory(offset + 20))
                }
              >
                Next
              </button>
            </div>
          )}
        </section>
      </div>
      <div className="dialog-footer">
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
