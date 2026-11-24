"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  oppositeTheme,
  serverTheme,
  type ThemeMode,
  validTheme,
} from "@/lib/theme";

type ThemeContextValue = {
  theme: ThemeMode;
  ready: boolean;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeMode>(serverTheme);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTheme(validTheme(document.documentElement.dataset.theme));
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("safetyproof-theme", theme);
  }, [ready, theme]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      ready,
      setTheme,
      toggleTheme: () => setTheme((current) => oppositeTheme(current)),
    }),
    [ready, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used within ThemeProvider");
  return value;
}
