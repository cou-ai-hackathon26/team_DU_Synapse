"use client";

import { useEffect, useState } from "react";
import { api, type Dossier, message } from "@/lib/api";
import { latestReadableRun } from "@/lib/evidence-intelligence";
import { loadDashboardData, type DashboardData } from "@/lib/dashboard-data";
import { useAuth } from "./auth-provider";
import { loadDashboardScope, selectDashboardScope, type DashboardScope } from "@/lib/dashboard-scope";

export function useEvidenceIntelligence() {
  const auth = useAuth();
  const owner = auth.profile ? `${auth.profile.id}:${auth.profile.role}:${auth.profile.factory_id ?? ""}` : "";
  const token = auth.session?.access_token;
  const [caseData, setCaseData] = useState<{ owner: string; scope: DashboardScope; error: string }>({ owner: "", scope: { factories: [], cases: [] }, error: "" });
  const [choice, setChoice] = useState({ owner: "", factoryId: "", caseId: "" });
  const [snapshot, setSnapshot] = useState<{ key: string; data: DashboardData | null; error: string }>({ key: "", data: null, error: "" });
  const scope = caseData.owner === owner && auth.state === "authenticated" ? caseData.scope : { factories: [], cases: [] };
  const selected = selectDashboardScope(scope, choice.owner === owner ? choice.factoryId : "", choice.owner === owner ? choice.caseId : "");
  const selectedFactoryId = selected.factory?.id ?? "";
  const selectedCaseId = selected.selectedCase?.id ?? "";
  const cases = selected.cases;
  const key = `${owner}:${selectedFactoryId}:${selectedCaseId}`;
  const current = snapshot.key === key && auth.state === "authenticated" ? snapshot : null;

  useEffect(() => {
    if (!owner || auth.state !== "authenticated") return;
    let factoryId = "";
    try { factoryId = window.sessionStorage.getItem(`safetyproof-dashboard-factory:${owner}`) ?? ""; } catch { /* Storage is optional. */ }
    setChoice({ owner, factoryId, caseId: "" });
  }, [auth.state, owner]);
  useEffect(() => {
    if (choice.owner !== owner || !selectedFactoryId) return;
    try { window.sessionStorage.setItem(`safetyproof-dashboard-factory:${owner}`, selectedFactoryId); } catch { /* Storage is optional. */ }
  }, [choice.owner, owner, selectedFactoryId]);

  useEffect(() => {
    if (!token || !owner || auth.state !== "authenticated") return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const scope = await loadDashboardScope(auth.profile!, <T,>(path: string) => api<T>(path, token, "GET", undefined, controller.signal));
        if (!controller.signal.aborted) setCaseData({ owner, scope, error: "" });
      } catch (caught) {
        if (!controller.signal.aborted) setCaseData({ owner, scope: { factories: [], cases: [] }, error: message(caught) });
      } finally { running = false; }
    };
    void refresh();
    const interval = window.setInterval(refresh, 20000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [auth.state, auth.profile?.role, owner, token]);

  useEffect(() => {
    if (!token || !owner || !selectedCaseId || auth.state !== "authenticated") return;
    const controller = new AbortController();
    let running = false;
    const refresh = async () => {
      if (running) return;
      running = true;
      try {
        const dossier = await api<Dossier>(`/v1/cases/${selectedCaseId}`, token, "GET", undefined, controller.signal);
        if (dossier.case.id !== selectedCaseId || dossier.case.factory !== selected.factory?.name) throw new Error("Case response does not match the selected authorized scope.");
        const data = await loadDashboardData(dossier, <T,>(path: string) => api<T>(path, token, "GET", undefined, controller.signal));
        if (!controller.signal.aborted) setSnapshot({ key, data, error: "" });
      } catch (caught) {
        if (!controller.signal.aborted) setSnapshot({ key, data: null, error: message(caught) });
      } finally { running = false; }
    };
    void refresh();
    const interval = window.setInterval(refresh, 20000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [auth.state, key, owner, selectedCaseId, selected.factory?.name, token]);

  const data = current?.data;
  return {
    accountState: auth.state === "loading" ? "restoring" : caseData.owner === owner ? "ready" : "loading",
    evidenceState: current?.error ? "error" : data ? "ready" : selectedCaseId ? "loading" : "idle",
    error: current?.error || (caseData.owner === owner ? caseData.error : ""),
    profile: auth.profile, token, cases, factoryCases: cases, factories: scope.factories,
    selectedFactory: selected.factory?.name ?? "", selectedFactoryId,
    setSelectedFactoryId: (factoryId: string) => {
      if (auth.profile?.role === "reviewer" && scope.factories.some((f) => f.id === factoryId)) setChoice({ owner, factoryId, caseId: "" });
    },
    selectedCaseId, setSelectedCaseId: (caseId: string) => {
      if (cases.some((c) => c.id === caseId)) setChoice({ owner, factoryId: selectedFactoryId, caseId });
    },
    dossier: data?.dossier ?? null,
    data: data ?? null,
    documentError: data?.documentError ?? "", historyRestricted: data?.historyRestricted ?? false,
    run: data ? latestReadableRun(data.dossier) : undefined,
    results: data?.results ?? [], history: data?.history ?? [], board: data?.board ?? null,
    boardError: data?.boardError ?? "", resultsError: data?.resultsError ?? "",
    realMode: auth.state === "authenticated" && caseData.owner === owner,
  };
}
