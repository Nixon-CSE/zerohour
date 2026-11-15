"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { addrUrl, chainHead, short, txUrl } from "@/lib/chain";

/** Load once on mount; `deps` reloads. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [s, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    set((p) => ({ ...p, loading: true }));
    fn().then((data) => live && set({ data, loading: false }), (e) => live && set({ error: String(e?.shortMessage ?? e?.message ?? e), loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return s;
}

/** False during the static prerender and the first client render, so time-based text never mismatches. */
export function useMounted() {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return m;
}

/* -------- chain clock: unlocks are judged by block time, so the page shows block time -------- */
type Clock = { block: bigint; chainTime: number; offset: number; seenAt: number } | null;
let clock: Clock = null;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
async function poll() {
  try {
    const h = await chainHead();
    clock = { block: h.number, chainTime: h.time, offset: h.time - Date.now() / 1000, seenAt: Date.now() };
  } catch { /* keep the last head; the header marks it stale */ }
  subs.forEach((f) => f());
}
function subscribe(f: () => void) {
  subs.add(f);
  if (!timer) { poll(); timer = setInterval(poll, 4000); }
  return () => { subs.delete(f); if (!subs.size && timer) { clearInterval(timer); timer = null; } };
}
export const useHead = () => useSyncExternalStore(subscribe, () => clock, () => null);

/** Seconds on the chain's clock, ticking locally between polls. */
export function useChainNow() {
  const head = useHead();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  return head ? now / 1000 + head.offset : now / 1000;
}

export function HeadTick() {
  const head = useHead();
  const stale = !head || Date.now() - head.seenAt > 15000;
  return (
    <span className="head-tick" aria-live="off">
      <span className={`dot ${stale ? "stale" : ""}`} aria-hidden />
      {head ? (<>QoreChain testnet block <b>{head.block.toLocaleString()}</b></>) : "connecting to QoreChain testnet"}
    </span>
  );
}

/* -------- formatting -------- */
export const utc = (t: number, sec = true) =>
  new Date(t * 1000).toISOString().replace("T", " ").slice(0, sec ? 19 : 16) + " UTC";
export const hms = (t: number) => new Date(t * 1000).toISOString().slice(11, 19);
export function span(s: number) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return d ? `${d}d ${p(h)}:${p(m)}:${p(x)}` : h ? `${h}:${p(m)}:${p(x)}` : `${p(m)}:${p(x)}`;
}
export function ago(s: number) {
  s = Math.abs(Math.round(s));
  if (s < 90) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

export function Hash({ v, kind, n = 6 }: { v: string; kind?: "tx" | "addr"; n?: number }) {
  const [copied, setCopied] = useState(false);
  const text = short(v, n);
  const copy = () => navigator.clipboard?.writeText(v).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); });
  return (
    <span className="hash" title={v}>
      {kind ? <a href={kind === "tx" ? txUrl(v) : addrUrl(v)} target="_blank" rel="noreferrer">{text}</a> : <button onClick={copy} aria-label={`Copy ${v}`}>{copied ? "copied" : text}</button>}
    </span>
  );
}

/** One OMR bubble per keyper. Filled means that keyper's seed for the round is public. */
export function Bubbles({ items }: { items: { label: string; on: boolean; bad?: boolean; note: string }[] }) {
  return (
    <div className="bubbles" role="list">
      {items.map((b, i) => (
        <div key={i} role="listitem" className={`bubble ${b.on ? "on" : ""} ${b.bad ? "bad" : ""}`} aria-label={`${b.label}: ${b.note}`}>
          <span className="o">{b.label}</span>
          <span className="t">{b.note}</span>
        </div>
      ))}
    </div>
  );
}

export function Verdict({ ok, yes, no }: { ok: boolean | undefined; yes: string; no: string }) {
  if (ok === undefined) return <span className="pending">checking…</span>;
  return <span className={ok ? "ok tick" : "no cross"}>{ok ? yes : no}</span>;
}
