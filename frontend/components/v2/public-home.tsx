"use client";

import Link from "next/link";
import { Building2, CheckCircle2, ClipboardCheck, FileSearch, Files, ScanSearch, ShieldCheck, Users } from "lucide-react";
import { AnimatedGarmentFactory } from "./animated-garment-factory";
import { ScrollReveal } from "./scroll-reveal";
import { ThemeToggle } from "./theme-toggle";
import { useAuth } from "./auth-provider";

const steps = [
  [Files, "Upload documents"],
  [ScanSearch, "Analyze evidence"],
  [ClipboardCheck, "Review findings"],
  [CheckCircle2, "Track resolution"],
] as const;

export function PublicHome() {
  const { state } = useAuth();
  const authenticated = state === "authenticated";
  return (
    <main className="v2-page public-home">
      <noscript><style>{`.scroll-reveal,.scroll-reveal>*{opacity:1!important;transform:none!important}`}</style></noscript>
      <section className="industrial-hero">
        <div className="industrial-scene" aria-hidden="true">
          <AnimatedGarmentFactory celestialSky />
        </div>
        <div className="industrial-vignette" />
        <header className="public-header v2-container">
          <Link href="/" className="public-brand industrial-brand" aria-label="SafetyProof AI home">
            <span><ShieldCheck aria-hidden="true" /></span>
            <strong>SafetyProof <em>AI</em></strong>
          </Link>
          <nav aria-label="Public navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#features">Capabilities</a>
            <a href="#roles">Access</a>
          </nav>
          <div className="public-actions">
            <ThemeToggle />
            <Link className="v2-button glass-button" href={authenticated ? "/dashboard" : "/login"}>
              {authenticated ? "Open dashboard" : "Go to login"}
            </Link>
          </div>
        </header>

        <div className="industrial-hero-content v2-container">
          <aside className="industrial-status-panel hero-panel-enter hero-panel-enter-left">
            <span>System purpose</span>
            <strong>Documentary evidence review</strong>
            <p>AI assistance supports review. It does not replace professional inspection or certify factory safety.</p>
          </aside>
          <div className="industrial-hero-panel hero-panel-enter hero-panel-enter-right">
            <span className="industrial-kicker"><i /> Evidence operations platform</span>
            <h1>Turn safety documents into verifiable evidence.</h1>
            <p>SafetyProof AI connects workplace-safety findings to exact documentary sources, giving garment factories and professional reviewers one controlled evidence workspace.</p>
            <div className="hero-actions">
              <Link className="v2-button" href={authenticated ? "/dashboard" : "/login"}>{authenticated ? "Open dashboard" : "Go to login"}</Link>
              <a className="v2-button glass-button" href="#about">Learn more</a>
            </div>
            <div className="industrial-capabilities" aria-label="Platform principles">
              <span><ShieldCheck />Role controlled</span>
              <span><FileSearch />Source cited</span>
              <span><Users />Human reviewed</span>
            </div>
          </div>
        </div>
      </section>

      <ScrollReveal id="about" className="public-section v2-container about-grid industrial-section" direction="left">
        <div>
          <span className="v2-eyebrow">What is SafetyProof AI?</span>
          <h2>A traceable workspace for evidence-backed review</h2>
        </div>
        <p>Authorized factory personnel and independent reviewers can organize inspection records, compare claims with supporting documents, inspect exact source pages, and track corrective work through the existing application.</p>
      </ScrollReveal>

      <ScrollReveal id="how-it-works" className="public-section v2-container reveal-stagger" direction="right">
        <div className="section-heading"><span className="v2-eyebrow">How it works</span><h2>From document to reviewed finding</h2></div>
        <div className="process-grid">
          {steps.map(([Icon, step]) => (
            <article className="v2-card process-card" key={step}>
              <span><Icon aria-hidden="true" /></span><strong>{step}</strong>
            </article>
          ))}
        </div>
      </ScrollReveal>

      <ScrollReveal id="features" className="public-section v2-container reveal-stagger" direction="left">
        <div className="section-heading"><span className="v2-eyebrow">Main features</span><h2>Evidence stays connected to its source</h2></div>
        <div className="feature-grid">
          {[
            [Files, "Document workspace", "Upload and organize authorized inspection, incident, procedure, maintenance, and corrective-action records."],
            [FileSearch, "Source-cited findings", "Review evidence with document names, quoted passages, page numbers, and validated citation locations."],
            [CheckCircle2, "Human review", "Confirm, reject, or follow up on findings through the existing reviewer workflow."],
            [Building2, "Factory-scoped access", "Keep cases and evidence within the role and factory permissions enforced by the backend."],
          ].map(([Icon, title, description]) => {
            const FeatureIcon = Icon as typeof Files;
            return <article className="v2-card feature-card" key={String(title)}><FeatureIcon aria-hidden="true" /><h3>{String(title)}</h3><p>{String(description)}</p></article>;
          })}
        </div>
      </ScrollReveal>

      <ScrollReveal id="roles" className="public-section v2-container roles-section reveal-stagger" direction="right">
        <div className="section-heading"><span className="v2-eyebrow">User roles</span><h2>One evidence chain, role-appropriate tools</h2></div>
        <div className="roles-grid">
          <article><Users /><div><strong>Reviewers and auditors</strong><p>Assess cases, inspect citations, review findings, and coordinate corrective work.</p></div></article>
          <article><Building2 /><div><strong>Factory managers</strong><p>Access assigned factory cases, documents, inspection notices, and corrective tasks.</p></div></article>
          <article><ShieldCheck /><div><strong>Administrators</strong><p>Manage factories, account access, assignments, applications, and scheduled inspections.</p></div></article>
        </div>
      </ScrollReveal>

      <ScrollReveal className="public-section v2-container getting-started v2-card" direction="up" delay={70}>
        <div><span className="v2-eyebrow">Getting started</span><h2>Continue with your authorized SafetyProof account</h2><p>Sign in to reach the analytics dashboard and the workflows permitted for your role.</p></div>
        <Link className="v2-button" href={authenticated ? "/dashboard" : "/login"}>{authenticated ? "Open dashboard" : "Sign in securely"}</Link>
      </ScrollReveal>

      <footer className="public-footer v2-container"><span>SafetyProof AI</span><span>Documentary evidence review · CoU AI Hackathon 2026</span></footer>
    </main>
  );
}
