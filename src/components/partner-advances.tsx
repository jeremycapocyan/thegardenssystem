"use client";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Plus, X, RefreshCw, LoaderCircle, Download } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { canManage } from "@/lib/access";
import { getBackend, friendlyError } from "@/lib/backend";
import {
  money,
  displayDate,
  displayMonth,
  monthStart,
  todayInManila,
  parseMoney,
  installmentSummary,
  csv,
} from "@/lib/finance";
import { OWNERS, type Owner } from "@/lib/types";
import { ACCOUNTS, demoCash, type CashData } from "@/lib/balances";
import {
  emptyPartners,
  partnerDebtBalances,
  parseRecoveryRate,
  previewPartnerSettlement,
  type PartnerPreview,
} from "@/lib/partners";
import { applyPartnerDemo } from "@/lib/partners-demo";
type FormKind =
  | "purchase"
  | "reimburse"
  | "funding_draft"
  | "fund"
  | "rule"
  | "settle"
  | "void_reimbursement"
  | "void_funding"
  | "reverse_settlement";
type OpenForm = { kind: FormKind; record?: string; preview?: PartnerPreview };
const BALANCES = "gardens.balances.sample.v1";
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
const titles: Record<FormKind, string> = {
  purchase: "Partner-funded purchase",
  reimburse: "Record reimbursement",
  funding_draft: "Capital advance to partners",
  fund: "Record supplier payment",
  rule: "Set recovery percentage",
  settle: "Confirm monthly owner settlement",
  void_reimbursement: "Correct a reimbursement record",
  void_funding: "Correct a capital funding record",
  reverse_settlement: "Reverse owner settlement",
};
export function PartnerAdvanceSummary() {
  const ws = useWorkspace(),
    p = ws.data.partners || emptyPartners(),
    debts = partnerDebtBalances(p, ws.asOf),
    owed = p.purchases.reduce((n, v) => {
      const a = ws.data.installments.find((a) => a.id === v.id);
      return (
        n +
        (a && v.purchased_on <= ws.asOf
          ? installmentSummary(ws.data, a, ws.asOf).remaining
          : 0)
      );
    }, 0);
  if (!p.purchases.length && !p.fundings.length) return null;
  return (
    <section className="panel partner-summary">
      <div>
        <span className="eyebrow">
          PARTNER ADVANCES · AS OF {displayDate(ws.asOf)}
        </span>
        <h2>Two balances, kept separate.</h2>
      </div>
      <div>
        <span>Gardens owes partners</span>
        <strong>{money(owed)}</strong>
        <Link href="/installments/#partner-advances">View reimbursements</Link>
      </div>
      <div>
        <span>Partners owe Gardens</span>
        <strong>{money(debts.reduce((n, d) => n + d.remaining, 0))}</strong>
        <Link href="/owner-payouts/#partner-advances">
          View capital recovery
        </Link>
      </div>
    </section>
  );
}
export function PartnerAdvances({
  section,
  month,
}: {
  section: "purchases" | "capital";
  month: string;
}) {
  const ws = useWorkspace(),
    p = ws.data.partners || emptyPartners(),
    admin = canManage(ws.profile, "finance");
  const [form, setForm] = useState<OpenForm | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [preview, setPreview] = useState<PartnerPreview | null>(null);
  const working = useRef(false),
    today =
      ws.mode === "demo"
        ? ws.asOf > todayInManila()
          ? ws.asOf
          : todayInManila()
        : todayInManila();
  const balances = (): CashData => {
    const saved = JSON.parse(localStorage.getItem(BALANCES) || "null");
    return { ...demoCash(ws.data), ...saved, finance: ws.data };
  };
  async function command(
    action: string,
    id: string,
    payload: Record<string, unknown>,
  ) {
    if (!admin) throw Error("Finance management permission required.");
    if (ws.mode === "demo") {
      const next = applyPartnerDemo(
        ws.data,
        balances(),
        action,
        id,
        payload,
        today,
      );
      localStorage.setItem(
        BALANCES,
        JSON.stringify({ ...next.balances, finance: undefined }),
      );
      ws.commitDemoFinance(next.data);
      return next.result;
    }
    if (ws.mode !== "live" || !navigator.onLine)
      throw Error(
        "Reconnect before saving. Retry the same action if a response was lost.",
      );
    const r = await getBackend()!.rpc("garden_partner_command", {
      p_action: action,
      p_id: id,
      p_payload: payload,
    });
    if (r.error) {
      const e = new Error(friendlyError(r.error)) as Error & { code?: string };
      e.code = r.error.code;
      throw e;
    }
    return r.data;
  }
  async function review() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (!admin) throw Error("Finance management permission required.");
      if (ws.mode === "demo")
        setPreview(previewPartnerSettlement(ws.data, month, today));
      else {
        const r = await getBackend()!.rpc("garden_partner_preview", {
          p_month: month,
        });
        if (r.error) throw Error(friendlyError(r.error));
        setPreview(r.data);
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to preview settlement.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    setPreview(null);
  }, [month, ws.syncedAt]);
  const open = (next: OpenForm) => {
    setForm(next);
    setError("");
    setNotice("");
  };
  const debts = partnerDebtBalances(p, ws.asOf),
    statements = p.settlements
      .filter((s) => s.month === month)
      .sort((a, b) => b.confirmed_at.localeCompare(a.confirmed_at));
  function exportCsv() {
    const rows: (string | number)[][] =
      section === "purchases"
        ? [
            [
              "Partner-funded purchases",
              "Partner",
              "Purchase date",
              "Total PHP",
              "Paid PHP",
              "Remaining PHP",
            ],
            ...p.purchases.flatMap((v) => {
              const a = ws.data.installments.find((a) => a.id === v.id);
              if (!a) return [];
              const s = installmentSummary(ws.data, a, ws.asOf);
              return [
                [
                  a.name,
                  v.owner,
                  v.purchased_on,
                  a.total_cents / 100,
                  s.paid / 100,
                  s.remaining / 100,
                ],
              ];
            }),
          ]
        : [
            [
              "Capital advance",
              "Supplier",
              "Partner",
              "State",
              "Funded on",
              "Allocated PHP",
              "Recovered PHP",
              "Remaining PHP",
            ],
            ...debts.map((d) => [
              d.funding.purpose,
              d.funding.supplier,
              d.owner,
              d.funding.state,
              d.funding.funded_on || "",
              d.amount_cents / 100,
              d.recovered / 100,
              d.remaining / 100,
            ]),
            [],
            [
              "Settlement month",
              "Owner",
              "Gross entitlement PHP",
              "Capital withheld PHP",
              "Net entitlement PHP",
              "Confirmed",
              "Reversed",
            ],
            ...p.settlements.flatMap((s) =>
              s.snapshot.owners.map((o) => [
                s.month,
                o.owner,
                o.entitlement / 100,
                o.withheld / 100,
                (o.entitlement - o.withheld) / 100,
                s.confirmed_at,
                s.reversed_at || "",
              ]),
            ),
          ];
    const url = URL.createObjectURL(
      new Blob([csv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `The-Gardens-Partner-${section}-${ws.asOf}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function loadSamples() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      let data = ws.data,
        cash = balances();
      if (!cash.settings)
        cash.settings = {
          start_date: "2026-11-01",
          cash: 20000000,
          bank: 0,
          booking: 0,
        };
      const cat = data.categories.find(
        (c) => c.kind === "expense" && c.active,
      )!.id;
      for (const [action, payload] of [
        [
          "purchase",
          {
            owner: "Genesis",
            purchased_on: "2026-11-01",
            name: "SAMPLE Linix Sweeper",
            category_id: cat,
            total_cents: 2500000,
            monthly_cents: 500000,
            first_due: "2026-11-30",
          },
        ],
        [
          "funding_draft",
          {
            supplier: "SAMPLE Supplier",
            purpose: "SAMPLE capital advance",
            total_cents: 11200000,
            start_month: "2026-11-01",
            partners: [
              { owner: "Genesis", amount_cents: 5600000, rate_bps: 5000 },
              { owner: "Ken", amount_cents: 5600000, rate_bps: 5000 },
            ],
          },
        ],
      ] as [string, Record<string, unknown>][]) {
        const next = applyPartnerDemo(
          data,
          cash,
          action,
          crypto.randomUUID(),
          payload,
          today,
        );
        data = next.data;
        cash = next.balances;
      }
      localStorage.setItem(
        BALANCES,
        JSON.stringify({ ...cash, finance: undefined }),
      );
      ws.commitDemoFinance(data);
      setNotice(
        "Fictional purchase and draft funding loaded. No live records were changed.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to load samples.");
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel partner-panel" id="partner-advances">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">PARTNER ADVANCES</span>
          <h2>
            {section === "purchases"
              ? "Gardens owes partners"
              : "Capital advances to partners"}
          </h2>
          <p>
            {section === "purchases"
              ? "Record purchases funded by a partner. Only actual reimbursements reduce business profit."
              : "Supplier funding reduces account funds. Recovery comes from owner shares and creates no new income."}
          </p>
        </div>
        <div className="heading-actions">
          <button className="button secondary compact" onClick={exportCsv}>
            <Download size={15} />
            Export CSV
          </button>
          {admin && (
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                open({
                  kind: section === "purchases" ? "purchase" : "funding_draft",
                })
              }
            >
              <Plus size={16} />
              {section === "purchases"
                ? "Partner-funded purchase"
                : "Add capital advance"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {ws.mode === "demo" &&
        !p.purchases.length &&
        !p.fundings.length &&
        admin && (
          <div className="notice">
            <p>
              Try the ₱25,000 sweeper and ₱112,000 capital examples in this
              isolated sample workspace. Sample opening cash of ₱200,000 is
              added only if no sample balance is configured.
            </p>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void loadSamples()}
            >
              Load fictional examples
            </button>
          </div>
        )}
      {section === "purchases" ? (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Purchase / partner</th>
                  <th>Monthly</th>
                  <th>Reimbursed</th>
                  <th>Still owed</th>
                  <th>Next due / status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {p.purchases.map((v) => {
                  const a = ws.data.installments.find((a) => a.id === v.id);
                  if (!a) return null;
                  const s = installmentSummary(ws.data, a, ws.asOf);
                  return (
                    <tr key={v.id}>
                      <td>
                        <strong>{a.name}</strong>
                        <small>
                          {v.owner} · {displayDate(v.purchased_on)}
                        </small>
                      </td>
                      <td>{money(a.monthly_cents)}</td>
                      <td>{money(s.paid)}</td>
                      <td>{money(s.remaining)}</td>
                      <td>
                        {s.next ? displayDate(s.next) : "Completed"}
                        <small>
                          {s.status}
                          {s.overdue > 0
                            ? ` · ${money(s.overdue)} overdue`
                            : ""}
                        </small>
                      </td>
                      <td>
                        {admin && s.remaining > 0 && (
                          <button
                            className="text-button"
                            onClick={() =>
                              open({ kind: "reimburse", record: v.id })
                            }
                          >
                            Record reimbursement
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {!p.purchases.length && (
                  <tr>
                    <td colSpan={6}>
                      No partner-funded purchases. Existing installment
                      agreements remain unchanged.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!!p.payments.length && (
            <details>
              <summary>Reimbursement records and corrections</summary>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Payment date</th>
                      <th>Purchase</th>
                      <th>Amount / account</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.payments.map((v) => (
                      <tr key={v.id}>
                        <td>{displayDate(v.detail.paid_on)}</td>
                        <td>
                          {
                            ws.data.installments.find(
                              (a) => a.id === v.installment_id,
                            )?.name
                          }
                        </td>
                        <td>
                          {money(v.detail.amount_cents)}
                          <small>
                            {
                              ACCOUNTS[
                                v.detail.account as keyof typeof ACCOUNTS
                              ]
                            }
                          </small>
                        </td>
                        <td>
                          {v.voided_at ? "Corrected / void" : "Recorded"}
                          {v.void_reason && <small>{v.void_reason}</small>}
                        </td>
                        <td>
                          {admin && !v.voided_at && (
                            <button
                              className="text-button"
                              onClick={() =>
                                open({
                                  kind: "void_reimbursement",
                                  record: v.id,
                                })
                              }
                            >
                              Void incorrect record
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Supplier / purpose</th>
                  <th>Total funding</th>
                  <th>Funded / recovery start</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {p.fundings.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <strong>{f.supplier}</strong>
                      <small>{f.purpose}</small>
                    </td>
                    <td>{money(f.total_cents)}</td>
                    <td>
                      {f.funded_on ? displayDate(f.funded_on) : "Not paid"}
                      <small>Recovery from {displayMonth(f.start_month)}</small>
                    </td>
                    <td>
                      {f.state}
                      {f.void_reason && <small>{f.void_reason}</small>}
                    </td>
                    <td>
                      {admin && f.state === "draft" && (
                        <button
                          className="text-button"
                          onClick={() => open({ kind: "fund", record: f.id })}
                        >
                          Record supplier payment
                        </button>
                      )}
                      {admin && f.state !== "void" && (
                        <button
                          className="text-button"
                          onClick={() =>
                            open({ kind: "void_funding", record: f.id })
                          }
                        >
                          Void incorrect record
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!p.fundings.length && (
                  <tr>
                    <td colSpan={5}>
                      No capital advances. Drafts do not create debt recoveries
                      or cash movements.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!!debts.length && (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Partner / advance</th>
                    <th>Allocated</th>
                    <th>Recovered</th>
                    <th>Still owed</th>
                    <th>Funding status</th>
                  </tr>
                </thead>
                <tbody>
                  {debts.map((d) => (
                    <tr key={d.id}>
                      <td>
                        {d.owner}
                        <small>{d.funding.purpose}</small>
                      </td>
                      <td>{money(d.amount_cents)}</td>
                      <td>{money(d.recovered)}</td>
                      <td>{money(d.remaining)}</td>
                      <td>
                        {d.funding.state === "draft"
                          ? "Awaiting supplier payment"
                          : d.funding.state === "void"
                            ? "Voided"
                            : d.remaining === 0
                              ? "Cleared"
                              : "Funded"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="partner-subheading">
            <div>
              <h3>Recovery percentages</h3>
              <p>
                One rate per partner applies across their active capital debts,
                oldest funded debt first. Rates may be 0% to pause recovery.
              </p>
            </div>
            {admin && (
              <button
                className="button secondary"
                onClick={() => open({ kind: "rule" })}
              >
                Set recovery percentage
              </button>
            )}
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Partner</th>
                  <th>Effective month</th>
                  <th>Percentage of their share</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {p.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.owner}</td>
                    <td>{displayMonth(r.effective_month)}</td>
                    <td>{(r.rate_bps / 100).toFixed(2)}%</td>
                    <td>{r.reason}</td>
                  </tr>
                ))}
                {!p.rules.length && (
                  <tr>
                    <td colSpan={4}>No recovery percentages configured.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="partner-subheading">
            <div>
              <h3>Monthly settlement · {displayMonth(month)}</h3>
              <p>
                Review current-month estimates. Confirm deductions only after
                the calendar month ends.
              </p>
            </div>
            {admin && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void review()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <RefreshCw size={16} />
                )}
                Review monthly settlement
              </button>
            )}
          </div>
          {preview && (
            <div className="partner-review">
              <p>
                <strong>
                  Recorded full-month net income: {money(preview.net_cents)}
                </strong>
              </p>
              {preview.needs_review && (
                <p className="error-box">
                  Income or expenses changed after confirmation. The saved
                  deductions remain unchanged. Review and reverse the old
                  settlement before posting a correction.
                </p>
              )}
              {preview.blockers.map((b) => (
                <p className="error-box" key={b}>
                  {b}
                </p>
              ))}
              <SettlementTable
                preview={preview.active_settlement?.snapshot || preview}
              />
              {preview.active_settlement ? (
                <p>
                  Confirmed{" "}
                  {new Date(
                    preview.active_settlement.confirmed_at,
                  ).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}{" "}
                  Manila. Actual cash payouts are shown in the owner cards
                  above.
                </p>
              ) : (
                <button
                  className="button primary"
                  disabled={!preview.can_post || busy}
                  onClick={() => open({ kind: "settle", preview })}
                >
                  Confirm settlement…
                </button>
              )}
              {!preview.active_settlement &&
                !preview.can_post &&
                month >= monthStart(today) && (
                  <p className="muted">
                    This month is still open. Nothing has been withheld or
                    posted by this preview.
                  </p>
                )}
            </div>
          )}
          {!!statements.length && (
            <details open>
              <summary>Settlement history · {displayMonth(month)}</summary>
              {statements.map((s) => (
                <div className="partner-review" key={s.id}>
                  {s.needs_review && (
                    <p className="error-box">
                      Income or expenses changed. This saved settlement needs
                      admin review.
                    </p>
                  )}
                  <strong>
                    {s.reversed_at ? "Reversed" : "Confirmed"} ·{" "}
                    {new Date(s.confirmed_at).toLocaleString("en-PH", {
                      timeZone: "Asia/Manila",
                    })}{" "}
                    Manila
                  </strong>
                  <SettlementTable preview={s.snapshot} />
                  {s.reversal_reason && <p>Correction: {s.reversal_reason}</p>}
                  {admin && !s.reversed_at && (
                    <button
                      className="button secondary"
                      onClick={() =>
                        open({ kind: "reverse_settlement", record: s.id })
                      }
                    >
                      Reverse for correction
                    </button>
                  )}
                </div>
              ))}
            </details>
          )}
        </>
      )}
      <p className="partner-help">
        Partner reimbursements and capital recoveries stay separate. No
        automatic offsets or bank transfers. Cash paid to owners is recorded in
        Payout history; confirmed capital withholding is already deducted from
        the remaining payout.
      </p>
      {form && (
        <PartnerForm
          key={`${form.kind}-${form.record || "new"}`}
          form={form}
          today={today}
          month={month}
          command={command}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            setPreview(null);
            setNotice(
              "Saved. Linked balances and finance entries were updated once.",
            );
            if (ws.mode === "live") await ws.refresh();
          }}
        />
      )}
    </section>
  );
}
function SettlementTable({ preview }: { preview: PartnerPreview }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>Partner</th>
            <th>Gross share</th>
            <th>Rate</th>
            <th>Capital withheld</th>
            <th>Prior cash paid</th>
            <th>Remaining payout</th>
            <th>Debt after recovery</th>
          </tr>
        </thead>
        <tbody>
          {preview.owners.map((o) => (
            <tr key={o.owner}>
              <td>{o.owner}</td>
              <td>{money(o.entitlement)}</td>
              <td>
                {o.rate_bps === null
                  ? "Not set"
                  : `${(o.rate_bps / 100).toFixed(2)}%`}
              </td>
              <td>{money(o.withheld)}</td>
              <td>{money(o.paid)}</td>
              <td className={o.payable < 0 ? "negative" : ""}>
                {money(o.payable)}
              </td>
              <td>{money(o.debt_after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function PartnerForm({
  form,
  today,
  month,
  command,
  onClose,
  onSaved,
}: {
  form: OpenForm;
  today: string;
  month: string;
  command: (
    action: string,
    id: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const ws = useWorkspace(),
    p = ws.data.partners || emptyPartners(),
    dialog = useRef<HTMLDialogElement>(null),
    id = useRef(crypto.randomUUID()),
    working = useRef(false),
    attempt = useRef<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [existing, setExisting] = useState(""),
    [included, setIncluded] = useState<Owner[]>(["Genesis", "Ken"]);
  const agreement = ws.data.installments.find((a) => a.id === form.record),
    fund = p.fundings.find((f) => f.id === form.record),
    payment = p.payments.find((p) => p.id === form.record);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const f = new FormData(e.currentTarget),
        get = (k: string) => String(f.get(k) || "").trim(),
        amount = (k: string) => {
          const n = parseMoney(get(k));
          if (n <= 0) throw Error("Amounts must be greater than zero.");
          return n;
        },
        ym = (k: string) => get(k) + "-01";
      let payload: Record<string, unknown> = {};
      switch (form.kind) {
        case "purchase":
          payload = {
            owner: get("owner"),
            purchased_on: get("purchased_on"),
            ...(existing
              ? { existing_id: existing }
              : {
                  name: get("name"),
                  category_id: get("category_id"),
                  total_cents: amount("total"),
                  monthly_cents: amount("monthly"),
                  first_due: get("first_due"),
                }),
          };
          break;
        case "reimburse":
          payload = {
            installment_id: form.record,
            paid_on: get("paid_on"),
            due_month: ym("due_month"),
            amount_cents: amount("amount"),
            account: get("account"),
            reference: get("reference"),
          };
          break;
        case "funding_draft":
          payload = {
            supplier: get("supplier"),
            purpose: get("purpose"),
            total_cents: amount("total"),
            start_month: ym("start_month"),
            partners: included.map((owner) => ({
              owner,
              amount_cents: amount("amount_" + owner),
              rate_bps: parseRecoveryRate(get("rate_" + owner)),
            })),
          };
          break;
        case "fund":
          payload = {
            funding_id: form.record,
            paid_on: get("paid_on"),
            account: get("account"),
            reference: get("reference"),
          };
          break;
        case "rule":
          payload = {
            owner: get("owner"),
            effective_month: ym("effective_month"),
            rate_bps: parseRecoveryRate(get("rate")),
            reason: get("reason"),
          };
          break;
        case "settle":
          payload = {
            month: form.preview!.month,
            fingerprint: form.preview!.fingerprint,
          };
          break;
        case "void_funding":
          payload = { funding_id: form.record, reason: get("reason") };
          break;
        case "void_reimbursement":
          payload = { payment_id: form.record, reason: get("reason") };
          break;
        case "reverse_settlement":
          payload = { settlement_id: form.record, reason: get("reason") };
          break;
      }
      const fingerprint = JSON.stringify(payload);
      if (attempt.current && attempt.current !== fingerprint)
        throw Error(
          "This attempt may already have saved. Refresh records and check history before starting a changed action.",
        );
      attempt.current = fingerprint;
      await command(form.kind, id.current, payload);
      await onSaved();
    } catch (e) {
      if ((e as { code?: string }).code?.match(/^[0-9A-Z]{5}$/))
        attempt.current = null;
      setError(
        e instanceof Error
          ? e.message
          : "Unable to save. Retry the same action.",
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className={`record-dialog partner-dialog ${form.kind === "settle" ? "partner-wide" : ""}`}
      aria-labelledby="partner-form-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-heading">
        <div>
          <span className="eyebrow">THE GARDENS · PARTNER ADVANCES</span>
          <h2 id="partner-form-title">{titles[form.kind]}</h2>
        </div>
        <button
          className="icon-button"
          disabled={busy}
          onClick={onClose}
          aria-label="Close partner form"
        >
          <X size={20} />
        </button>
      </div>
      <form onSubmit={submit}>
        <fieldset disabled={busy} className="partner-fields">
          <div className="form-grid">
            {form.kind === "purchase" && (
              <>
                <Field label="Paying partner">
                  <select name="owner" required>
                    {OWNERS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Actual purchase date">
                  <input
                    type="date"
                    name="purchased_on"
                    defaultValue={today}
                    max={today}
                    required
                  />
                </Field>
                <Field
                  wide
                  label="Agreement"
                  hint="Link an existing agreement only if this purchase is already included in its total. Linking preserves all existing payments."
                >
                  <select
                    value={existing}
                    onChange={(e) => setExisting(e.target.value)}
                  >
                    <option value="">
                      Create a new reimbursement agreement
                    </option>
                    {ws.data.installments
                      .filter((a) => !p.purchases.some((v) => v.id === a.id))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} · {money(a.total_cents)}
                        </option>
                      ))}
                  </select>
                </Field>
                {!existing && (
                  <>
                    <Field wide label="Purchase description">
                      <input
                        name="name"
                        placeholder="Linix Sweeper"
                        maxLength={200}
                        required
                      />
                    </Field>
                    <Field label="Expense category">
                      <select name="category_id" required>
                        <option value="">Choose category</option>
                        {ws.data.categories
                          .filter((c) => c.kind === "expense" && c.active)
                          .map((c) => (
                            <option value={c.id} key={c.id}>
                              {c.name}
                            </option>
                          ))}
                      </select>
                    </Field>
                    <Field label="Total owed (₱)">
                      <input
                        name="total"
                        inputMode="decimal"
                        placeholder="25,000.00"
                        required
                      />
                    </Field>
                    <Field label="Monthly reimbursement (₱)">
                      <input name="monthly" inputMode="decimal" required />
                    </Field>
                    <Field label="First due date">
                      <input
                        type="date"
                        name="first_due"
                        defaultValue={today}
                        required
                      />
                    </Field>
                  </>
                )}
                <p className="partner-help wide">
                  Registering the purchase creates an obligation. Business
                  profit and account funds change only when The Gardens
                  reimburses the partner.
                </p>
              </>
            )}
            {form.kind === "reimburse" && agreement && (
              <>
                <p className="wide">
                  <strong>{agreement.name}</strong> · remaining{" "}
                  {money(
                    installmentSummary(ws.data, agreement, today).remaining,
                  )}
                </p>
                <Field label="Actual payment date">
                  <input
                    type="date"
                    name="paid_on"
                    max={today}
                    defaultValue={today}
                    required
                  />
                </Field>
                <Field label="Installment due month">
                  <input
                    type="month"
                    name="due_month"
                    defaultValue={(
                      installmentSummary(ws.data, agreement, today).next ||
                      agreement.first_due
                    ).slice(0, 7)}
                    required
                  />
                </Field>
                <Field label="Amount reimbursed (₱)">
                  <input
                    name="amount"
                    inputMode="decimal"
                    defaultValue={(
                      Math.min(
                        agreement.monthly_cents,
                        installmentSummary(ws.data, agreement, today).remaining,
                      ) / 100
                    ).toFixed(2)}
                    required
                  />
                </Field>
                <AccountField />
                <Field wide label="Payment reference">
                  <input name="reference" maxLength={120} />
                </Field>
                <p className="partner-help wide">
                  Creates one linked expense and one account assignment. Opening
                  balances must be configured first.
                </p>
              </>
            )}
            {form.kind === "funding_draft" && (
              <>
                <Field label="Supplier">
                  <input name="supplier" maxLength={200} required />
                </Field>
                <Field label="Total supplier payment (₱)">
                  <input
                    name="total"
                    inputMode="decimal"
                    placeholder="112,000.00"
                    required
                  />
                </Field>
                <Field wide label="Capital purpose">
                  <input name="purpose" maxLength={1000} required />
                </Field>
                <Field label="Recovery starts in">
                  <input
                    type="month"
                    name="start_month"
                    defaultValue={month.slice(0, 7)}
                    required
                  />
                </Field>
                <div className="wide partner-allocation">
                  <h3>Partner allocations and recovery rates</h3>
                  <p>
                    Amounts must add up to the supplier total. The percentage
                    applies to that partner’s gross monthly share across all
                    active capital debts.
                  </p>
                  {OWNERS.map((owner) => (
                    <div key={owner}>
                      <label>
                        <input
                          type="checkbox"
                          checked={included.includes(owner)}
                          onChange={(e) =>
                            setIncluded((old) =>
                              e.target.checked
                                ? [...old, owner]
                                : old.filter((o) => o !== owner),
                            )
                          }
                        />
                        {owner}
                      </label>
                      {included.includes(owner) && (
                        <>
                          <Field label={`${owner} capital (₱)`}>
                            <input
                              name={"amount_" + owner}
                              inputMode="decimal"
                              required
                            />
                          </Field>
                          <Field
                            label={`${owner} recovery (%)`}
                            hint="0–100%; no preset rate."
                          >
                            <input
                              name={"rate_" + owner}
                              inputMode="decimal"
                              required
                            />
                          </Field>
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <p className="partner-help wide">
                  Saves a draft. No money is moved and no recovery is posted
                  until the supplier payment is recorded. Creating a rule for an
                  existing partner/month replaces that month’s unconfirmed rate.
                </p>
              </>
            )}
            {form.kind === "fund" && fund && (
              <>
                <p className="wide">
                  <strong>
                    {fund.supplier} · {money(fund.total_cents)}
                  </strong>
                  <br />
                  {fund.purpose}
                </p>
                <Field label="Actual supplier payment date">
                  <input
                    type="date"
                    name="paid_on"
                    defaultValue={today}
                    max={today}
                    required
                  />
                </Field>
                <AccountField />
                <Field wide label="Payment reference">
                  <input name="reference" maxLength={120} />
                </Field>
                <p className="partner-help wide">
                  Records the capital outflow and activates the partner debts.
                  This does not reduce operating profit or initiate a bank
                  transfer.
                </p>
                <label className="wide partner-check">
                  <input type="checkbox" required />I confirm the supplier has
                  actually been paid.
                </label>
              </>
            )}
            {form.kind === "rule" && (
              <>
                <Field label="Partner">
                  <select name="owner">
                    {OWNERS.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Effective month">
                  <input
                    name="effective_month"
                    type="month"
                    defaultValue={month.slice(0, 7)}
                    required
                  />
                </Field>
                <Field
                  label="Recovery percentage (%)"
                  hint="Use 0 to pause. Applies once across active capital debts."
                >
                  <input name="rate" inputMode="decimal" required />
                </Field>
                <Field wide label="Reason">
                  <input
                    name="reason"
                    minLength={3}
                    maxLength={1000}
                    required
                  />
                </Field>
              </>
            )}
            {form.kind === "settle" && form.preview && (
              <div className="wide">
                <p>
                  {displayMonth(form.preview.month)} · net income{" "}
                  {money(form.preview.net_cents)}
                </p>
                <SettlementTable preview={form.preview} />
                <p>
                  Confirmation saves these calculations, reduces the capital
                  debts, and leaves withheld funds in The Gardens. It records no
                  cash payout.
                </p>
                <label className="partner-check">
                  <input type="checkbox" required />I reviewed the monthly
                  shares, prior payouts and capital deductions.
                </label>
              </div>
            )}
            {[
              "void_funding",
              "void_reimbursement",
              "reverse_settlement",
            ].includes(form.kind) && (
              <>
                <p className="wide">
                  {form.kind === "reverse_settlement"
                    ? "Restores the capital amounts withheld by this settlement. Actual owner cash payouts remain recorded. Review and confirm a replacement after correcting the source records."
                    : `Use this only to correct an incorrect record. ${payment ? money(payment.detail.amount_cents) : fund ? money(fund.total_cents) : ""} will be removed from the linked cash records. This does not return money or record an actual refund.`}
                </p>
                <Field wide label="Correction reason">
                  <textarea
                    name="reason"
                    minLength={3}
                    maxLength={1000}
                    required
                  />
                </Field>
                <label className="partner-check wide">
                  <input type="checkbox" required />I reviewed this correction
                  and its effect on the linked balances.
                </label>
              </>
            )}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="error-box">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}
            {form.kind === "settle"
              ? "Confirm settlement"
              : form.kind.startsWith("void") ||
                  form.kind === "reverse_settlement"
                ? "Confirm correction"
                : form.kind === "fund"
                  ? "Record actual payment"
                  : "Save"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function AccountField() {
  return (
    <Field label="Paid from account">
      <select name="account" required>
        {Object.entries(ACCOUNTS).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </Field>
  );
}
