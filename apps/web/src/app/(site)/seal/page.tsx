"use client";
/**
 * Seal a message to the next bell, in this browser, and open it when the keypers release that round.
 *
 * Everything that makes the lock real happens here, client-side:
 *   - each keyper's ML-KEM-1024 key for the bell round is checked against that keyper's pkRoot on chain (Merkle proof);
 *   - the recipient's card is checked against the ML-DSA-87 key the chain holds for it (pqcKeyStatus precompile);
 *   - the message is sealed with ZeroHour's two locks (Shamir 2-of-3 over ML-KEM-1024, plus QoreSeal to the recipient);
 *   - opening reads the released seeds from chain, checks them against each keyper's anchor, and decrypts here.
 * Nothing is sent to any server. The always-on keypers release every beacon round (every 15 minutes).
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { sealKeysFromSeed, verifyRecipientCard, type RecipientCard } from "@qorechain/qoreseal";
import { bytesToHex, hexToBytes, k256, openPaper, pkLeaf, sealPaper, verifyMerkle, type SealedPaper } from "@zerohour/hourglass";
import { decodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import { Bubbles, Hash, Verdict, ago, span, useAsync, useChainNow, utc } from "@/components/zh";
import { Button } from "@/components/ui/button";
import { CURRENT, client, keyperRecord, type KeyperRecord } from "@/lib/chain";
import { chainSeed, publicFile } from "@/lib/exam";
import { bech32ToEvm, checkCapsule, type BeaconIndex, type Capsule } from "@/lib/capsule";

type BeaconDay = { bells: { round: number; at: string; keys: Record<string, { publicKey: Hex; proof: Hex[] }> }[] };
type Recipient = { name: string; label: string; address: string; evm: Hex; card: RecipientCard; mlkemPublicKey: Hex };

const STORE = "zh-capsules";
const MAX_CHARS = 2000;
const PQC_KEY_STATUS = "0x0000000000000000000000000000000000000a02" as const; // viem needs it lowercase
const KEY_STATUS_ABI = parseAbi(["function pqcKeyStatus(address account) view returns (bool, uint8, bytes)"]);
const loadSaved = (): Capsule[] => { try { return JSON.parse(localStorage.getItem(STORE) ?? "[]"); } catch { return []; } };
const saveAll = (c: Capsule[]) => { try { localStorage.setItem(STORE, JSON.stringify(c.slice(0, 20))); } catch { /* private window: the download and the link still work */ } };

/** The ML-DSA-87 key the chain holds for an account, read live through the pqcKeyStatus precompile. */
async function onchainPqKey(evm: Hex): Promise<Uint8Array> {
  const call = await client.call({ to: PQC_KEY_STATUS, data: encodeFunctionData({ abi: KEY_STATUS_ABI, functionName: "pqcKeyStatus", args: [evm] }) });
  if (!call.data) throw new Error("pqcKeyStatus returned nothing");
  const [registered, alg, pk] = decodeAbiParameters([{ type: "bool" }, { type: "uint8" }, { type: "bytes" }], call.data);
  if (!registered || alg !== 1) throw new Error("no ML-DSA-87 key registered on chain for this account");
  return hexToBytes(pk);
}

// Share links carry the capsule in the URL fragment, which browsers never send to a server.
async function toLink(c: Capsule): Promise<string> {
  const gz = new Uint8Array(await new Response(new Blob([JSON.stringify(c)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  let s = ""; for (const b of gz) s += String.fromCharCode(b);
  return `${location.origin}/seal/#c=${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
async function fromLink(hash: string): Promise<Capsule | null> {
  const m = /[#&]c=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
}

function KeyperHealth({ idx, recs, now }: { idx: BeaconIndex; recs: KeyperRecord[]; now: number }) {
  const cadence = idx.every * idx.roundSeconds;
  return (
    <Bubbles items={recs.map((r, i) => {
      const last = r.nextRound > 0 ? r.genesis + (r.nextRound - 1) * r.roundSeconds : 0;
      const beacon = last > 0 && now - last <= 2 * cadence + 120; // releasing every cadence
      const alive = last > 0 && now - last <= 26 * 3600; // at least the daily heartbeat
      return { label: `K${idx.keypers[i].id}`, on: alive, bad: r.slashed, note: r.slashed ? "slashed" : last ? `${beacon ? "beacon" : "daily"} · ${ago(now - last)} ago` : "never released" };
    })} />
  );
}

function SealPanel({ idx, recs, now, onSealed }: { idx: BeaconIndex; recs: KeyperRecord[]; now: number; onSealed: (c: Capsule) => void }) {
  // Bells from today's (and tomorrow's) published key file; skip any a keyper has already revealed.
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const nextDay = new Date((now + 86_400) * 1000).toISOString().slice(0, 10);
  const files = useAsync(async () => {
    const load = async (d: string) => (idx.days.includes(d) ? (await publicFile<BeaconDay>("beacon", `${d}.json`))?.bells ?? [] : []);
    const out = await load(day);
    // Tomorrow's file only when today has few bells left (each day is about 1.2 MB of public keys).
    if (out.filter((b) => Date.parse(b.at) / 1000 >= now + 60).length < 8) out.push(...(await load(nextDay)));
    return out;
  }, [day]);
  const minNext = Math.max(...recs.map((r) => r.nextRound));
  const bells = (files.data ?? []).filter((b) => Date.parse(b.at) / 1000 >= now + 60 && b.round >= minNext).slice(0, 8);
  const [pick, setPick] = useState<number | null>(null);
  const bell = bells.find((b) => b.round === pick) ?? bells[0];
  const recipient = useAsync(() => publicFile<Recipient>("beacon", `recipients/${idx.recipients[0]}.json`), []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<{ ok: boolean; text: string }[]>([]);
  const [err, setErr] = useState("");

  const seal = async () => {
    if (!bell || !recipient.data) return;
    setBusy(true); setErr(""); setChecks([]);
    const log: { ok: boolean; text: string }[] = [];
    try {
      // 1. Every keyper key for this round must hash into that keyper's on-chain pkRoot.
      const keypers = idx.keypers.map((k, i) => {
        const e = bell.keys[k.address];
        if (!e) throw new Error(`no published key for keyper #${k.id}`);
        const pk = hexToBytes(e.publicKey);
        const ok = verifyMerkle(pkLeaf(pk), bell.round, e.proof.map(hexToBytes), hexToBytes(recs[i].pkRoot));
        log.push({ ok, text: `Keyper #${k.id}: its round-${bell.round} ML-KEM-1024 key is in the key tree it committed on chain (pkRoot ${recs[i].pkRoot.slice(0, 10)}…).` });
        if (!ok) throw new Error(`keyper #${k.id}'s published key does not match its on-chain pkRoot. Not sealing.`);
        return { keyper: k.address, publicKey: pk };
      });
      // 2. The recipient card must be signed by the ML-DSA-87 key the chain holds for that account (read live).
      const r = recipient.data;
      if (bech32ToEvm(r.address).toLowerCase() !== r.evm.toLowerCase()) throw new Error("the recipient file's EVM address is not the card's account. Not sealing.");
      const pq = await onchainPqKey(r.evm);
      const target = verifyRecipientCard({ card: r.card, chainId: idx.chainId, pqPublicKey: pq, mlkemPublicKey: hexToBytes(r.mlkemPublicKey) });
      log.push({ ok: true, text: `${r.label}: its recipient card is signed by the ML-DSA-87 key registered on chain for ${r.address.slice(0, 12)}…, and it names this ML-KEM-1024 key.` });
      // 3. Seal here: Shamir t-of-n over the keypers' round keys, plus QoreSeal to the recipient.
      const t0 = performance.now();
      const sealed = await sealPaper({ plaintext: new TextEncoder().encode(text), chainId: idx.chainId, round: bell.round, threshold: idx.threshold, keypers, recipient: target });
      log.push({ ok: true, text: `Sealed in this browser in ${Math.round(performance.now() - t0)} ms: ${idx.threshold} of ${keypers.length} keyper keys for round ${bell.round}, and the recipient's key. Nothing was sent anywhere.` });
      setChecks(log);
      onSealed({ v: 1, kind: "zerohour-capsule", chainId: idx.chainId, registry: idx.registry, round: bell.round, at: bell.at, threshold: idx.threshold, keypers: keypers.map((k) => k.keyper as Hex), recipient: { name: r.name, label: r.label, address: r.address }, sealed, createdAt: new Date().toISOString() });
      setText("");
    } catch (e: any) {
      setChecks(log);
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="seal-h">
      <h3 id="seal-h">1. Seal a message to a bell</h3>
      {files.loading || recipient.loading ? <p className="pending">Loading the keypers&apos; published round keys…</p> : !bells.length ? (
        <p className="err">No published bell ahead in the key files. The beacon schedule may have ended.</p>
      ) : (
        <>
          <div className="field">
            <label htmlFor="bell">Bell</label>
            <select id="bell" value={bell?.round} onChange={(e) => setPick(Number(e.target.value))}>
              {bells.map((b) => <option key={b.round} value={b.round}>{utc(Date.parse(b.at) / 1000)} · in {span(Date.parse(b.at) / 1000 - now)}</option>)}
            </select>
            <p className="small muted" style={{ margin: 0 }}>Round {bell?.round}. To <b>{recipient.data?.label}</b>, whose decryption key is public on purpose so you can open it yourself after the bell. Before the bell nobody can: not us, not the recipient, not a keyper alone.</p>
          </div>
          <div className="field">
            <label htmlFor="msg">Message</label>
            <textarea id="msg" className="msg" value={text} maxLength={MAX_CHARS} onChange={(e) => setText(e.target.value)} placeholder="Write something only the future should read." />
            <p className="small muted" style={{ margin: 0, maxWidth: "none", textAlign: "right" }} aria-live="polite">{text.length} / {MAX_CHARS}</p>
          </div>
          <div><Button size="xl" onClick={seal} disabled={busy || !text.trim() || !bell}>{busy ? "Sealing…" : `Seal to ${bell ? utc(Date.parse(bell.at) / 1000) : "the bell"}`}</Button></div>
        </>
      )}
      {checks.length > 0 && <ul className="checklist" aria-label="What was checked">{checks.map((c, i) => <li key={i}><Verdict ok={c.ok} yes={c.text} no={c.text} /></li>)}</ul>}
      {err && <p className="err" role="alert" style={{ margin: 0 }}>{err}</p>}
    </section>
  );
}

function CapsuleCard({ c, now, onRemove }: { c: Capsule; now: number; onRemove: () => void }) {
  const bellAt = Date.parse(c.at) / 1000;
  const before = now < bellAt;
  // Released seeds for the bell round, checked against each keyper's anchor (chainSeed throws otherwise). Once the
  // threshold is in, the seeds can never change, so they are kept and the chain is not asked again.
  const settled = useRef<Record<string, Uint8Array> | null>(null);
  const seeds = useAsync(async () => {
    if (before) return {} as Record<string, Uint8Array>;
    if (settled.current) return settled.current;
    const out: Record<string, Uint8Array> = {};
    for (const k of c.keypers) {
      const s = await chainSeed(await keyperRecord(k, c.registry), c.round);
      if (s) out[k] = s;
    }
    if (Object.keys(out).length >= c.threshold) settled.current = out;
    return out;
  }, [c.round, before ? 0 : settled.current ? "settled" : Math.floor(now / 15)]);
  const have = Object.keys(seeds.data ?? {}).length;
  const judge = useAsync(() => publicFile<{ decryptionKey: string }>("demo", "judge-centre.json"), []);
  const [key, setKey] = useState("");
  const [out, setOut] = useState<{ text?: string; ms?: number; err?: string }>({});
  const [link, setLink] = useState("");
  const keyId = `capsule-key-${c.sealed.ct.slice(2, 14)}`; // unique even for two capsules sealed to the same bell

  const open = async () => {
    setOut({});
    try {
      const m = /^(?:zerohour-centre-key:)?(?:0x)?([0-9a-fA-F]{64})$/.exec(key.trim());
      if (!m) throw new Error("Paste a decryption key (zerohour-centre-key:…).");
      const t0 = performance.now();
      const plain = await openPaper(c.sealed, seeds.data ?? {}, sealKeysFromSeed(hexToBytes(m[1])));
      setOut({ text: new TextDecoder().decode(plain), ms: Math.round(performance.now() - t0) });
    } catch (e: any) {
      const m = String(e?.message ?? e);
      setOut({ err: m.startsWith("locked") ? `Still locked: ${m.slice(8)}.` : m.startsWith("Paste") ? m : "This key cannot open it: the message is sealed to a different recipient key." });
    }
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(c, null, 2)], { type: "application/json" }));
    a.download = `zerohour-capsule-round-${c.round}.json`;
    a.click();
  };

  return (
    <article className="card" aria-label={`Message sealed to ${utc(bellAt)}`}>
      <header>
        <div>
          <h3>Sealed to {utc(bellAt)}</h3>
          <p className="small muted" style={{ margin: 0 }}>Round {c.round} · for {c.recipient.label} · ciphertext <Hash v={bytesToHex(k256(new TextEncoder().encode(JSON.stringify(c.sealed))))} n={6} /></p>
        </div>
      </header>
      <div className={`state ${have >= c.threshold ? "free" : "shut"}`} style={{ fontWeight: 700 }} role="status">
        {before ? `Locked: the bell is in ${span(bellAt - now)}` : seeds.error && have < c.threshold ? "Bell passed. Could not read the keypers' seeds from QoreChain just now (RPC busy); retrying every 15 seconds." : seeds.loading && !seeds.data ? "Bell passed. Reading the keypers' seeds from QoreChain…" : have >= c.threshold ? `Bell passed: ${have} of ${c.keypers.length} keyper seeds are on chain and check out against their anchors` : `Bell passed, waiting for keypers: ${have} of ${c.threshold} seeds on chain`}
      </div>
      <Bubbles items={c.keypers.map((k, i) => ({ label: `K${i + 1}`, on: !!seeds.data?.[k], note: seeds.data?.[k] ? bytesToHex(seeds.data[k]).slice(0, 8) + "…" : "sealed" }))} />
      <div className="field" style={{ margin: 0 }}>
        <label htmlFor={keyId}>Recipient decryption key</label>
        {judge.data?.decryptionKey && c.recipient.name === "centre-judges" && <p className="small" style={{ margin: 0 }}><button type="button" className="underline font-semibold" onClick={() => setKey(judge.data!.decryptionKey)}>Use the judges&apos; key</button> (public on purpose)</p>}
        <textarea id={keyId} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" placeholder="zerohour-centre-key:…" />
      </div>
      <div className="actions" style={{ marginTop: 0 }}>
        <Button onClick={open} disabled={!key.trim() || have < c.threshold}>{have >= c.threshold ? "Open" : before ? "Opens at the bell" : "Waiting for seeds"}</Button>
        <Button variant="outline" onClick={() => { void open(); }} disabled={!key.trim() || have >= c.threshold}>Try to open now</Button>
        <Button variant="outline" onClick={download}>Download</Button>
        <Button variant="outline" onClick={async () => { const l = await toLink(c); setLink(l); try { await navigator.clipboard.writeText(l); } catch { /* shown below */ } }}>Copy link</Button>
        <Button variant="ghost" onClick={onRemove}>Remove</Button>
      </div>
      {link && <p className="small muted" style={{ margin: 0, overflowWrap: "anywhere" }}>Link copied. Anyone with it sees the same lock: <a href={link}>open link</a></p>}
      {out.err && <p className="err" role="alert" style={{ margin: 0 }}>{out.err}</p>}
      {out.text !== undefined && (
        <div>
          <Verdict ok yes={`Opened in this browser in ${out.ms} ms, with seeds the keypers released on chain at the bell.`} no="" />
          <p className="capsule-msg">{out.text}</p>
        </div>
      )}
    </article>
  );
}

export default function Page() {
  const now = useChainNow();
  const idx = useAsync(() => publicFile<BeaconIndex>("beacon", "index.json"), []);
  const recs = useAsync(async () => (idx.data ? Promise.all(idx.data.keypers.map((k) => keyperRecord(k.address, idx.data!.registry))) : null), [idx.data?.registry, Math.floor(now / 30)]);
  const [caps, setCaps] = useState<Capsule[]>([]);
  useEffect(() => { setCaps(loadSaved()); }, []);
  useEffect(() => {
    if (!idx.data) return;
    fromLink(location.hash).then((c) => { if (c && !caps.some((s) => s.sealed.ct === c.sealed.ct)) accept(c); }).catch(() => setLoadErr("That link does not contain a readable capsule."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx.data]);
  const add = (c: Capsule) => setCaps((cs) => { const n = [c, ...cs]; saveAll(n); return n; });
  const remove = (i: number) => setCaps((cs) => { const n = cs.filter((_, j) => j !== i); saveAll(n); return n; });
  const ready = idx.data && recs.data;
  const wrongRegistry = idx.data && idx.data.registry.toLowerCase() !== CURRENT.hourglass.toLowerCase();
  const [loadErr, setLoadErr] = useState("");
  const accept = (c: Capsule) => { if (!idx.data) return; const why = checkCapsule(c, idx.data); if (why) setLoadErr(`That capsule was not loaded: ${why}.`); else { setLoadErr(""); add(c); } };
  const cadenceMin = useMemo(() => (idx.data ? (idx.data.every * idx.data.roundSeconds) / 60 : 15), [idx.data]);

  return (
    <>
      <div className="page-head">
        <h1>Seal a message to the next bell</h1>
        <p className="lead">
          The same two locks as an exam paper, in your browser. The keypers release a round every {cadenceMin} minutes; a message sealed to that round
          cannot be opened before it, by anyone, and opens for its recipient right after. Encryption and decryption both happen on this page.
        </p>
      </div>
      {wrongRegistry ? <p className="err">The published beacon names a different registry than this site uses. Not sealing.</p> : idx.error || recs.error ? <p className="err">Could not read the keypers from QoreChain testnet ({String(idx.error ?? recs.error)}). The RPC may be down; reload in a minute.</p> : !ready ? <p className="pending">Reading the keypers from QoreChain…</p> : (
        <>
          <div className="stack" style={{ marginTop: 8 }}>
          <section aria-label="Keyper status">
            <p className="small">Keypers now ({idx.data!.threshold} of {idx.data!.keypers.length} needed; the beacon keypers release every {cadenceMin} minutes, the others at least daily):</p>
            <KeyperHealth idx={idx.data!} recs={recs.data!} now={now} />
          </section>
          <SealPanel idx={idx.data!} recs={recs.data!} now={now} onSealed={add} />
          <section className="stack" aria-labelledby="caps-h" style={{ marginTop: 12 }}>
            <h3 id="caps-h">2. Your sealed messages</h3>
            {caps.length ? caps.map((c, i) => <CapsuleCard key={c.sealed.ct.slice(0, 24)} c={c} now={now} onRemove={() => remove(i)} />) : <p className="small muted">None yet. They stay in this browser only (and in any file or link you make).</p>}
            <div className="actions" style={{ marginTop: 0, alignItems: "center" }}>
              <label className="file-btn">
                Load a capsule file
                <input type="file" accept=".json,application/json" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) { try { accept(JSON.parse(await f.text())); } catch { setLoadErr("That file is not a capsule."); } } }} />
              </label>
              <span className="small muted">from Download, or opened from a shared link</span>
            </div>
            {loadErr && <p className="err" role="alert">{loadErr}</p>}
          </section>
          </div>
          <p className="small muted" style={{ marginTop: 28 }}>
            How it is checked: <Link href="/how/">How it works</Link> · keypers and their releases: <Link href="/keypers/">Keypers</Link> · what this does not protect against: <Link href="/security/">Security</Link>.
          </p>
        </>
      )}
    </>
  );
}
