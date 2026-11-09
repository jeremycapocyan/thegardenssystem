"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getBackend } from "@/lib/backend";
import { CourtMark } from "@/components/finance-app";

export default function AccountPage() {
  const [status, setStatus] = useState<
    "loading" | "ready" | "invalid" | "saved"
  >("loading");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    const api = getBackend();
    if (!api) {
      setStatus("invalid");
      return;
    }
    void api.auth
      .getUser()
      .then(({ data, error: authError }) => {
        if (active) setStatus(!authError && data.user ? "ready" : "invalid");
      })
      .catch(() => {
        if (active) setStatus("invalid");
      });
    return () => {
      active = false;
    };
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    if (password !== String(form.get("confirmation"))) {
      setError("The two passwords must match.");
      return;
    }
    setPending(true);
    try {
      const api = getBackend();
      if (!api) throw new Error("Shared sign-in is not connected.");
      const result = await api.auth.updateUser({ password });
      if (result.error) throw new Error(result.error.message);
      setStatus("saved");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to save your password.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main id="main-content" className="account-page">
      <section className="account-card">
        <CourtMark size={44} />
        <span className="eyebrow">THE GARDENS · ACCOUNT ACCESS</span>
        <h1>
          {status === "saved" ? "Your password is saved." : "Set your password"}
        </h1>
        {status === "loading" && <p>Checking your account link…</p>}
        {status === "invalid" && (
          <>
            <p>
              This link has expired or does not include an authenticated
              account. Open the latest invitation or request a new password
              recovery link from sign in.
            </p>
            <Link className="button primary" href="/">
              Go to sign in
            </Link>
          </>
        )}
        {status === "ready" && (
          <>
            <p>Choose a password for your approved workspace account.</p>
            <form onSubmit={submit}>
              <label className="field">
                <span>New password</span>
                <input
                  type="password"
                  name="password"
                  required
                  minLength={12}
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                />
              </label>
              <label className="field">
                <span>Confirm password</span>
                <input
                  type="password"
                  name="confirmation"
                  required
                  minLength={12}
                  autoComplete="new-password"
                />
              </label>
              {error && (
                <p className="error-box" role="alert">
                  {error}
                </p>
              )}
              <button className="button primary" disabled={pending}>
                {pending ? "Saving…" : "Save password"}
              </button>
            </form>
          </>
        )}
        {status === "saved" && (
          <>
            <p>You can now use your email and password to sign in.</p>
            <Link className="button primary" href="/">
              Open workspace
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
