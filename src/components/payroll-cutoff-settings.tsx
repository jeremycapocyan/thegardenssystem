"use client";
import { useState, type FormEvent } from "react";
import { useWorkspace } from "./workspace-provider";
import { canManage } from "@/lib/access";
import { getBackend } from "@/lib/backend";
import { addDays, displayDate, todayInManila } from "@/lib/finance";
import { payrollBounds, type CutoffRule } from "@/lib/payroll-periods";
export function PayrollCutoffSettings({
  rules,
  onSaved,
  onDemoSave,
}: {
  rules?: CutoffRule[];
  onSaved: () => Promise<void>;
  onDemoSave: (rule: CutoffRule) => void;
}) {
  const ws = useWorkspace(),
    current = payrollBounds(todayInManila(), rules),
    latest =
      (rules || [])
        .slice()
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ||
      current.rule;
  const [first, setFirst] = useState(String(latest.first_day)),
    [second, setSecond] = useState(String(latest.second_day)),
    [effective, setEffective] = useState(
      addDays(
        payrollBounds(
          latest.effective_from > todayInManila()
            ? latest.effective_from
            : todayInManila(),
          rules,
        ).end,
        1,
      ),
    ),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  if (!canManage(ws.profile, "team")) return null;
  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const a = Number(first),
        b = Number(second),
        bounds = payrollBounds(effective, rules);
      if (
        !Number.isInteger(a) ||
        !Number.isInteger(b) ||
        a < 1 ||
        a > 27 ||
        b <= a ||
        b > 31 ||
        !reason.trim()
      )
        throw Error("Choose two increasing cutoff days and enter a reason.");
      if (
        effective !== bounds.start ||
        effective < current.start ||
        effective <= latest.effective_from
      )
        throw Error(
          "Choose the start of a current or future period after the latest schedule version.",
        );
      if (ws.mode === "demo")
        onDemoSave({
          effective_from: effective,
          first_day: a,
          second_day: b,
          reason: reason.trim(),
        });
      else {
        const result = await getBackend()!.rpc(
          "garden_change_payroll_cutoffs",
          {
            p_effective: effective,
            p_first: a,
            p_second: b,
            p_reason: reason.trim(),
          },
        );
        if (result.error) throw Error(result.error.message);
        await onSaved();
      }
      setNotice(
        "Cutoff schedule saved. Finalized statements remain unchanged.",
      );
      setReason("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save cutoff schedule.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel staff-welcome cutoff-settings">
      <div>
        <h2>Payroll cutoff settings</h2>
        <p>
          Current closing days:{" "}
          <strong>
            {current.rule.first_day} and {current.rule.second_day}
          </strong>
          . Days beyond a month’s length use its last day. Schedule changes
          begin on an existing period’s start and cannot affect finalized
          payroll.
        </p>
      </div>
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field">
            <span>First cutoff day</span>
            <input
              type="number"
              min={1}
              max={27}
              required
              value={first}
              onChange={(e) => setFirst(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Second cutoff day</span>
            <input
              type="number"
              min={2}
              max={31}
              required
              value={second}
              onChange={(e) => setSecond(e.target.value)}
            />
          </label>
          <label className="field">
            <span>First work date under new schedule</span>
            <input
              type="date"
              required
              value={effective}
              onInput={(e) => setEffective(e.currentTarget.value)}
              onChange={(e) => setEffective(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Reason for cutoff change</span>
            <input
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        </div>
        <p>
          Suggested next start: {displayDate(addDays(current.end, 1))}. The
          first new period may be shorter during the transition. A second cutoff
          of 31 means month-end.
        </p>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="setup-note" role="status">
            {notice}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? "Saving schedule…" : "Save cutoff schedule"}
        </button>
      </form>
      <details>
        <summary>Cutoff schedule history</summary>
        <ul>
          {(rules || []).map((r) => (
            <li key={r.effective_from}>
              {displayDate(r.effective_from)}: closes on {r.first_day} /{" "}
              {r.second_day}
              {r.reason ? ` · ${r.reason}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
