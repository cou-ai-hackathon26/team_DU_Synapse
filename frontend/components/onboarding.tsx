"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { SupabaseClient } from "@supabase/supabase-js";
import { CheckCircle2 } from "lucide-react";
import { api, apiBase, message } from "@/lib/api";
import { ErrorNote, PasswordField } from "./ui";
import { AccountMenu } from "./account-menu";
import { ReviewerFields, reviewerDetails } from "./reviewer-fields";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { AuthShell } from "./v2/auth-shell";

export type Factory = { id: string; name: string; address?: string };

function PasswordFields() {
  return (
    <>
      <PasswordField newPassword />
      <p className="hint">
        Use at least 8 characters. A longer, unique passphrase is stronger.
      </p>
      <PasswordField label="Confirm password" name="confirm" newPassword />
    </>
  );
}

function passwords(form: FormData) {
  const password = String(form.get("password"));
  if (password !== form.get("confirm"))
    throw new Error("Passwords do not match.");
  if (new TextEncoder().encode(password).length > 72)
    throw new Error("Use at most 72 UTF-8 bytes for the password.");
  return password;
}

export function SetPassword() {
  const started = useRef(false);
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState("checking");
  const [error, setError] = useState("");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const url = new URL(window.location.href);
    const value =
      new URLSearchParams(url.hash.slice(1)).get("token") ||
      url.searchParams.get("token");
    window.history.replaceState(null, "", "/set-password");
    if (!value) {
      setStatus("invalid");
      setError("This invite is missing. Ask the admin for a new link.");
      return;
    }
    setToken(value);
    void api<{ email: string }>("/v1/invites/validate", undefined, "POST", {
      token: value,
    })
      .then(({ email }) => {
        setEmail(email);
        setStatus("ready");
      })
      .catch((error) => {
        setStatus("invalid");
        setError(message(error));
      });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("saving");
    let passwordSaved = false;
    let auth: SupabaseClient | null = null;
    try {
      const password = passwords(new FormData(event.currentTarget));
      const config = await api<{
        supabase_url: string;
        publishable_key: string;
      }>("/v1/config");
      auth = getSupabaseBrowserClient(config);
      await api("/v1/invites/set-password", undefined, "POST", {
        token,
        password,
      });
      passwordSaved = true;
      const session = await api<{
        access_token: string;
        refresh_token: string;
      }>("/v1/login", undefined, "POST", {
        email,
        password,
        workspace: "reviewer",
      });
      const { error } = await auth.auth.setSession(session);
      if (error) throw error;
      window.location.replace("/dashboard");
    } catch (error) {
      if (passwordSaved) {
        await auth?.auth.signOut().catch(() => undefined);
        window.location.replace(
          `/login?password=updated&email=${encodeURIComponent(email)}`,
        );
        return;
      }
      setError(message(error));
      setStatus("ready");
    }
  }
  return (
    <main className="entry-page">
      <section className="panel entry-panel">
        <h1>Set your reviewer password</h1>
        {status === "checking" && <p>Checking your invitation…</p>}
        {["ready", "saving"].includes(status) && (
          <form method="post" onSubmit={submit}>
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                readOnly
                aria-readonly="true"
                className="fixed-email"
              />
            </label>
            <PasswordFields />
            <button className="primary" disabled={status === "saving"}>
              Set password
            </button>
          </form>
        )}
        {error && <ErrorNote text={error} />}
        <a href="/login">Back to sign in</a>
      </section>
    </main>
  );
}

export function RequestReviewerAccess() {
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/v1/signup/reviewer", undefined, "POST", {
        ...reviewerDetails(form),
        website: form.get("website"),
      });
      setSubmitted(true);
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      contextDescription="Join a controlled workflow where every evidence finding remains connected to its source and professional review."
      contextTitle="Independent review begins with trusted access."
      description="Tell us who you represent. An administrator will review the request before access is granted."
      eyebrow="Reviewer onboarding"
      note="Submitting this form requests access only. It does not create an active reviewer account."
      noteTitle="Approval required"
      panelClassName="reviewer-access-panel"
      title="Request reviewer access"
    >
        {submitted ? (
          <div className="reviewer-access-success" role="status">
            <CheckCircle2 aria-hidden="true" />
            <div>
              <strong>Request received</strong>
              <p>Your request is awaiting admin approval. If approved, ask the admin for your one-time password setup link.</p>
            </div>
          </div>
        ) : (
          <form className="v2-access-form" method="post" onSubmit={submit}>
            <ReviewerFields />
            <input name="website" hidden tabIndex={-1} autoComplete="off" />
            {error && <ErrorNote text={error} />}
            <button className="v2-button reviewer-access-submit" disabled={busy}>
              {busy ? "Submitting…" : "Send access request"}
            </button>
          </form>
        )}
        <div className="login-registration reviewer-access-links">
          <p>Already have access? <Link href="/login">Return to sign in</Link></p>
        </div>
    </AuthShell>
  );
}

export function ManagerSignup() {
  const [factories, setFactories] = useState<Factory[] | null>(null);
  const [factoryId, setFactoryId] = useState("");
  const [address, setAddress] = useState("");
  const [idCardNumber, setIdCardNumber] = useState("");
  const [cardReadState, setCardReadState] = useState<
    "idle" | "reading" | "detected" | "not-detected" | "failed"
  >("idle");
  const cardReadRequest = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Factory[]>("/v1/factories")
      .then(setFactories)
      .catch((error) => setError(message(error)));
  }, []);
  useEffect(() => {
    setAddress("");
    if (!factoryId) return;
    let active = true;
    void api<{ address: string }>(`/v1/factories/${factoryId}/address`)
      .then((result) => {
        if (active) setAddress(result.address);
      })
      .catch((error) => {
        if (active) setError(message(error));
      });
    return () => {
      active = false;
    };
  }, [factoryId]);

  async function readIdCardNumber(file: File | null) {
    const requestId = ++cardReadRequest.current;
    setIdCardNumber("");
    setError("");
    if (!file) {
      setCardReadState("idle");
      return;
    }
    if (
      file.size < 1 ||
      file.size > 5 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "application/pdf"].includes(file.type)
    ) {
      setCardReadState("idle");
      return;
    }
    setCardReadState("reading");
    try {
      const form = new FormData();
      form.append("office_card", file);
      const response = await fetch(
        apiBase() + "/v1/signup/factory-manager/read-id-number",
        { method: "POST", body: form, cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error("Could not read the ID card.");
      }
      if (requestId !== cardReadRequest.current) return;
      if (typeof data.number === "string" && data.number) {
        setIdCardNumber(data.number);
        setCardReadState("detected");
      } else {
        setCardReadState("not-detected");
      }
    } catch {
      if (requestId === cardReadRequest.current) setCardReadState("failed");
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const form = new FormData(event.currentTarget);
      const password = passwords(form);
      const file = form.get("office_card");
      if (
        !(file instanceof File) ||
        file.size < 1 ||
        file.size > 5 * 1024 * 1024
      )
        throw new Error("Choose an office ID card up to 5 MB.");
      if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type))
        throw new Error("Choose a JPG, PNG or PDF.");
      if (form.get("website")) throw new Error("Check the application fields.");
      const ticket = await api<{
        upload_url: string;
        upload_key: string;
        receipt: string;
      }>("/v1/signup/factory-manager/upload", undefined, "POST");
      const upload = await fetch(ticket.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!upload.ok)
        throw new Error("The office ID upload failed. Try again.");
      const body = Object.fromEntries(form);
      delete body.office_card;
      delete body.confirm;
      const response = await fetch(apiBase() + "/v1/signup/factory-manager", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Receipt": ticket.receipt,
        },
        body: JSON.stringify({
          ...body,
          password,
          factory_id: factoryId,
          consent: form.get("consent") === "on",
          upload_key: ticket.upload_key,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(
          typeof data.detail === "string"
            ? data.detail
            : "Check the application fields and try again.",
        );
      }
      window.location.assign("/signup/factory-manager/waiting");
    } catch (error) {
      setError(message(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="entry-page">
      <section className="panel entry-panel">
        <h1>Apply as a Factory Manager</h1>
        <AccountMenu current="signup" />
        <p>Choose your factory and submit your office ID for admin approval.</p>
        {factories?.length === 0 && (
          <p>No factories available yet. Please contact the admin.</p>
        )}
        <form onSubmit={submit}>
          <label>
            Full name
            <input
              name="full_name"
              required
              maxLength={160}
              autoComplete="name"
            />
          </label>
          <label>
            Email
            <input
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="username"
            />
          </label>
          <label>
            Phone number
            <input
              name="phone"
              type="tel"
              required
              minLength={6}
              maxLength={32}
              autoComplete="tel"
            />
          </label>
          <label>
            Factory
            <select
              required
              value={factoryId}
              onChange={(event) => setFactoryId(event.target.value)}
            >
              <option value="">
                {factories ? "Choose factory" : "Loading factories…"}
              </option>
              {factories?.map((factory) => (
                <option value={factory.id} key={factory.id}>
                  {factory.name}
                </option>
              ))}
            </select>
          </label>
          {address && <p className="hint">{address}</p>}
          <label>
            Job title
            <input
              name="job_title"
              defaultValue="Factory Manager"
              required
              maxLength={120}
            />
          </label>
          <label>
            Office ID card
            <input
              name="office_card"
              type="file"
              accept="image/jpeg,image/png,application/pdf"
              required
              onChange={(event) =>
                void readIdCardNumber(event.currentTarget.files?.[0] ?? null)
              }
            />
          </label>
          <p className="hint">JPG, PNG or PDF, up to 5 MB.</p>
          <label>
            Office ID card number (optional)
            <input
              name="id_card_number"
              maxLength={120}
              value={idCardNumber}
              onChange={(event) => setIdCardNumber(event.target.value)}
            />
          </label>
          {cardReadState !== "idle" && (
            <p className="hint" aria-live="polite">
              {cardReadState === "reading"
                ? "Reading the ID card number…"
                : cardReadState === "detected"
                  ? "Card number detected and filled. Check it before submitting."
                  : cardReadState === "not-detected"
                    ? "Could not detect the card number. You can enter it manually."
                    : "Could not read this card. You can enter the number manually."}
            </p>
          )}
          <label>
            Factory license or BGMEA/BKMEA membership number (optional)
            <input name="membership_number" maxLength={120} />
          </label>
          <PasswordFields />
          <div hidden aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <label className="consent">
            <input name="consent" type="checkbox" required /> I agree that my ID
            card is used only to verify my position and will be deleted after
            verification.
          </label>
          {error && <ErrorNote text={error} />}
          <button
            className="primary"
            disabled={
              busy ||
              cardReadState === "reading" ||
              !factories?.length ||
              !factoryId
            }
          >
            {busy
              ? "Submitting…"
              : cardReadState === "reading"
                ? "Reading ID card…"
                : "Submit application"}
          </button>
        </form>
      </section>
    </main>
  );
}
