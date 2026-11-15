"use client";
import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** Light / dark switch. The choice is remembered; without one the system setting applies. */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.dataset.theme === "dark"), []);
  const flip = () => {
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("zh-theme", next); } catch { /* private mode: applies for this visit only */ }
    setDark(!dark);
  };
  return (
    <Button variant="ghost" size="icon-lg" onClick={flip} className={className} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
