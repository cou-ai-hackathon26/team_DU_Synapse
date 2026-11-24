"use client";

import type { Session } from "@supabase/supabase-js";
import { useEffect, useMemo, useState } from "react";
import type { components } from "@/lib/schema";
import { api, type Case, type Config, type Dossier, message } from "@/lib/api";
import {
  authorizedFactories,
  casesForFactory,
  latestReadableRun,
  type EvidenceResult,
} from "@/lib/evidence-intelligence";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type AccountState = "restoring" | "signed-out" | "loading" | "ready" | "error";
type EvidenceState = "idle" | "loading" | "ready" | "error";

export function useEvidenceIntelligence() {
  const [session, setSession] = useState<Session | null>(null);
  const [accountState, setAccountState] = useState<AccountState>("restoring");
  const [profile, setProfile] = useState<components["schemas"]["AccountProfile"] | null>(null);
  const [cases, setCases] = useState<Case[]>([]);
  const [selectedFactory, setSelectedFactory] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [results, setResults] = useState<EvidenceResult[]>([]);
  const [evidenceState, setEvidenceState] = useState<EvidenceState>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    async function restore() {
      try {
        const config = await api<Config>("/v1/config");
        if (!active) return;
        const auth = getSupabaseBrowserClient(config);
        const { data, error: sessionError } = await auth.auth.getSession();
        if (sessionError) throw sessionError;
        if (!active) return;
        setSession(data.session);
        setAccountState(data.session ? "loading" : "signed-out");
        const subscription = auth.auth.onAuthStateChange((_event, next) => {
          if (!active) return;
          setSession(next);
          setAccountState(next ? "loading" : "signed-out");
        });
        unsubscribe = () => subscription.data.subscription.unsubscribe();
      } catch (caught) {
        if (!active) return;
        setError(message(caught));
        setAccountState("error");
      }
    }
    void restore();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const token = session?.access_token;
  useEffect(() => {
    if (!token) {
      setProfile(null);
      setCases([]);
      setDossier(null);
      setResults([]);
      return;
    }
    const controller = new AbortController();
    setAccountState("loading");
    setError("");
    void api<components["schemas"]["AccountProfile"]>(
      "/v1/me",
      token,
      "GET",
      undefined,
      controller.signal,
    )
      .then(async (nextProfile) => {
        const nextCases = nextProfile.role === "admin"
          ? []
          : await api<Case[]>(
              "/v1/cases",
              token,
              "GET",
              undefined,
              controller.signal,
            );
        if (controller.signal.aborted) return;
        setProfile(nextProfile);
        setCases(nextCases);
        setAccountState("ready");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(message(caught));
        setAccountState("error");
      });
    return () => controller.abort();
  }, [token]);

  const factories = useMemo(() => authorizedFactories(cases), [cases]);
  const factoryCases = useMemo(
    () => casesForFactory(cases, selectedFactory),
    [cases, selectedFactory],
  );

  useEffect(() => {
    if (!factories.length) {
      setSelectedFactory("");
      return;
    }
    if (!factories.includes(selectedFactory)) setSelectedFactory(factories[0]);
  }, [factories, selectedFactory]);

  useEffect(() => {
    if (!factoryCases.length) {
      setSelectedCaseId("");
      return;
    }
    if (!factoryCases.some((item) => item.id === selectedCaseId)) {
      setSelectedCaseId(factoryCases[0].id);
    }
  }, [factoryCases, selectedCaseId]);

  useEffect(() => {
    if (!token || !selectedCaseId || !cases.some((item) => item.id === selectedCaseId)) {
      setDossier(null);
      setResults([]);
      setEvidenceState("idle");
      return;
    }
    const controller = new AbortController();
    setEvidenceState("loading");
    setError("");
    void api<Dossier>(
      `/v1/cases/${selectedCaseId}`,
      token,
      "GET",
      undefined,
      controller.signal,
    )
      .then(async (nextDossier) => {
        const run = latestReadableRun(nextDossier);
        const nextResults = run
          ? await api<EvidenceResult[]>(
              `/v1/runs/${run.id}/results`,
              token,
              "GET",
              undefined,
              controller.signal,
            )
          : [];
        if (controller.signal.aborted) return;
        setDossier(nextDossier);
        setResults(nextResults);
        setEvidenceState("ready");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setDossier(null);
        setResults([]);
        setError(message(caught));
        setEvidenceState("error");
      });
    return () => controller.abort();
  }, [cases, selectedCaseId, token]);

  return {
    accountState,
    evidenceState,
    error,
    profile,
    token,
    cases,
    factories,
    factoryCases,
    selectedFactory,
    selectedCaseId,
    setSelectedFactory,
    setSelectedCaseId,
    dossier,
    run: dossier ? latestReadableRun(dossier) : undefined,
    results,
    realMode: accountState === "ready",
  };
}
