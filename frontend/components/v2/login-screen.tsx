"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Eye, EyeOff, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { api, message } from "@/lib/api";
import { AuthShell } from "./auth-shell";
import { useAuth } from "./auth-provider";

type Workspace = "reviewer" | "factory_manager";

export function LoginScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { state, client, setSession } = useAuth();
  const [workspace, setWorkspace] = useState<Workspace>(
    params.get("workspace") === "factory-manager" ? "factory_manager" : "reviewer",
  );
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (state === "authenticated") router.replace("/dashboard");
  }, [router, state]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!client) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      const tokens = await api<{ access_token: string; refresh_token: string }>(
        "/v1/login",
        undefined,
        "POST",
        {
          email: String(form.get("email") || "").trim(),
          password: String(form.get("password") || ""),
          workspace,
        },
      );
      await setSession(tokens.access_token, tokens.refresh_token);
      router.replace("/dashboard");
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      contextDescription="Organize safety documents, inspect exact citations, and keep professional judgment at the center of every review."
      contextTitle="Every finding should lead back to the source."
      description="Continue with your existing SafetyProof account."
      eyebrow="Authorized access"
      note="Factory, case and review access remains enforced by the SafetyProof backend."
      noteTitle="Secure by role"
      title="Sign in"
    >
          {params.get("password") === "updated" && (
            <p className="v2-form-success" role="status">Your password is set. Sign in to continue.</p>
          )}

          <div className="workspace-tabs" role="tablist" aria-label="Choose account workspace">
            <button type="button" role="tab" aria-selected={workspace === "reviewer"} onClick={() => setWorkspace("reviewer")}>Reviewer / Admin</button>
            <button type="button" role="tab" aria-selected={workspace === "factory_manager"} onClick={() => setWorkspace("factory_manager")}>Factory Manager</button>
          </div>

          <form className="v2-login-form" onSubmit={submit}>
            <label htmlFor="login-email">Email address</label>
            <div className="v2-input"><Mail aria-hidden="true" /><input id="login-email" name="email" type="email" required autoComplete="username" defaultValue={params.get("email") || ""} placeholder="you@organization.com" /></div>
            <label htmlFor="login-password">Password</label>
            <div className="v2-input"><LockKeyhole aria-hidden="true" /><input id="login-password" name="password" type={showPassword ? "text" : "password"} required autoComplete="current-password" placeholder="Enter your password" /><button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? <EyeOff /> : <Eye />}</button></div>
            {error && <p className="v2-form-error" role="alert">{error}</p>}
            {state === "error" && !error && <p className="v2-form-error" role="alert">Authentication configuration is unavailable. Confirm the local API is running.</p>}
            <button className="v2-button login-submit" disabled={busy || !client}>{busy ? "Signing in…" : "Sign in"}</button>
          </form>

          <div className="login-registration">
            {workspace === "factory_manager" ? (
              <p>Need factory access? <Link href="/signup/factory-manager">Apply as a Factory Manager</Link></p>
            ) : (
              <p>Need reviewer access? <Link href="/signup/reviewer">Request reviewer access</Link></p>
            )}
          </div>
          <p className="login-security"><ShieldCheck /> Authentication and role permissions are verified by the SafetyProof backend.</p>
    </AuthShell>
  );
}
