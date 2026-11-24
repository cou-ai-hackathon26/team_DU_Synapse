import type { Case } from "./api";
import type { ReadDashboard } from "./dashboard-data";

export type FactoryOption = { id: string; name: string };
export type DashboardProfile = { id: string; role: string; factory_id: string | null };
export type DashboardScope = { factories: FactoryOption[]; cases: Case[] };

export async function loadDashboardScope(profile: DashboardProfile, read: ReadDashboard): Promise<DashboardScope> {
  if (profile.role === "admin") return { factories: [], cases: [] };
  const [cases, assignments] = await Promise.all([
    read<Case[]>("/v1/cases"),
    profile.role === "reviewer"
      ? read<{ factories: FactoryOption | null }[]>("/v1/reviewer/factories").then((rows) => rows.flatMap((r) => r.factories ? [r.factories] : []))
      : profile.role === "factory_manager"
        ? read<{ factory: FactoryOption }>("/v1/manager/work").then(({ factory }) => {
            if (!profile.factory_id || factory.id !== profile.factory_id) throw new Error("Assigned factory could not be verified. Refresh your account.");
            return [factory];
          })
        : Promise.resolve(null),
  ]);
  // Viewers retain only their case-derived read scope; reviewer/manager options
  // always come from their existing role-protected assignment endpoints.
  const factories = assignments ?? [...new Set(cases.map((c) => c.factory))].map((name) => ({ id: name, name }));
  const unique = [...new Map(factories.map((f) => [f.id, f])).values()];
  return { factories: unique, cases: cases.filter((c) => unique.some((f) => f.name === c.factory)) };
}

export function selectDashboardScope(scope: DashboardScope, factoryChoice: string, caseChoice: string) {
  const factory = scope.factories.find((f) => f.id === factoryChoice) ?? scope.factories[0];
  // CaseRecord currently exposes the unique factory name, not factory_id.
  const cases = factory ? scope.cases.filter((c) => c.factory === factory.name) : [];
  const selectedCase = cases.find((c) => c.id === caseChoice) ?? cases[0];
  return { factory, cases, selectedCase };
}
