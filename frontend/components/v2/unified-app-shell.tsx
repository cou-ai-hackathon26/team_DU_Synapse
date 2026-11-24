"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import {
  Building2,
  CalendarCheck2,
  ChevronDown,
  ClipboardCheck,
  FileCheck2,
  Files,
  FolderOpen,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
  UserCheck,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  activeShellKey,
  shellNavigation,
  shellTitle,
  type ShellNavKey,
} from "@/lib/app-navigation";
import { useAuth } from "./auth-provider";
import { ThemeToggle } from "./theme-toggle";

const icons: Record<ShellNavKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  factories: Building2,
  reviewers: Users,
  assignments: Network,
  inspections: CalendarCheck2,
  applications: UserCheck,
  cases: FolderOpen,
  documents: Files,
  review: FileCheck2,
  corrective: ClipboardCheck,
};

export function UnifiedAppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname !== "/dashboard" && pathname !== "/workspace") return children;
  return <UnifiedAppShell>{children}</UnifiedAppShell>;
}

function UnifiedAppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const auth = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const query = searchParams.toString();

  useEffect(() => {
    setCollapsed(window.localStorage.getItem("safetyproof-sidebar") === "collapsed");
  }, []);
  useEffect(() => {
    window.localStorage.setItem("safetyproof-sidebar", collapsed ? "collapsed" : "expanded");
  }, [collapsed]);
  useEffect(() => {
    setMobileOpen(false);
    setAccountOpen(false);
  }, [pathname, query]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileOpen(false);
        setAccountOpen(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  if (auth.state !== "authenticated") return children;

  const role = auth.profile?.role;
  const view = searchParams.get("view");
  const links = shellNavigation(role, searchParams.get("case") || "", searchParams.get("run") || "");
  const activeKey = activeShellKey(pathname, view);
  const accountName = auth.profile?.full_name || auth.profile?.email || "SafetyProof account";

  async function signOut() {
    await auth.signOut();
    router.replace("/login");
  }

  return (
    <main
      className={`v2-page analytics-shell unified-app-shell ${collapsed ? "sidebar-collapsed" : ""}`}
      data-testid="safetyproof-app-shell"
    >
      {mobileOpen && <button className="dashboard-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside className={`analytics-sidebar ${mobileOpen ? "mobile-open" : ""}`} aria-label="Application navigation">
        <div className="sidebar-brand">
          <span><ShieldCheck /></span>
          {!collapsed && <strong>SafetyProof <em>AI</em></strong>}
          <button className="mobile-sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X /></button>
        </div>
        <nav>
          {links.map(({ key, label, href }) => {
            const Icon = icons[key];
            return (
              <Link key={key} href={href} className={activeKey === key ? "active" : ""} title={collapsed ? label : undefined} aria-label={label}>
                <Icon /><span>{label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom"><Link href="/" aria-label="Public home"><Building2 /><span>Public home</span></Link></div>
      </aside>

      <section className="analytics-main">
        <header className="analytics-topbar">
          <div className="dashboard-title-group">
            <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></button>
            <button className="collapse-button" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</button>
            <div><span className="v2-eyebrow">Authorized workspace</span><h1>{shellTitle(pathname, view)}</h1></div>
          </div>
          <div className="dashboard-top-actions">
            <ThemeToggle />
            <div className="dashboard-account">
              <button className="dashboard-account-trigger" onClick={() => setAccountOpen((value) => !value)} aria-expanded={accountOpen}>
                <span>{accountName[0].toUpperCase()}</span>
                <div><strong>{accountName}</strong><small>{role?.replaceAll("_", " ")}</small></div>
                <ChevronDown />
              </button>
              {accountOpen && (
                <div className="account-popover">
                  <div className="account-popover-profile"><strong>{auth.profile?.email}</strong><span>{role?.replaceAll("_", " ")}</span></div>
                  <button onClick={() => void signOut()}><LogOut />Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="unified-shell-content">{children}</div>
      </section>
    </main>
  );
}
