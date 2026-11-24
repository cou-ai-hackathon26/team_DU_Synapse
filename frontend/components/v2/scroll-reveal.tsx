"use client";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

type RevealDirection = "left" | "right" | "up";
type RevealElement = "div" | "section";

type ScrollRevealProps = {
  as?: RevealElement;
  children: ReactNode;
  className?: string;
  delay?: number;
  direction?: RevealDirection;
  id?: string;
};

const callbacks = new WeakMap<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

function observer() {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          callbacks.get(entry.target)?.();
          callbacks.delete(entry.target);
          sharedObserver?.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10%", threshold: 0.12 },
    );
  }
  return sharedObserver;
}

export function ScrollReveal({
  as: Element = "section",
  children,
  className = "",
  delay = 0,
  direction = "up",
  id,
}: ScrollRevealProps) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!node || reduceMotion || !("IntersectionObserver" in window)) {
      setVisible(true);
      return;
    }

    callbacks.set(node, () => setVisible(true));
    observer().observe(node);
    return () => {
      callbacks.delete(node);
      sharedObserver?.unobserve(node);
    };
  }, []);

  const style = { "--reveal-delay": `${delay}ms` } as CSSProperties;

  return (
    <Element
      className={`scroll-reveal reveal-${direction} ${className}`.trim()}
      data-reveal-state={visible ? "visible" : "pending"}
      id={id}
      ref={ref as never}
      style={style}
    >
      {children}
    </Element>
  );
}
