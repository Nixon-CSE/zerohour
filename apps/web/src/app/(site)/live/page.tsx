"use client";
import Link from "next/link";
import { formatEther } from "viem";
import { Bubbles, Hash, ago, hms, span, useAsync, useChainNow, utc } from "@/components/zh";
import { allExams, registryState, revealOf, type ExamSummary, type Release } from "@/lib/overview";
import { eq } from "@/lib/exam";
import { examTitle } from "@/lib/names";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function Bell({ exam, releases }: { exam: ExamSummary; releases: Release[] }) {
  const now = useChainNow();
  const before = !exam.unlocked && now < exam.unlockAt;
  const name = examTitle(exam.name, exam.id);
  const items = exam.keypers.map((k, i) => {
    const r = revealOf(releases, k.address, exam.round, k.registry);
    const on = exam.round < k.nextRound;
    return { label: `K${i + 1}`, on, bad: k.slashed, note: k.slashed ? "slashed" : on && r ? `+${r.time - exam.unlockAt} s` : on ? "released" : "sealed" };
  });
  const done = items.filter((b) => b.on).length;
  return (
    <div className="bell">
      <div className="when">
        {before ? "Next bell" : "Last bell"}: <Link href={`/exam/?id=${exam.id}`}>{name}</Link>, round {exam.round}
        {exam.usingBackup ? " (backup paper)" : ""}, {utc(exam.unlockAt)}
      </div>
      {before ? (
        <div className="clock" role="timer" aria-live="off">{span(exam.unlockAt - now)}</div>
      ) : (
        <div className="clock open">{hms(exam.unlockAt)}<small>UTC</small></div>
      )}
      <Bubbles items={items} />
      <p className="rule-line">
        {before
          ? `Opens when ${exam.threshold} of ${exam.keypers.length} keypers post their round ${exam.round} seed. Until then no centre, keyper or courier can read it. The exam board wrote the paper, so it is the one party this lock does not hide it from.`
          : exam.unlocked
            ? `Opened at the bell: ${done} of ${exam.keypers.length} keypers posted their seed, ${exam.threshold} were needed. ${exam.centres} centres hold sealed copies.`
            : `The bell has rung and ${done} of ${exam.threshold} needed seeds are public. The keyper daemons post within seconds of the next block.`}
      </p>
      <div className="hero-cta" style={{ marginTop: 20 }}>
        <Button asChild size="xl"><Link href={`/exam/?id=${exam.id}`}>Open this exam</Link></Button>
        <Button asChild size="xl" variant="outline"><Link href="/ledger/">See the release ledger</Link></Button>
      </div>
    </div>
  );
}

export default function Live() {
  const exams = useAsync(allExams);
  const reg = useAsync(() => registryState());
  const now = useChainNow();
  const list = exams.data ?? [];
  const featured = [...list].filter((e) => !e.unlocked && e.unlockAt > now).sort((a, b) => a.unlockAt - b.unlockAt)[0] ?? list[0];

  return (
    <>
      <h1>Live bell</h1>
      <p className="lead" style={{ marginTop: 14 }}>The next exam bell, read from QoreChain as you watch. A bubble fills when that keyper&apos;s seed is public.</p>

      {exams.error && <p className="err">Could not read exams from QoreChain: {exams.error}</p>}
      {featured && reg.data ? <Bell exam={featured} releases={reg.data.releases} /> : !exams.error && <p className="pending" style={{ marginTop: 40 }}>Reading the chain…</p>}

      <section aria-labelledby="exams">
        <h2 id="exams">Exams on chain</h2>
        <div className="scroll">
          <table className="sheet">
            <thead><tr><th>Exam</th><th>Bell</th><th>Status</th><th>Centres</th><th>Keypers</th></tr></thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/exam/?id=${e.id}`}>{examTitle(e.name, e.id)}</Link><br /><Hash v={e.id} /></td>
                  <td>{utc(e.unlockAt, false)}<br /><span className="muted small">round {e.round}{e.usingBackup ? ", backup" : ""}</span></td>
                  <td>{e.unlocked ? <Badge className="bg-[var(--pen-tint)] text-[var(--pen)]">{e.revealed ? "Opened, fairness proven" : "Opened"}</Badge> : now < e.unlockAt ? <Badge className="bg-[var(--omr-faint)] text-[var(--omr)]">Sealed, {span(e.unlockAt - now)} to go</Badge> : <Badge variant="secondary">Bell rung, waiting for seeds</Badge>}</td>
                  <td>{e.centres}</td>
                  <td>{e.threshold} of {e.keypers.length}</td>
                </tr>
              ))}
              {exams.loading && !list.length && <tr><td colSpan={5} className="pending">Scanning ZeroHourExam events…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="keypers">
        <h2 id="keypers">Keypers</h2>
        <p className="muted small">Each keyper bonds QOR and commits to a hash chain of seeds, one per 5-minute round. Their round keys are ML-KEM-1024.</p>
        <div className="scroll">
          <table className="sheet">
            <thead><tr><th>Keyper</th><th>Bond</th><th>Public up to</th><th>Last release</th><th>Status</th></tr></thead>
            <tbody>
              {(reg.data?.keypers ?? []).map((k) => {
                const last = reg.data!.releases.find((r) => eq(r.keyper, k.address) && eq(r.registry, k.registry));
                return (
                  <tr key={k.registry + k.address}>
                    <td><Hash v={k.address} kind="addr" /></td>
                    <td>{formatEther(k.bond)} QOR</td>
                    <td>{k.nextRound ? `round ${k.nextRound - 1}` : "nothing yet"}<br /><span className="muted small">of {k.maxRound}, {k.roundSeconds} s rounds</span></td>
                    <td>{last ? `${ago(now - last.time)} ago` : "never"}</td>
                    <td>{k.slashed ? <Badge variant="destructive">Slashed</Badge> : !k.registered ? <Badge variant="secondary">Withdrawn</Badge> : k.exitAt ? <Badge variant="secondary">Exiting</Badge> : <Badge className="bg-[var(--pen-tint)] text-[var(--pen)]">Bonded</Badge>} <span className="muted small">v{k.v}</span></td>
                  </tr>
                );
              })}
              {reg.loading && <tr><td colSpan={5} className="pending">Scanning HourglassRegistry events…</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small" style={{ marginTop: 14 }}><Link href="/ledger/">See every seed release and its timing</Link></p>
      </section>
    </>
  );
}
