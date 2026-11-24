"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "./theme-provider";

export function ThemeToggle() {
  const { ready, theme, toggleTheme } = useTheme();
  const nextTheme = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className="v2-theme-toggle"
      onClick={toggleTheme}
      aria-label={ready ? `Switch to ${nextTheme} theme` : "Change color theme"}
      title={ready ? `Use ${nextTheme} theme` : "Change color theme"}
    >
      {ready && theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
}
