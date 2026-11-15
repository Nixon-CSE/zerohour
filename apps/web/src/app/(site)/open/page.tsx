"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { deriveSealKeys } from "@qorechain/qoreseal";
import { bytesToHex, openPaper, type Paper } from "@zerohour/hourglass";
import type { Hex } from "viem";
import { Bubbles, Hash, Verdict, span, useAsync, useChainNow, utc } from "@/components/zh";
import { centreLabel, examTitle } from "@/lib/names";
import { Button } from "@/components/ui/button";
import { chainSeed, eq, loadExam, sealedFor, type ExamView } from "@/lib/exam";

const LETTERS = "ABCDEFGH";

function QuestionPaper({ p, centre, ms }: { p: Paper; centre: string; ms: number }) {
  return (
    <article className="qpaper" aria-label="Decrypted question paper">
      <header>
        <h2>{p.title}</h2>
        <span>Copy for {centre}. Opened in this browser in {ms} ms.</span>
      </header>
      <ol>
        {p.questions.map((q) => (
          <li key={q.id}>
            {q.text}
            <ul className="opts">
              {q.options.map((o, i) => <li key={i}><b aria-hidden>{LETTERS[i]}</b>{o}</li>)}
            </ul>
          </li>
        ))}
      </ol>
    </article>
  );
}

function Console({ v, centre }: { v: ExamView; centre: Hex }) {
  const now = useChainNow();
  const c = v.centres.find((x) => eq(x.address, centre));
  const backup = v.onchain.usingBackup;
  const round = v.activeRound;
  const file = useAsync(() => sealedFor(v, centre, backup), [v.id, centre]);
  const [done, setDone] = useState(false); // stop polling once the time lock is open
  const seeds = useAsync(async () => {
    const out: Record<string, Uint8Array> = {};
    for (const k of v.keypers) {
      const s = await chainSeed(k, round);
      if (s) out[k.address] = s;
    }
    if (Object.keys(out).length >= v.onchain.threshold) setDone(true);
    return out;
  }, [v.id, round, done ? 0 : Math.floor(now / 10)]);
  const [phrase, setPhrase] = useState("");
  const [result, setResult] = useState<{ paper?: Paper; ms?: number; error?: string }>({});
  const [busy, setBusy] = useState(false);

  if (!c) return <p className="err">That address is not a centre of this exam.</p>;
  const label = centreLabel(c.name);
  const have = Object.keys(seeds.data ?? {}).length;
  const timeOpen = have >= v.onchain.threshold;
  const before = now < v.unlockAt;

  const open = async () => {
    if (!file.data?.sealed) return;
    setBusy(true);
    setResult({});
    try {
      const keys = deriveSealKeys({ mnemonic: phrase.trim().toLowerCase().split(/\s+/).join(" ") });
      const t0 = performance.now();
      const plain = await openPaper(file.data.sealed, seeds.data ?? {}, keys);
      const ms = Math.round(performance.now() - t0);
      setResult({ paper: JSON.parse(new TextDecoder().decode(plain)), ms });
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setResult({ error: m.startsWith("locked") ? `Still locked: ${m.slice(8)}.` : /mnemonic|word|checksum/i.test(m) ? "That is not a valid recovery phrase. Check the spelling of each word." : `This key cannot open ${label}'s copy. It is sealed to a different centre key.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>Centre {label}</h1>
      <p className="muted" style={{ marginTop: 10 }}>
        Centre console for <Link href={`/exam/?id=${v.id}`}>{examTitle(v.manifest?.exam, v.id)}</Link>, {backup ? "backup paper B" : "paper A"}.
        The bell is at {utc(v.unlockAt)}{before ? `, in ${span(v.unlockAt - now)}` : ""}.
      </p>

      <section style={{ marginTop: 32 }}>
        <p>
          The copy below was published before the exam.{" "}
          {file.loading ? <span className="pending">Checking it against the chain…</span> : file.data?.sealed ? <Verdict ok={file.data.matches} yes="It matches the ciphertext hash the board put on chain." no="It does NOT match the on-chain hash. Do not use it." /> : <span className="err">No public copy found for this centre.</span>}
        </p>
        {file.data?.hash && <p className="small muted">Hash of the file: <Hash v={file.data.hash} n={10} /></p>}
      </section>

      <div className="locks" style={{ marginTop: 24 }}>
        <div className="lock">
          <h3>Lock 1: the bell</h3>
          <p className="small muted">Needs {v.onchain.threshold} of {v.keypers.length} keyper seeds for round {round}. Seeds are public once posted, so anyone can open this lock after the bell.</p>
          <div className={`state ${timeOpen ? "free" : "shut"}`}>{timeOpen ? `Open: ${have} of ${v.keypers.length} seeds posted and checked against each keyper's anchor` : before ? `Locked until ${utc(v.unlockAt)}` : `Waiting: ${have} of ${v.onchain.threshold} seeds posted`}</div>
          <Bubbles items={v.keypers.map((k, i) => ({ label: `K${i + 1}`, on: !!seeds.data?.[k.address], note: seeds.data?.[k.address] ? bytesToHex(seeds.data[k.address]).slice(0, 8) + "…" : "sealed" }))} />
        </div>
        <div className="lock">
          <h3>Lock 2: this centre&apos;s key</h3>
          <p className="small muted">Sealed with QoreSeal (ML-KEM-1024 + X25519) to the key {label} registered on QoreChain. No other centre, and no keyper, can open it.</p>
          <label htmlFor="phrase">Centre recovery phrase</label>
          <textarea id="phrase" value={phrase} onChange={(e) => setPhrase(e.target.value)} spellCheck={false} autoComplete="off" placeholder="12 or 24 words, separated by spaces" />
          <p className="small muted" style={{ marginTop: 8 }}>The phrase stays in this page: nothing is sent anywhere. A real centre would keep this key on a hardware device.</p>
          <Button size="xl" onClick={open} disabled={busy || !phrase.trim() || !file.data?.matches || !timeOpen}>
            {busy ? "Opening…" : timeOpen ? "Open paper" : before ? `Opens at ${utc(v.unlockAt)}` : "Waiting for keyper seeds"}
          </Button>
          {result.error && <p className="err" style={{ marginTop: 12 }} role="alert">{result.error}</p>}
        </div>
      </div>

      {result.paper && <QuestionPaper p={result.paper} centre={label} ms={result.ms!} />}
    </>
  );
}

function Inner() {
  const q = useSearchParams();
  const id = q.get("id"), centre = q.get("centre");
  const ok = id && /^0x[0-9a-fA-F]{64}$/.test(id) && centre && /^0x[0-9a-fA-F]{40}$/.test(centre);
  const s = useAsync(async () => (ok ? loadExam(id as Hex) : null), [id]);
  if (!ok) return <p>Open a centre from its <Link href="/">exam page</Link>.</p>;
  if (s.error) return <p className="err">Could not load the exam: {s.error}</p>;
  if (!s.data) return <p className="pending">Reading the exam from QoreChain…</p>;
  return <Console v={s.data} centre={centre as Hex} />;
}

export default function Page() {
  return <Suspense fallback={<p className="pending">Loading…</p>}><Inner /></Suspense>;
}
