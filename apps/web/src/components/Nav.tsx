"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { HeadTick } from "./zh";
import { ThemeToggle } from "./ThemeToggle";

export const LINKS = [
  { href: "/live/", label: "Live bell" },
  { href: "/seal/", label: "Seal a message" },
  { href: "/how/", label: "How it works" },
  { href: "/security/", label: "Security" },
  { href: "/keypers/", label: "Keypers" },
  { href: "/ledger/", label: "Ledger" },
];

export function Nav() {
  const path = usePathname();
  const home = path === "/";
  const here = (h: string) => path === h || path + "/" === h || (h !== "/" && path.startsWith(h.replace(/\/$/, "")));
  return (
    <header className={cn("top", home && "top-dark")}>
      <div className="wrap">
        <Link href="/" className="mark"><i aria-hidden />ZeroHour</Link>
        <nav className="nav hidden md:flex" aria-label="Main">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={here(l.href) ? "page" : undefined}>{l.label}</Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden xl:flex"><HeadTick /></span>
          <ThemeToggle className={home ? "text-white hover:bg-white/10 hover:text-white" : ""} />
          <Button asChild size="lg" className={cn("hidden sm:inline-flex", home && "bg-[var(--omr)] text-white hover:bg-[var(--omr)]/85")}>
            <Link href="/exam/?id=0x53cf9dc20c56b3abec5f0763981dab01f541fdb78cff5bc650c0c9d80e8670b0">See a real exam</Link>
          </Button>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-lg" className="md:hidden" aria-label="Open menu"><Menu /></Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 bg-[var(--paper)] p-6">
              <SheetTitle className="mark mb-6"><i aria-hidden />ZeroHour</SheetTitle>
              <nav className="grid gap-4 text-lg font-semibold" aria-label="Mobile">
                <Link href="/">Home</Link>
                {LINKS.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
              </nav>
              <div className="mt-8 text-sm"><HeadTick /></div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-foot">
      <div className="wrap foot-grid">
        <div>
          <Link href="/" className="mark"><i aria-hidden />ZeroHour</Link>
          <p className="muted small mt-3">Exam papers that nobody can open before the bell. Built for QoreChain&apos;s Build Before Q-Day.</p>
        </div>
        <div>
          <h3>Product</h3>
          {LINKS.slice(0, 4).map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </div>
        <div>
          <h3>Proof</h3>
          <Link href="/ledger/">Release ledger</Link>
          <a href="https://explore.qore.network/address/0x3494389A2C3BC5ea6cc0749F23C6a864aEE9c250" target="_blank" rel="noreferrer">ZeroHourExam contract</a>
          <a href="https://explore.qore.network/address/0x5CF8c43C52483bF09F9a32D07a614250bd60f1AA" target="_blank" rel="noreferrer">HourglassRegistry contract</a>
          <a href="https://github.com/Nixon-CSE/zerohour" target="_blank" rel="noreferrer">Source code</a>
        </div>
      </div>
      <div className="wrap muted small foot-note">Every number on this site is read from QoreChain testnet (chain id 9800) and checked in your browser. Nothing here is served by a ZeroHour backend.</div>
    </footer>
  );
}
