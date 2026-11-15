"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { bytesToHex, hexToBytes, k256 } from "@zerohour/hourglass";
import type { Hex } from "viem";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { centreLabel, examTitle } from "@/lib/names";
import { Bubbles, Hash, Verdict, hms, span, useAsync, useChainNow, utc } from "@/components/zh";
import { eq, loadExam, publicFile, sealedFor, verifyFairness, type ExamView, type TimelineEntry } from "@/lib/exam";

const describe = (t: TimelineEntry, v: ExamView) => {
  const k = (a: string) => `K${v.onchain.keypers.findIndex((x) => eq(x, a)) + 1}`;
  const c = (a: string) => centreLabel(v.centres.find((x) => eq(x.address, a))?.name ?? a);
  switch (t.kind) {
    case "created": return `Board created the exam: rounds ${t.args.roundA} (paper A) and ${t.args.roundB} (backup B), ${t.args.threshold} of ${t.args.keypers.length} keypers`;
    case "centre": return `Board registered ${c(t.args.centre)} with its ciphertext hashes and permutation commitment`;
    case "release": return `${k(t.args.keyper)} posted its round ${t.args.round} seed`;
    case "opened": return `${c(t.args.centre)} opened ${t.args.backup ? "backup paper B" : "paper A"} and filed an ML-DSA-87 signed receipt`;
    case "leak": return `Leak Hunter reported a leaked copy traced to ${c(t.args.centre)} (confidence ${(t.args.confidenceBps / 100).toFixed(2)}%)`;
    case "switched": return "Board switched every centre to the pre-sealed backup paper";
    case "revealed": return "Board revealed the canonical paper and permutation seeds";
    case "slashed": return `${k(t.args.keyper)} was slashed for an early seed`;
  }
};

function Centres({ v }: { v: ExamView }) {
  const backup = v.onchain.usingBackup;
  const checks = useAsync(() => Promise.all(v.centres.map((c) => sealedFor(v, c.address, backup))), [v.id]);
  return (
    <div className="cards">
      {v.centres.map((c, i) => {
        const chk = checks.data?.[i];
        return (
          <article key={c.address} className="card">
            <header>
              <div>
                <h3>{centreLabel(c.name)}</h3>
                <Hash v={c.address} kind="addr" n={4} />
              </div>
              {c.leakReports ? <Badge variant="destructive">{c.leakReports} leak report{c.leakReports > 1 ? "s" : ""}</Badge> : c.openedAt ? <Badge className="bg-[var(--pen-tint)] text-[var(--pen)]">Opened</Badge> : <Badge variant="secondary">Sealed</Badge>}
            </header>
            <dl>
              <div><dt>Published ciphertext</dt><dd><Hash v={backup ? c.ctHashB : c.ctHashA} /><br />{checks.loading ? <span className="pending">checking…</span> : chk?.sealed ? <Verdict ok={chk.matches} yes="file matches on-chain hash" no="file does not match" /> : <span className="muted">no public copy here</span>}</dd></div>
              <div><dt>Opened</dt><dd>{c.openedAt ? <>{utc(c.openedAt)}<br /><span className="muted small">{c.openedAt - v.unlockAt} s after the bell</span></> : <span className="muted">not yet</span>}</dd></div>
            </dl>
            <Button asChild variant="outline" size="lg"><Link href={`/open/?id=${v.id}&centre=${c.address}`}>Open as this centre <ArrowRight /></Link></Button>
          </article>
        );
      })}
    </div>
  );
}

function Leaks({ v }: { v: ExamView }) {
  const leaks = v.timeline.filter((t) => t.kind === "leak");
  const files = useAsync(async () => Promise.all(leaks.map((l) => (v.dir ? publicFile<{ envelope: Hex; evidenceHash: Hex }>(v.dir, `leak-${(l.args.evidenceHash as string).slice(0, 10)}.sealed.json`) : null))), [v.id]);
  if (!leaks.length) return <p className="muted">No leak reports filed.</p>;
  return (
    <div className="cards">
      {leaks.map((l, i) => {
        const f = files.data?.[i];
        const ok = f ? eq(bytesToHex(k256(hexToBytes(f.envelope))), l.args.sealedEvidenceRef) : undefined;
        const name = v.centres.find((c) => eq(c.address, l.args.centre))?.name ?? l.args.centre;
        return (
          <article key={l.tx} className="card alert">
            <header>
              <div><h3>Traced to {centreLabel(name)}</h3><span className="muted small">{l.time ? utc(l.time) : ""}</span></div>
              <Badge variant="destructive">{(l.args.confidenceBps / 100).toFixed(2)}% confidence</Badge>
            </header>
            <dl>
              <div><dt>Evidence hash</dt><dd><Hash v={l.args.evidenceHash} /></dd></div>
              <div><dt>Sealed evidence</dt><dd>{f ? <><Verdict ok={ok} yes="envelope matches on-chain ref" no="envelope mismatch" /><br /><span className="muted small">QoreSeal-sealed to the board, {Math.round(f.envelope.length / 2 / 1024)} KB</span></> : <span className="muted">not published</span>}</dd></div>
              <div><dt>Report</dt><dd><Hash v={l.tx} kind="tx" n={4} /></dd></div>
            </dl>
          </article>
        );
      })}
    </div>
  );
}

const pretty = (label: string) => label.replace(/^(centre-[a-z]+-\d+)/, (m) => centreLabel(m));

function Fairness({ v }: { v: ExamView }) {
  const f = useAsync(() => verifyFairness(v), [v.id]);
  if (!v.onchain.revealed) return <p className="muted">The board reveals the canonical paper and permutation seeds after the exam. Until then this stays sealed.</p>;
  if (f.loading) return <p className="pending">Recomputing commitments…</p>;
  if (!f.data?.reveal) return <p className="muted">Revealed on chain, but the reveal file is not published with this site.</p>;
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {f.data.checks.map((c) => (
        <li key={c.label} style={{ marginBottom: 8 }}><Verdict ok={c.ok} yes={pretty(c.label)} no={pretty(c.label)} />{" "}{c.detail.startsWith("0x") ? <Hash v={c.detail} /> : <span className="hash muted keyline">answer key {c.detail}</span>}</li>
      ))}
    </ul>
  );
}

function Exam({ id }: { id: Hex }) {
  const s = useAsync(() => loadExam(id), [id]);
  const now = useChainNow();
  if (s.error) return <p className="err">Could not load exam {id}: {s.error}</p>;
  const v = s.data;
  if (!v) return <p className="pending">Reading exam {id.slice(0, 10)} from QoreChain…</p>;
  const round = v.activeRound;
  const bubbles = v.keypers.map((k, i) => {
    const rel = v.timeline.find((t) => t.kind === "release" && eq(t.args.keyper, k.address) && Number(t.args.round) >= round);
    const on = round < k.nextRound;
    return { label: `K${i + 1}`, on, bad: k.slashed, note: k.slashed ? "slashed" : on && rel?.time ? `+${rel.time - v.unlockAt} s` : on ? "released" : "sealed" };
  });
  const before = !v.unlocked && now < v.unlockAt;
  return (
    <>
      <h1>{examTitle(v.manifest?.exam, v.id)}</h1>
      <p className="muted" style={{ marginTop: 10 }}>{v.onchain.revealed ? <Badge className="mr-2 bg-[var(--pen-tint)] text-[var(--pen)]">Fairness proven</Badge> : null}<Hash v={v.id} n={10} /> by board <Hash v={v.onchain.board} kind="addr" n={4} /></p>

      <div className="bell">
        <div className="when">{v.onchain.usingBackup ? "Backup paper B" : "Paper A"}, round {round}, bell at {utc(v.unlockAt)}</div>
        <div className={`clock ${before ? "" : "open"}`} role={before ? "timer" : undefined}>{before ? span(v.unlockAt - now) : <>{hms(v.unlockAt)}<small>UTC</small></>}</div>
        <Bubbles items={bubbles} />
        <p className="rule-line">{v.onchain.threshold} of {v.keypers.length} keyper seeds open the time lock. {v.unlocked ? "The contract reports it unlocked." : "The contract still reports it locked."}</p>
      </div>

      <section><h2>Centres</h2><Centres v={v} /></section>
      <section><h2>Leaks</h2><Leaks v={v} /></section>
      <section className="grid2">
        <div><h2>What happened</h2>
          <ol className="timeline">
            {v.timeline.map((t) => (
              <li key={t.tx + t.kind + (t.args.keyper ?? t.args.centre ?? "")} className={t.kind === "leak" || t.kind === "slashed" ? "alert" : "done"}>
                <time>{t.time ? utc(t.time) : ""}</time>
                {describe(t, v)} <Hash v={t.tx} kind="tx" n={4} />
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h2>Fairness</h2>
          <p className="muted small">Every centre gets the same questions in a different order. After the exam anyone can check that.</p>
          <Fairness v={v} />
        </div>
      </section>
    </>
  );
}

function Inner() {
  const id = useSearchParams().get("id");
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) return <p>Pick an exam from the <Link href="/">bell page</Link>.</p>;
  return <Exam id={id as Hex} />;
}

export default function Page() {
  return <Suspense fallback={<p className="pending">Loading…</p>}><Inner /></Suspense>;
}
