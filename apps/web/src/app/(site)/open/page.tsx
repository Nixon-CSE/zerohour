"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { sealKeysFromSeed } from "@qorechain/qoreseal";
import { bytesToHex, hexToBytes, k256, makeVariant, openPaper, type Paper } from "@zerohour/hourglass";
import type { Hex } from "viem";
import { Bubbles, Hash, Verdict, span, useAsync, useChainNow, utc } from "@/components/zh";
import { centreLabel, examTitle } from "@/lib/names";
import { Button } from "@/components/ui/button";
import { chainSeed, eq, loadExam, publicFile, sealedFor, type ExamView, type Reveal } from "@/lib/exam";

const LETTERS = "ABCDEFGH";

/**
 * A centre's decryption key: the 32-byte QoreSeal seed, written "zerohour-centre-key:<64 hex>".
 * It opens that centre's copies only; it cannot sign, move funds or recover the account phrase.
 */
function parseCentreKey(text: string): Uint8Array {
  const t = text.trim();
  if (t.split(/\s+/).length >= 12) throw new Error("PHRASE");
  const m = /^(?:zerohour-centre-key:)?(?:0x)?([0-9a-fA-F]{64})$/.exec(t);
  if (!m) throw new Error("FORMAT");
  return hexToBytes(m[1]);
}

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
  const [keyText, setKeyText] = useState("");
  const [result, setResult] = useState<{ paper?: Paper; ms?: number; error?: string; hash?: Hex }>({});
  // The opened paper renders below the locks; bring it into view so the click visibly does something.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (result.paper) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [result.paper]);
  // The judges' centre publishes its decryption key on purpose so anyone can try a real opening.
  const judge = useAsync(async () => (c?.name === "centre-judges" ? publicFile<{ decryptionKey: string }>("demo", "judge-centre.json") : null), [c?.name]);
  // After the fairness reveal, rebuild this centre's copy from the public reveal to compare.
  const reveal = useAsync(async () => (v.onchain.revealed && v.dir ? publicFile<Reveal>(v.dir, "reveal.json") : null), [v.id]);
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
      const keys = sealKeysFromSeed(parseCentreKey(keyText));
      const t0 = performance.now();
      const plain = await openPaper(file.data.sealed, seeds.data ?? {}, keys);
      const ms = Math.round(performance.now() - t0);
      setResult({ paper: JSON.parse(new TextDecoder().decode(plain)), ms, hash: bytesToHex(k256(plain)) });
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setResult({ error: m.startsWith("locked") ? `Still locked: ${m.slice(8)}.` : m === "PHRASE" ? "That looks like a recovery phrase. Never paste one here: it controls the whole account. Use the centre's decryption key file instead." : m === "FORMAT" ? "Paste the contents of the centre's decryption key file (zerohour-centre-key:…)." : `This key cannot open ${label}'s copy. It is sealed to a different centre key.` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1>{/centre/i.test(label) ? label : `Centre ${label}`}</h1>
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
          <label htmlFor="centre-key">Centre decryption key</label>
          {judge.data?.decryptionKey && <p className="small" style={{ margin: "4px 0 8px" }}>This is the judges&apos; centre: its key is public on purpose. <button type="button" className="underline font-semibold" onClick={() => setKeyText(judge.data!.decryptionKey)}>Use the judges&apos; key</button></p>}
          <textarea id="centre-key" value={keyText} onChange={(e) => setKeyText(e.target.value)} spellCheck={false} autoComplete="off" placeholder="zerohour-centre-key:…" />
          <label className="file-btn" style={{ marginTop: 8 }}>Load the key file<input type="file" accept=".txt,text/plain" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setKeyText((await f.text()).trim()); }} /></label>
          <p className="small muted" style={{ marginTop: 8 }}>The key stays in this page: nothing is sent anywhere. It can open this centre&apos;s copies and nothing else: it cannot sign, move funds or recover the account.</p>
          <Button size="xl" onClick={open} disabled={busy || !keyText.trim() || !file.data?.matches || !timeOpen}>
            {busy ? "Opening…" : timeOpen ? "Open paper" : before ? `Opens at ${utc(v.unlockAt)}` : "Waiting for keyper seeds"}
          </Button>
          {result.error && <p className="err" style={{ marginTop: 12 }} role="alert">{result.error}</p>}
        </div>
      </div>

      <div ref={resultRef} style={{ scrollMarginTop: 80 }} aria-live="polite">
        {result.paper && <p className="ok tick" style={{ marginTop: 24, fontSize: 17 }}>Opened in this browser in {result.ms} ms.</p>}
      </div>
      {result.paper && result.hash && <CopyCheck v={v} centreName={c.name} centre={centre} hash={result.hash} reveal={reveal.data ?? null} />}
      {result.paper && <QuestionPaper p={result.paper} centre={label} ms={result.ms!} />}
    </>
  );
}

/** Is the copy this browser just decrypted the one the centre signed for, and the one the reveal rebuilds? */
function CopyCheck({ v, centreName, centre, hash, reveal }: { v: ExamView; centreName: string; centre: Hex; hash: Hex; reveal: Reveal | null }) {
  const receipt = v.centres.find((x) => eq(x.address, centre))?.receipt ?? null;
  const rc = reveal?.centres.find((x) => eq(x.evm, centre));
  const rebuilt = reveal && rc ? bytesToHex(k256(new TextEncoder().encode(JSON.stringify(makeVariant(reveal.canonicalPaper, centreName, hexToBytes(reveal.set === "B" ? rc.permSeedB : rc.permSeedA)).paper)))) : null;
  return (
    <section style={{ marginTop: 24 }}>
      <p className="small">Hash of the copy you just opened: <Hash v={hash} n={10} /></p>
      <ul className="small" style={{ listStyle: "none", padding: 0 }}>
        <li>{v.dep.v < 2 ? <span className="muted">This exam ran on the v1 contract, whose receipts did not name the paper.</span> : receipt ? <Verdict ok={eq(receipt, hash)} yes="It is the copy this centre signed for on chain." no="It differs from the copy this centre signed for." /> : <span className="muted">This centre has not filed its receipt yet.</span>}</li>
        <li>{rebuilt ? <Verdict ok={eq(rebuilt, hash)} yes="It is exactly the copy rebuilt from the board's public fairness reveal." no="It differs from the copy the fairness reveal rebuilds: the board sealed something else." /> : <span className="muted">After the exam the board reveals the paper and orders; this copy will then be checked against them.</span>}</li>
      </ul>
    </section>
  );
}

function Inner() {
  const q = useSearchParams();
  const id = q.get("id"), centre = q.get("centre");
  const ok = id && /^0x[0-9a-fA-F]{64}$/.test(id) && centre && /^0x[0-9a-fA-F]{40}$/.test(centre);
  const s = useAsync(async () => (ok ? loadExam(id as Hex) : null), [id]);
  if (!ok) return <p>Open a centre from its <Link href="/">exam page</Link>.</p>;
  if (s.error) return <p className="err">Could not read this exam from QoreChain testnet ({s.error}). The testnet RPC may be down; reload in a minute.</p>;
  if (!s.data) return <p className="pending">Reading the exam from QoreChain…</p>;
  return <Console v={s.data} centre={centre as Hex} />;
}

export default function Page() {
  return <Suspense fallback={<p className="pending">Loading…</p>}><Inner /></Suspense>;
}
