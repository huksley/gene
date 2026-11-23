import { useEffect, useState } from "react";
import { prefs } from "./api";

type Theme = "light" | "dark";

const system = (): Theme => (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

/** Follows the OS until the viewer picks one; the pick is remembered. */
export const useTheme = (): [Theme, () => void] => {
  const [theme, setTheme] = useState<Theme>(() => (prefs.get("theme") as Theme | null) ?? system());
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);
  useEffect(() => {
    if (prefs.get("theme")) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setTheme(system());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const toggle = () =>
    setTheme(t => {
      const next = t === "dark" ? "light" : "dark";
      prefs.set("theme", next);
      return next;
    });
  return [theme, toggle];
};
