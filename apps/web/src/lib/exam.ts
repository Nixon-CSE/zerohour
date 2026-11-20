/**
 * One exam, assembled from the chain plus the committed public record (deployments/demo/<id>/).
 * Every check here runs in the viewer's browser: ciphertext hashes, seed chains, fairness
 * commitments and variant reconstruction.
 */
import { bytesToHex, hexToBytes, k256, makeVariant, sealedHash, verifySeed, type Paper, type SealedPaper } from "@zerohour/hourglass";
import { decodeEventLog, type Hex, type Log } from "viem";
import { DEPLOYMENTS, EV, blockTime, client, deploymentOf, examAbi, keyperRecord, roundTime, scanLogs, type Deployment, type KeyperRecord } from "./chain";

const enc = new TextEncoder();
const cat = (...xs: Uint8Array[]) => {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) out.set(x, (o += x.length) - x.length);
  return out;
};
export const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export interface IndexEntry { dir: string; examId: Hex; exam: string; contract?: Hex }
export async function examIndex(): Promise<IndexEntry[]> {
  return fetch("/deployments/exams.json").then((r) => (r.ok ? r.json() : []));
}

export interface Manifest {
  exam: string;
  examId: Hex;
  roundA: number;
  roundB: number;
  threshold: number;
  keypers: Hex[];
  centres: { name: string; evm: Hex; ctHashA: Hex; ctHashB: Hex; sealedA: string; sealedB: string }[];
}

export async function publicFile<T>(dir: string, path: string): Promise<T | null> {
  const r = await fetch(`/deployments/${dir}/${path}`);
  return r.ok ? r.json() : null;
}

/** Raw text of a published file, for re-hashing exactly the bytes that were committed on chain. */
export async function publicText(dir: string, path: string): Promise<string | null> {
  const r = await fetch(`/deployments/${dir}/${path}`);
  return r.ok ? r.text() : null;
}

export interface TimelineEntry {
  kind: "created" | "centre" | "release" | "opened" | "leak" | "switched" | "revealed" | "slashed";
  block: bigint;
  time?: number;
  tx: Hex;
  args: Record<string, any>;
}

export interface ExamView {
  id: Hex;
  dep: Deployment; // which contract generation holds this exam
  dir: string | null;
  manifest: Manifest | null;
  onchain: {
    board: Hex;
    leakHunter: Hex;
    threshold: number;
    usingBackup: boolean;
    revealed: boolean;
    roundA: number;
    roundB: number;
    paperCommitA: Hex;
    paperCommitB: Hex;
    manifestRoot: Hex;
    keypers: Hex[];
  };
  unlocked: boolean;
  activeRound: number;
  keypers: KeyperRecord[];
  unlockAt: number; // unix seconds, keyper[0]'s clock (same rule the contract uses)
  centres: { address: Hex; name: string; ctHashA: Hex; ctHashB: Hex; permCommit: Hex; openedAt: number; leakReports: number; receipt: Hex | null }[];
  timeline: TimelineEntry[];
}

const decode = (l: Log) => decodeEventLog({ abi: Object.values(EV), data: l.data, topics: l.topics as any });

/** The contract generation holding `id`: from the published manifest, else by asking each one. */
async function findDeployment(id: Hex, idx?: IndexEntry): Promise<Deployment> {
  const known = idx?.contract && deploymentOf(idx.contract);
  if (known) return known;
  for (const d of DEPLOYMENTS) {
    const ok = await client.readContract({ address: d.exam, abi: examAbi, functionName: "getExam", args: [id] }).then(() => true, () => false);
    if (ok) return d;
  }
  throw new Error("no such exam on any ZeroHour contract");
}

export async function loadExam(id: Hex): Promise<ExamView> {
  const idx = (await examIndex()).find((e) => eq(e.examId, id));
  const dep = await findDeployment(id, idx);
  const [e, list, unlocked, active, manifest] = await Promise.all([
    client.readContract({ address: dep.exam, abi: examAbi, functionName: "getExam", args: [id] }),
    client.readContract({ address: dep.exam, abi: examAbi, functionName: "getCentres", args: [id] }),
    client.readContract({ address: dep.exam, abi: examAbi, functionName: "isUnlocked", args: [id] }),
    client.readContract({ address: dep.exam, abi: examAbi, functionName: "activeRound", args: [id] }),
    idx ? publicFile<Manifest>(idx.dir, "manifest.json") : Promise.resolve(null),
  ]);
  const keypers = await Promise.all(e.keypers.map((k) => keyperRecord(k, dep.hourglass)));
  const centres = await Promise.all(
    list.map(async (address) => {
      const [c, receipt] = await Promise.all([
        client.readContract({ address: dep.exam, abi: examAbi, functionName: "centres", args: [id, address] }),
        dep.v >= 2 ? client.readContract({ address: dep.exam, abi: examAbi, functionName: "receiptOf", args: [id, address, e.usingBackup] }) : Promise.resolve(null),
      ]);
      const name = manifest?.centres.find((m) => eq(m.evm, address))?.name ?? address;
      return { address, name, ctHashA: c[1], ctHashB: c[2], permCommit: c[3], openedAt: Number(c[4]), leakReports: c[5], receipt: receipt && BigInt(receipt) !== 0n ? receipt : null };
    }),
  );

  // Exam events for this id, plus the releases of its rounds by its keypers.
  const rounds = new Set([e.roundA, e.roundB]);
  const [examLogs, regLogs] = await Promise.all([
    scanLogs(dep.exam, dep.fromExam, [EV.examCreated, EV.centreAdded, EV.switched, EV.opened, EV.openedV2, EV.leak, EV.revealed]),
    scanLogs(dep.hourglass, dep.fromExam, [EV.released, EV.slashed]),
  ]);
  const timeline: TimelineEntry[] = [];
  const kind: Record<string, TimelineEntry["kind"]> = {
    ExamCreated: "created", CentreAdded: "centre", SwitchedToBackup: "switched", PaperOpened: "opened",
    LeakReported: "leak", FairnessRevealed: "revealed", SeedReleased: "release", KeyperSlashed: "slashed",
  };
  for (const l of examLogs) {
    const d = decode(l);
    if (!eq((d.args as any).examId, id)) continue;
    timeline.push({ kind: kind[d.eventName], block: l.blockNumber!, tx: l.transactionHash!, args: d.args as any });
  }
  for (const l of regLogs) {
    const d = decode(l);
    const a = d.args as any;
    if (!e.keypers.some((k) => eq(k, a.keyper))) continue;
    if (d.eventName === "SeedReleased" && !rounds.has(Number(a.round))) continue;
    timeline.push({ kind: kind[d.eventName], block: l.blockNumber!, tx: l.transactionHash!, args: a });
  }
  timeline.sort((x, y) => Number(x.block - y.block));
  await Promise.all(timeline.map(async (t) => (t.time = await blockTime(t.block))));

  return {
    id,
    dep,
    dir: idx?.dir ?? null,
    manifest,
    onchain: { ...e, keypers: [...e.keypers] },
    unlocked,
    activeRound: active,
    keypers,
    unlockAt: roundTime(keypers[0], active),
    centres,
    timeline,
  };
}

/** A keyper's seed for `round` as the chain publishes it: stored directly, or hashed down from a later release. */
export async function chainSeed(k: KeyperRecord, round: number): Promise<Uint8Array | null> {
  if (round >= k.nextRound) return null;
  const direct = await client.readContract({ address: k.registry, abi: [{ type: "function", name: "seedOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint32" }], outputs: [{ type: "bytes32" }] }] as const, functionName: "seedOf", args: [k.address, round] });
  let s = BigInt(direct) !== 0n ? hexToBytes(direct) : hexToBytes(k.lastHash);
  if (BigInt(direct) === 0n) for (let r = k.nextRound - 1; r > round; r--) s = k256(s);
  if (!verifySeed(s, round, hexToBytes(k.anchor))) throw new Error(`seed for keyper ${k.address} round ${round} does not hash to its anchor`);
  return s;
}

/** Fetch a centre's published ciphertext and check it against the ctHash committed on chain. */
export async function sealedFor(view: ExamView, centre: Hex, backup: boolean): Promise<{ sealed: SealedPaper | null; hash: Hex | null; matches: boolean }> {
  const m = view.manifest?.centres.find((c) => eq(c.evm, centre));
  const c = view.centres.find((x) => eq(x.address, centre));
  if (!m || !view.dir || !c) return { sealed: null, hash: null, matches: false };
  const sealed = await publicFile<SealedPaper>(view.dir, backup ? m.sealedB : m.sealedA);
  if (!sealed) return { sealed: null, hash: null, matches: false };
  const hash = sealedHash(sealed);
  return { sealed, hash, matches: eq(hash, backup ? c.ctHashB : c.ctHashA) };
}

export interface Reveal {
  canonicalPaper: Paper;
  canonicalPaperHash: Hex;
  salt: Hex;
  set: "A" | "B";
  centres: { name: string; evm: Hex; permSeedA: Hex; permSeedB: Hex; permSalt: Hex }[];
}

export interface FairnessCheck {
  label: string;
  ok: boolean;
  detail: string;
}

/**
 * Re-run the board's post-exam proof from scratch: the canonical paper matches its pre-exam
 * commitment, every permutation seed matches the centre's permCommit, and each centre's variant
 * is a pure reordering of the canonical paper (same questions, same answers).
 */
export async function verifyFairness(view: ExamView): Promise<{ reveal: Reveal | null; checks: FairnessCheck[] }> {
  if (!view.dir) return { reveal: null, checks: [] };
  const r = await publicFile<Reveal>(view.dir, "reveal.json");
  if (!r) return { reveal: null, checks: [] };
  const checks: FairnessCheck[] = [];
  const canon = bytesToHex(k256(enc.encode(JSON.stringify(r.canonicalPaper))));
  checks.push({ label: "Canonical paper hashes to the revealed hash", ok: eq(canon, r.canonicalPaperHash), detail: canon });
  const commit = bytesToHex(k256(cat(hexToBytes(r.canonicalPaperHash), hexToBytes(r.salt))));
  const onchainCommit = r.set === "B" ? view.onchain.paperCommitB : view.onchain.paperCommitA;
  checks.push({ label: `Paper matches set ${r.set} commitment made before the exam`, ok: eq(commit, onchainCommit), detail: commit });
  for (const c of r.centres) {
    const oc = view.centres.find((x) => eq(x.address, c.evm));
    const pc = bytesToHex(k256(cat(hexToBytes(c.permSeedA), hexToBytes(c.permSeedB), hexToBytes(c.permSalt))));
    checks.push({ label: `${c.name}: permutation seeds match on-chain permCommit`, ok: eq(pc, oc?.permCommit), detail: pc });
    const v = makeVariant(r.canonicalPaper, c.name, hexToBytes(r.set === "B" ? c.permSeedB : c.permSeedA));
    const same = v.paper.questions.every((q) => {
      const orig = r.canonicalPaper.questions.find((o) => o.id === q.id);
      return !!orig && orig.text === q.text && orig.options[orig.answer] === q.options[q.answer] && [...orig.options].sort().join() === [...q.options].sort().join();
    });
    checks.push({ label: `${c.name}: its committed order is a fair reordering`, ok: same && v.paper.questions.length === r.canonicalPaper.questions.length, detail: v.answerKey.join(" ") });
    // v2: the centre signed keccak256 of the exact paper it decrypted. Rebuild that paper from the
    // reveal and compare: this is what binds the reveal to what was actually sealed to the centre.
    const oc2 = view.centres.find((x) => eq(x.address, c.evm));
    if (view.dep.v >= 2) {
      const rebuilt = bytesToHex(k256(enc.encode(JSON.stringify(v.paper))));
      checks.push({ label: `${c.name}: its signed receipt names exactly this copy`, ok: !!oc2?.receipt && eq(rebuilt, oc2.receipt), detail: oc2?.receipt ?? "no receipt yet" });
    }
  }
  return { reveal: r, checks };
}
