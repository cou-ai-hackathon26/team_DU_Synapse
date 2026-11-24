export type ShellNavKey =
  | "dashboard"
  | "factories"
  | "reviewers"
  | "assignments"
  | "inspections"
  | "applications"
  | "cases"
  | "documents"
  | "review"
  | "corrective";

export type ShellNavItem = {
  key: ShellNavKey;
  label: string;
  href: string;
};

function workspaceHref(view: string, caseId = "", runId = "") {
  const params = new URLSearchParams();
  if (caseId) params.set("case", caseId);
  if (view !== "cases") params.set("view", view);
  if (runId) params.set("run", runId);
  return `/workspace${params.size ? `?${params}` : ""}`;
}

export function shellNavigation(
  role: string | null | undefined,
  caseId = "",
  runId = "",
): ShellNavItem[] {
  const dashboard: ShellNavItem = {
    key: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
  };

  if (role === "admin") {
    return [
      dashboard,
      { key: "factories", label: "Factories", href: workspaceHref("factories") },
      { key: "reviewers", label: "Reviewers", href: workspaceHref("reviewers") },
      { key: "assignments", label: "Assignments", href: workspaceHref("factory-assignments") },
      { key: "inspections", label: "Inspections", href: workspaceHref("scheduled-inspections") },
      { key: "applications", label: "Manager applications", href: workspaceHref("manager-applications") },
    ];
  }

  const items: ShellNavItem[] = [
    dashboard,
    { key: "cases", label: role === "factory_manager" ? "Factory cases" : "Review cases", href: workspaceHref("cases") },
  ];

  if (caseId) {
    items.push(
      { key: "documents", label: "Documents", href: workspaceHref("documents", caseId) },
      role === "factory_manager"
        ? { key: "corrective", label: "Corrective work", href: workspaceHref("corrective", caseId) }
        : { key: "review", label: "Evidence review", href: workspaceHref("review", caseId, runId) },
    );
  }

  return items;
}

export function activeShellKey(pathname: string, view: string | null): ShellNavKey {
  if (pathname === "/dashboard") return "dashboard";
  switch (view) {
    case "reviewers": return "reviewers";
    case "factory-assignments": return "assignments";
    case "scheduled-inspections": return "inspections";
    case "manager-applications": return "applications";
    case "documents": return "documents";
    case "review":
    case "cap":
    case "history": return "review";
    case "corrective": return "corrective";
    case "factories": return "factories";
    default: return "cases";
  }
}

export function shellTitle(pathname: string, view: string | null) {
  if (pathname === "/dashboard") return "Analytics Dashboard";
  const titles: Record<string, string> = {
    factories: "Factories",
    reviewers: "Reviewers",
    "factory-assignments": "Factory assignments",
    "scheduled-inspections": "Scheduled inspections",
    "manager-applications": "Manager applications",
    documents: "Documents",
    review: "Evidence review",
    cap: "CAP matching",
    history: "Run history",
    corrective: "Corrective work",
    overview: "Case overview",
    library: "Document library",
    cases: "Cases",
  };
  return titles[view || "cases"] || "Workspace";
}
