export type ThemeMode = "light" | "dark";

export const serverTheme: ThemeMode = "light";

export function validTheme(value: string | undefined): ThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function oppositeTheme(theme: ThemeMode): ThemeMode {
  return theme === "light" ? "dark" : "light";
}
