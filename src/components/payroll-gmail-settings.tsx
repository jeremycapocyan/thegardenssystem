"use client";
import { useEffect, useState } from "react";
import { useWorkspace } from "./workspace-provider";
import { staffFetch } from "@/lib/staff-client";
export function PayrollGmailSettings() {
  const ws = useWorkspace(),
    [status, setStatus] = useState<{
      configured: boolean;
      connected: boolean;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  async function refresh() {
    if (ws.mode === "demo") {
      setStatus({ configured: false, connected: false });
      return;
    }
    try {
      const r = await staffFetch("/api/team/payroll-mail/");
      if (!r.ok) throw Error();
      setStatus(await r.json());
    } catch {
      setMessage("Unable to check Gmail status. Refresh the page.");
    }
  }
  useEffect(() => {
    void refresh();
  }, [ws.mode]);
  async function change(action: "connect" | "disconnect") {
    setBusy(true);
    setMessage("");
    try {
      if (ws.mode === "demo") {
        setMessage("Sample only. No Gmail account was connected or changed.");
        return;
      }
      const r = await staffFetch("/api/team/payroll-mail/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }),
        b = await r.json();
      if (!r.ok) throw Error(b.message);
      if (action === "connect") window.location.assign(b.url);
      else {
        setMessage(b.message);
        await refresh();
      }
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Gmail setup is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel staff-welcome gmail-settings">
      <h2>Payroll email sender</h2>
      <p>
        <strong>theplaymakers2026@gmail.com</strong> ·{" "}
        {status?.connected
          ? "Connected for payroll sending"
          : status
            ? "Sending disabled until Gmail is connected"
            : "Checking connection…"}
      </p>
      <p>
        HR admins review and send each finalized report. Emails are never sent
        automatically.
      </p>
      {ws.profile?.is_owner && (
        <>
          <div className="staff-actions">
            <button
              className="button primary"
              disabled={busy || !status?.configured}
              onClick={() => void change("connect")}
            >
              Connect / reconnect Gmail
            </button>
            {status?.connected && (
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => void change("disconnect")}
              >
                Disconnect Gmail
              </button>
            )}
          </div>
          <details open={!status?.configured}>
            <summary>One-time Gmail setup for Jeremy</summary>
            <ol>
              <li>
                Open Google Cloud Console using theplaymakers2026@gmail.com.
                Create a project named The Gardens Payroll and enable the Gmail
                API.
              </li>
              <li>
                Configure Google Auth Platform branding and its external OAuth
                consent screen. Request only <code>openid</code>,{" "}
                <code>email</code>, and{" "}
                <code>https://www.googleapis.com/auth/gmail.send</code>. Google
                may require app verification before live authorization.
                Testing-mode refresh credentials expire; finish the appropriate
                publishing setup for ongoing use.
              </li>
              <li>
                Create an OAuth client of type Web application. Add this exact
                authorized redirect URI:{" "}
                <code>
                  https://thegardenssystem.vercel.app/api/team/payroll-mail/callback/
                </code>
                .
              </li>
              <li>
                In the existing Vercel project, privately add{" "}
                <code>GMAIL_OAUTH_CLIENT_ID</code> and{" "}
                <code>GMAIL_OAUTH_CLIENT_SECRET</code> to Production environment
                variables and redeploy. The server also requires{" "}
                <code>PAYROLL_MAIL_ENCRYPTION_KEY</code>. Keep credentials out
                of chat and GitHub.
              </li>
              <li>
                Return here, click Connect Gmail, select the payroll Gmail
                account, and complete Google’s consent. The connection can send
                payroll email; it does not read your inbox.
              </li>
            </ol>
            <p>
              <a
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noreferrer"
              >
                Open Google Cloud Console
              </a>{" "}
              ·{" "}
              <a
                href="https://vercel.com/coach-jeremy/thegardenssystem/settings/environment-variables"
                target="_blank"
                rel="noreferrer"
              >
                Open Vercel environment settings
              </a>
            </p>
          </details>
        </>
      )}
      {!ws.profile?.is_owner && !status?.connected && (
        <p>
          Jeremy must connect the Gmail sender. PDF previews and downloads
          remain available.
        </p>
      )}
      {message && (
        <p className="setup-note" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
