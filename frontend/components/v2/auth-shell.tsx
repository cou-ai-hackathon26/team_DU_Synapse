import Link from "next/link";
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { AnimatedGarmentFactory } from "./animated-garment-factory";
import { ThemeToggle } from "./theme-toggle";

type AuthShellProps = {
  children: ReactNode;
  contextDescription: string;
  contextTitle: string;
  description: string;
  eyebrow: string;
  note: string;
  noteTitle: string;
  panelClassName?: string;
  title: string;
};

export function AuthShell({
  children,
  contextDescription,
  contextTitle,
  description,
  eyebrow,
  note,
  noteTitle,
  panelClassName = "",
  title,
}: AuthShellProps) {
  return (
    <main className="v2-page login-page auth-page">
      <div className="login-scene" aria-hidden="true">
        <AnimatedGarmentFactory compact />
      </div>
      <div className="login-vignette" />
      <header className="login-header v2-container">
        <Link href="/" className="public-brand industrial-brand">
          <span><ShieldCheck /></span>
          <strong>SafetyProof <em>AI</em></strong>
        </Link>
        <div><Link href="/">Public home</Link><ThemeToggle /></div>
      </header>

      <div className="login-layout v2-container">
        <section className="login-context" aria-label="SafetyProof introduction">
          <span className="industrial-kicker"><i /> Controlled evidence workspace</span>
          <h1>{contextTitle}</h1>
          <p>{contextDescription}</p>
          <div className="login-context-note">
            <ShieldCheck />
            <span><strong>{noteTitle}</strong>{note}</span>
          </div>
        </section>

        <section className={`login-form-wrap login-glass-panel auth-panel-enter ${panelClassName}`.trim()}>
          <span className="v2-eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
          {children}
        </section>
      </div>
    </main>
  );
}
