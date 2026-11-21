/**
 * ZeroHour end to end on QoreChain testnet.
 *
 *   npm run demo -- actors              board, Leak Hunter, 2 centres: fund, ML-DSA keys, centre KEM keys + cards
 *   npm run demo -- keypers             keypers #2 and #3 on keyper #1's clock (fund, seed chain, bond)
 *   npm run demo -- exam [--in MIN]     create an exam unlocking in ~MIN minutes (default 10), seal per-centre
 *                                       variants (sets A and B) to the keypers' round keys + each centre's
 *                                       on-chain QoreSeal key, publish ciphertexts, addCentre for each
 *   (keypers run `zerohour-keyper run` — they pick the exam up from ExamCreated and release on time)
 *   npm run demo -- open <centre>       fetch released seeds from chain, check ctHash, decrypt, signed receipt
 *   npm run demo -- leak <centre> [--decoys N] [--no-file]   "leaked photo" of 4 questions -> trace -> signed reportLeak
 *   npm run demo -- photo <centre> [--from N --to M]   render a page of that centre's paper as a test "leaked photo"
 *   npm run demo -- hunt <photo> [--reader api|claude-code] [--decoys N] [--file]  Leak Hunter: Claude reads the photo, code traces it,
 *                                       files a signed reportLeak only with --file and >= 99% posterior
 *   npm run demo -- reveal              publish canonical paper + permutation seeds; revealFairness on chain
 *   npm run demo -- status
 *
 * Every board / centre / Leak Hunter action is an ML-DSA-87 signature over a contract digest,
 * verified on chain by the pqcVerify precompile. The board account relays the EVM transactions
 * through an EVM window scoped to the ZeroHourExam contract only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { mldsa87 } from "@qorechain/pqc";
import { recipientOf, seal as qsSeal, type RecipientCard } from "@qorechain/qoreseal";
import { resolveRecipient } from "@qorechain/qoreseal/network";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { weiToUqorCeil } from "@qorechain/evm";
import {
  bytesToHex, hexToBytes, isFairVariant, k256, makeVariant, seedAt, merkleRoot, openPaper, pkLeaf, sealPaper, sealedHash, traceLeak, verifyMerkle,
  type Observation, type Paper, type SealedPaper,
} from "@zerohour/hourglass";
import { contracts, net_ } from "@zerohour/keyper/src/config.ts";
import { openWindow, windowProblem, windowStatus } from "@zerohour/keyper/src/native.ts";
import { fees, keyperRecord, pub, wallet } from "@zerohour/keyper/src/registry.ts";
import { currentRound, roundTime } from "@zerohour/keyper/src/schedule.ts";
import { formatEther, parseAbi, parseEventLogs, toHex, type Hex } from "viem";
import { generateSealKeys } from "@qorechain/qoreseal";
import { ACTORS, PUBLIC, ROOT, SECRETS, loadActor, setupActor, topUp, type Actor } from "./actors.ts";
import { FILE_THRESHOLD, masterCopy, matchToPaper, readPhoto, readPhotoWithClaudeCode, traceAndDecide } from "./hunter.ts";

const examAbi = parseAbi([
  "function createDigest(bytes32,address,address,address[],uint8,uint32,uint32,bytes32,bytes32,bytes32) view returns (bytes32)",
  "function createExam(bytes32 label,address,address,address[],uint8,uint32,uint32,bytes32,bytes32,bytes32,bytes)",
  "function examIdOf(address,bytes32) pure returns (bytes32)",
  "function receiptOf(bytes32,address,bool) view returns (bytes32)",
  "function centreDigest(bytes32,address,bytes32,bytes32,bytes32) view returns (bytes32)",
  "function addCentre(bytes32,address,bytes32,bytes32,bytes32,bytes)",
  "function openDigest(bytes32,address,bool,bytes32) view returns (bytes32)",
  "function recordOpening(bytes32,address,bytes32,bytes)",
  "function leakDigest(bytes32,address,bytes32,uint16,bytes32) view returns (bytes32)",
  "function reportLeak(bytes32,address,bytes32,uint16,bytes32,bytes)",
  "function revealDigest(bytes32,bytes32,bytes32) view returns (bytes32)",
  "function revealFairness(bytes32,bytes32,bytes32,bytes)",
  "function isUnlocked(bytes32) view returns (bool)",
  "function activeRound(bytes32) view returns (uint32)",
  "function switchDigest(bytes32,bytes32) view returns (bytes32)",
  "function switchToBackup(bytes32,bytes32,bytes)",
  "struct Exam { address board; address leakHunter; uint8 threshold; bool usingBackup; bool revealed; uint32 roundA; uint32 roundB; bytes32 paperCommitA; bytes32 paperCommitB; bytes32 manifestRoot; address[] keypers; }",
  "function getExam(bytes32) view returns (Exam)",
  "function centres(bytes32,address) view returns (bool registered, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit, uint64 openedAt, uint32 leakReports)",
]);
const registryAbi = parseAbi([
  "function seedOf(address,uint32) view returns (bytes32)",
  "function reportCommitment(address,uint32,bytes32,bytes32,address) pure returns (bytes32)",
  "function commitReport(bytes32)",
  "function revealReport(address,uint32,bytes32,bytes32)",
  "function roundTime(address,uint32) view returns (uint256)",
  "event KeyperSlashed(address indexed keyper, uint32 indexed round, bytes32 seed, address indexed reporter, uint256 reward)",
]);

const EXAM = contracts.exam;
const KEYPER_CLI = resolve(ROOT, "apps/keyper/src/cli.ts");
/** One state file per exam: EXAM_STATE=bribery picks secrets/demo/exam-bribery.json. */
const STATE = resolve(SECRETS, process.env.EXAM_STATE ? `exam-${process.env.EXAM_STATE}.json` : "exam.json");
const enc = new TextEncoder();
const cat = (...xs: Uint8Array[]) => new Uint8Array(xs.flatMap((x) => [...x]));
const rand32 = () => crypto.getRandomValues(new Uint8Array(32));
const say = (s: string) => console.log(s);
/** `--name value` from argv, or `fallback` when absent/invalid. */
const numOpt = (args: string[], name: string, fallback: number) => {
  const i = args.indexOf(name);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
};

// ------------------------------------------------------------------ keypers
/** v2 keypers: same accounts and ML-DSA keys as v1, fresh seed chains in secrets/v2/. */
const KEYPERS = [
  { id: 1, env: { KEYPER_HOME: "secrets/v2/keyper1-home", KEYPER_ACCOUNT: "secrets/drill.secret.json" } },
  { id: 2, env: { KEYPER_HOME: "secrets/v2/keyper2-home", KEYPER_ACCOUNT: "secrets/keyper2-home/account.secret.json" } },
  { id: 3, env: { KEYPER_HOME: "secrets/v2/keyper3-home", KEYPER_ACCOUNT: "secrets/keyper3-home/account.secret.json" } },
  { id: 4, env: { KEYPER_HOME: "secrets/v2/keyper4-home", KEYPER_ACCOUNT: "secrets/keyper4-home/account.secret.json" } }, // the bribery run
];
const THRESHOLD = 2;

function keyperCli(k: (typeof KEYPERS)[number], args: string[], extraEnv: Record<string, string> = {}) {
  const env = { ...process.env, ...Object.fromEntries(Object.entries(k.env).map(([a, b]) => [a, resolve(ROOT, b)])), ...extraEnv };
  const r = spawnSync("npx", ["tsx", KEYPER_CLI, ...args], { cwd: resolve(ROOT, "apps/keyper"), env, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`keyper #${k.id} ${args[0]} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
}
const keyperAddress = async (k: (typeof KEYPERS)[number]) => {
  const file = resolve(ROOT, k.env.KEYPER_ACCOUNT ?? `${k.env.KEYPER_HOME}/account.secret.json`);
  return (await deriveUnifiedAccount(JSON.parse(readFileSync(file, "utf8")).mnemonic, 0)).evm as Hex;
};
const drill = async () => deriveUnifiedAccount(JSON.parse(readFileSync(resolve(ROOT, "secrets/drill.secret.json"), "utf8")).mnemonic, 0);

// ------------------------------------------------------------------ relaying
async function sign(a: Actor, digest: Hex): Promise<Hex> {
  return toHex(mldsa87.sign(a.acc.pqc.secretKey, hexToBytes(digest)));
}
async function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  return pub.readContract({ address: EXAM, abi: examAbi, functionName: functionName as any, args: args as any }) as Promise<T>;
}
/** Board relays an ML-DSA-authorised call through its exam-scoped EVM window. */
async function relay(board: Actor, functionName: string, args: readonly unknown[]) {
  const from = board.acc.evm as Hex;
  const gasEst = await pub.estimateContractGas({ address: EXAM, abi: examAbi, functionName: functionName as any, args: args as any, account: from });
  const gas = (gasEst * 13n) / 10n;
  const fee = await fees();
  const cost = weiToUqorCeil(gas * fee.maxFeePerGas);
  const why = windowProblem(await windowStatus(board.acc), EXAM, cost);
  if (why) {
    const perTx = weiToUqorCeil(2_500_000n * fee.maxFeePerGas);
    say(`  window (${why}) -> ${await openWindow(board.acc, [EXAM], perTx > cost ? perTx : cost)}  [scoped to ZeroHourExam]`);
  }
  const hash = await wallet(board.acc.privateKey as Hex).writeContract({ address: EXAM, abi: examAbi, functionName: functionName as any, args: args as any, gas, ...fee });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  say(`  ${functionName}: ${hash}  (gas ${rc.gasUsed})`);
  return hash;
}

/** Send a tx from `who`'s own account through an EVM window scoped to `target` only. */
async function sendAs(who: Actor, target: Hex, abi: any, functionName: string, args: readonly unknown[]) {
  const from = who.acc.evm as Hex;
  const gas = ((await pub.estimateContractGas({ address: target, abi, functionName, args: args as any, account: from })) * 13n) / 10n;
  const fee = await fees();
  const cost = weiToUqorCeil(gas * fee.maxFeePerGas);
  const why = windowProblem(await windowStatus(who.acc), target, cost);
  if (why) {
    const perTx = weiToUqorCeil(1_000_000n * fee.maxFeePerGas);
    say(`  window (${why}) -> ${await openWindow(who.acc, [target], (perTx > cost ? perTx : cost) * 4n)}  [scoped to ${target === contracts.hourglass ? "HourglassRegistry" : target}]`);
  }
  const hash = await wallet(who.acc.privateKey as Hex).writeContract({ address: target, abi, functionName, args: args as any, gas, ...fee });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  say(`  ${functionName}: ${hash}  (block ${rc.blockNumber}, gas ${rc.gasUsed})`);
  return rc;
}

// ------------------------------------------------------------------ state
interface CentreState {
  name: string;
  evm: Hex;
  cosmos: string;
  permSeedA: Hex;
  permSeedB: Hex;
  permSalt: Hex;
  ctHashA: Hex;
  ctHashB: Hex;
}
interface ExamState {
  examId: Hex;
  label: string;
  roundA: number;
  roundB: number;
  unlockA: string;
  unlockB: string;
  keypers: Hex[];
  threshold: number;
  saltA: Hex;
  saltB: Hex;
  canonA: Hex;
  canonB: Hex;
  centres: CentreState[];
  txs: Record<string, string>;
}
const loadState = (): ExamState => {
  if (!existsSync(STATE)) throw new Error("no exam yet — run: npm run demo -- exam");
  return JSON.parse(readFileSync(STATE, "utf8"));
};
const saveState = (s: ExamState) => writeFileSync(STATE, JSON.stringify(s, null, 2), { mode: 0o600 });
const pubDir = (s: { examId: Hex }) => resolve(PUBLIC, s.examId.slice(0, 10));
const writePublic = (s: { examId: Hex }, file: string, data: unknown) => {
  mkdirSync(resolve(pubDir(s), "sealed"), { recursive: true });
  writeFileSync(resolve(pubDir(s), file), JSON.stringify(data, null, 2));
};
const paper = (set: "a" | "b"): Paper => JSON.parse(readFileSync(resolve(ROOT, `apps/demo/papers/set-${set}.json`), "utf8"));
const canonHash = (p: Paper) => bytesToHex(k256(enc.encode(JSON.stringify(p))));
const centreActor = (c: CentreState) => loadActor(c.name, "centre");

/** Seed for `round` as published on chain: stored directly, or hashed down from a later release. */
async function chainSeed(keyper: Hex, round: number): Promise<Uint8Array | null> {
  const rec = await keyperRecord(keyper);
  if (round >= rec.nextRound) return null;
  const direct = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "seedOf", args: [keyper, round] });
  if (BigInt(direct) !== 0n) return hexToBytes(direct);
  let s = hexToBytes(rec.lastHash); // = seed[nextRound - 1]
  for (let r = rec.nextRound - 1; r > round; r--) s = k256(s);
  return s;
}


/**
 * Seal the evidence to the board with QoreSeal, publish the envelope, and file reportLeak signed by
 * the Leak Hunter's ML-DSA-87 key. Only the evidence hash and the envelope hash go on chain.
 */
async function fileLeakReport(st: ExamState, accused: CentreState, evidence: unknown, posterior: number, board: Actor, hunter: Actor) {
  const evidenceBytes = enc.encode(JSON.stringify(evidence));
  const evidenceHash = bytesToHex(k256(evidenceBytes));
  const envelope = qsSeal({ chainId: net_.chainId, purpose: "zerohour-leak-evidence-v1", recipients: [recipientOf(board.seal)], plaintext: evidenceBytes });
  const sealedRef = bytesToHex(k256(envelope));
  writePublic(st, `leak-${evidenceHash.slice(0, 10)}.sealed.json`, { evidenceHash, sealedEvidenceRef: sealedRef, envelope: bytesToHex(envelope), sealedTo: "board (QoreSeal)" });
  const bps = Math.min(10_000, Math.floor(posterior * 10_000));
  const a = [st.examId, accused.evm, evidenceHash, bps, sealedRef] as const;
  const key = st.txs[`reportLeak:${accused.name}`] ? `reportLeak:${accused.name}:${Date.now()}` : `reportLeak:${accused.name}`;
  st.txs[key] = await relay(board, "reportLeak", [...a, await sign(hunter, await read<Hex>("leakDigest", a))]);
  saveState(st);
  say(`Leak Hunter (ML-DSA-87) attributed the leak to ${accused.name} at ${(bps / 100).toFixed(2)}%; evidence sealed to the board (${evidenceHash.slice(0, 10)}).`);
}

/** Simple HTML exam page for one centre's variant, used to make test "leaked photos". */
function pageHtml(p: Paper, from: number, to: number) {
  const esc = (x: string) => x.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  const qs = p.questions.slice(from - 1, to).map((q, i) => `<li value="${from + i}"><p>${esc(q.text)}</p><ol type="A">${q.options.map((o) => `<li>${esc(o)}</li>`).join("")}</ol></li>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#d8d2c4;font:17px/1.5 Georgia,serif}
.sheet{width:760px;margin:40px auto;padding:48px 56px;background:#fbfaf6;color:#222;transform:rotate(-2.2deg);box-shadow:0 18px 40px rgba(0,0,0,.35);filter:blur(.35px) contrast(1.05)}
h1{font-size:20px;margin:0 0 4px}.sub{font-size:13px;color:#555;margin-bottom:18px;border-bottom:1px solid #999;padding-bottom:8px}
ol.q>li{margin-bottom:16px}ol[type=A]{margin:6px 0 0;padding-left:24px}p{margin:0}
</style><div class="sheet"><h1>${esc(p.title)}</h1><div class="sub">Time: 3 hours &nbsp; Maximum marks: 720 &nbsp; Page ${Math.ceil(from / 5)}</div><ol class="q">${qs}</ol></div>`;
}

// ------------------------------------------------------------------ commands
const commands: Record<string, (a: string[]) => Promise<void>> = {
  async actors() {
    const funder = await drill();
    for (const spec of ACTORS) {
      say(`${spec.name}…`);
      console.log(await setupActor(funder, spec));
    }
  },

  async keypers() {
    const funder = await drill();
    const k1 = await keyperRecord(await keyperAddress(KEYPERS[0]));
    for (const k of KEYPERS.slice(1)) {
      const home = resolve(ROOT, k.env.KEYPER_HOME);
      if (!existsSync(resolve(home, "account.secret.json"))) say(keyperCli(k, ["new"]).trim());
      const addr = await keyperAddress(k);
      const rec = await keyperRecord(addr);
      if (rec.registered) {
        say(`keyper #${k.id} ${addr} already registered`);
        continue;
      }
      const tx = await topUp(funder, (await deriveUnifiedAccount(JSON.parse(readFileSync(resolve(home, "account.secret.json"), "utf8")).mnemonic, 0)).cosmos, 2.5);
      if (tx) say(`funded keyper #${k.id}: ${tx}`), await new Promise((r) => setTimeout(r, 3000));
      say(keyperCli(k, ["setup"], { GENESIS: String(k1.genesis), ROUND_SECONDS: String(k1.roundSeconds), MAX_ROUND: String(k1.maxRound) }).trim());
    }
  },

  async exam(args) {
    if (existsSync(STATE)) throw new Error(`an exam already exists (${STATE}) — move it away to start a new one`);
    const minutes = numOpt(args, "--in", 10);
    const ids = args.includes("--keypers") ? args[args.indexOf("--keypers") + 1].split(",").map(Number) : [1, 2, 3];
    const chosen = KEYPERS.filter((k) => ids.includes(k.id));
    // Outside keypers: run by someone else; we only ever see their PUBLIC round keys (export-pk --hours).
    const outsideFiles = args.includes("--outside") ? args[args.indexOf("--outside") + 1].split(",") : [];
    const threshold = numOpt(args, "--threshold", THRESHOLD);
    const total = chosen.length + outsideFiles.length;
    if (chosen.length !== ids.length || threshold < 2 || total < threshold) throw new Error(`need ${threshold}+ keypers (local: ${KEYPERS.map((k) => k.id).join(",")}; outside: --outside file.json)`);
    const kind = (args.includes("--kind") ? args[args.indexOf("--kind") + 1] : "demo").toUpperCase().replace(/[^A-Z]/g, "");
    const board = await loadActor("board", "board");
    const hunter = await loadActor("leak-hunter", "hunter");
    const centres = await Promise.all(ACTORS.filter((a) => a.role === "centre").map((a) => loadActor(a.name, "centre")));

    // 1. keypers: same clock, round keys verified against each keyper's on-chain pkRoot
    const outside = outsideFiles.map((f) => JSON.parse(readFileSync(f, "utf8")) as { keyper: Hex; registry: Hex; keys: { round: number; publicKey: Hex; proof: Hex[] }[] });
    for (const o of outside) if (o.registry.toLowerCase() !== contracts.hourglass.toLowerCase()) throw new Error(`outside keyper ${o.keyper} published keys for registry ${o.registry}, not ${contracts.hourglass}`);
    const keypers = [...(await Promise.all(chosen.map(keyperAddress))), ...outside.map((o) => o.keyper)];
    if (new Set(keypers.map((k) => k.toLowerCase())).size !== keypers.length) throw new Error("a keyper is listed twice");
    const recs = await Promise.all(keypers.map((k) => keyperRecord(k)));
    recs.forEach((r, i) => {
      if (!r.registered || r.slashed) throw new Error(`keyper #${i + 1} not usable`);
      if (r.genesis !== recs[0].genesis || r.roundSeconds !== recs[0].roundSeconds) throw new Error(`keyper #${i + 1} is on a different clock`);
    });
    const head = await pub.getBlock();
    const roundA = currentRound(recs[0], Number(head.timestamp)) + Math.max(2, Math.ceil((minutes * 60) / recs[0].roundSeconds));
    const roundB = roundA + Math.max(1, numOpt(args, "--gap", 2));
    say(`exam rounds: A=${roundA} (${new Date(roundTime(recs[0], roundA) * 1000).toISOString()}), B=${roundB} (${new Date(roundTime(recs[0], roundB) * 1000).toISOString()})`);

    const roundKeys: Record<number, { keyper: string; publicKey: Uint8Array }[]> = { [roundA]: [], [roundB]: [] };
    for (const [i, k] of chosen.entries()) {
      const out = JSON.parse(keyperCli(k, ["export-pk", String(roundA), String(roundB)]).trim().split("\n").pop()!);
      for (const key of out.keys) {
        const pk = hexToBytes(key.publicKey);
        if (!verifyMerkle(pkLeaf(pk), key.round, key.proof.map(hexToBytes), hexToBytes(recs[i].pkRoot))) throw new Error(`keyper #${k.id}: bad Merkle proof for round ${key.round}`);
        roundKeys[key.round].push({ keyper: keypers[i], publicKey: pk });
      }
      say(`keyper #${k.id} ${keypers[i]}: round keys ${roundA}/${roundB} verified against on-chain pkRoot`);
    }
    for (const [j, o] of outside.entries()) {
      const i = chosen.length + j;
      for (const round of [roundA, roundB]) {
        const key = o.keys.find((k) => k.round === round);
        if (!key) throw new Error(`outside keyper ${o.keyper} has not published round ${round} (its file covers ${o.keys[0]?.round}-${o.keys.at(-1)?.round}); ask for a fresh export-pk --hours 48`);
        const pk = hexToBytes(key.publicKey);
        if (!verifyMerkle(pkLeaf(pk), round, key.proof.map(hexToBytes), hexToBytes(recs[i].pkRoot))) throw new Error(`outside keyper ${o.keyper}: bad Merkle proof for round ${round}`);
        roundKeys[round].push({ keyper: keypers[i], publicKey: pk });
      }
      say(`OUTSIDE keyper ${o.keyper}: round keys ${roundA}/${roundB} verified against its on-chain pkRoot (we hold none of its secrets)`);
    }

    // 2. centres: recipient = on-chain ML-KEM key + hybrid-signed card, verified
    const recipients = await Promise.all(
      centres.map(async (c) => {
        const card: RecipientCard = JSON.parse(readFileSync(resolve(PUBLIC, "cards", `${c.name}.card.json`), "utf8"));
        return resolveRecipient({ rest: net_.rest, chainId: net_.chainId, address: c.acc.cosmos, card });
      }),
    );

    // 3. per-centre variants, sealed with both locks
    const label = `ZEROHOUR-${kind}-${new Date().toISOString().slice(0, 16)}`;
    // v2: the exam id is derived on chain from (board, label), so nobody can squat it
    const labelHash = bytesToHex(k256(enc.encode(label)));
    const examId = await read<Hex>("examIdOf", [board.acc.evm, labelHash]);
    const [pA, pB] = [paper("a"), paper("b")];
    const st: ExamState = {
      examId, label, roundA, roundB,
      unlockA: new Date(roundTime(recs[0], roundA) * 1000).toISOString(),
      unlockB: new Date(roundTime(recs[0], roundB) * 1000).toISOString(),
      keypers, threshold, saltA: bytesToHex(rand32()), saltB: bytesToHex(rand32()), canonA: canonHash(pA), canonB: canonHash(pB),
      centres: [], txs: {},
    };
    for (const [i, c] of centres.entries()) {
      const permSeedA = rand32(), permSeedB = rand32(), permSalt = rand32();
      const sealSet = (p: Paper, seed: Uint8Array, round: number) =>
        sealPaper({ plaintext: enc.encode(JSON.stringify(makeVariant(p, c.name, seed).paper)), chainId: net_.chainId, round, threshold, keypers: roundKeys[round], recipient: recipients[i] });
      const [sA, sB] = [await sealSet(pA, permSeedA, roundA), await sealSet(pB, permSeedB, roundB)];
      st.centres.push({
        name: c.name, evm: c.acc.evm as Hex, cosmos: c.acc.cosmos,
        permSeedA: bytesToHex(permSeedA), permSeedB: bytesToHex(permSeedB), permSalt: bytesToHex(permSalt),
        ctHashA: sealedHash(sA), ctHashB: sealedHash(sB),
      });
      writePublic(st, `sealed/${c.name}-A.json`, sA);
      writePublic(st, `sealed/${c.name}-B.json`, sB);
      say(`sealed ${c.name}: A ${sealedHash(sA).slice(0, 18)}…  B ${sealedHash(sB).slice(0, 18)}…  (${JSON.stringify(sA).length} bytes each)`);
    }
    saveState(st);

    // 4. on chain: createExam + addCentre (board ML-DSA signatures, board relays)
    const commitA = bytesToHex(k256(cat(hexToBytes(st.canonA), hexToBytes(st.saltA))));
    const commitB = bytesToHex(k256(cat(hexToBytes(st.canonB), hexToBytes(st.saltB))));
    const manifestRoot = bytesToHex(merkleRoot(st.centres.map((c) => k256(cat(hexToBytes(c.evm), hexToBytes(c.ctHashA), hexToBytes(c.ctHashB))))));
    const cArgs = [examId, board.acc.evm, hunter.acc.evm, keypers, threshold, roundA, roundB, commitA, commitB, manifestRoot] as const;
    st.txs.createExam = await relay(board, "createExam", [labelHash, ...cArgs.slice(1), await sign(board, await read<Hex>("createDigest", cArgs))]);
    for (const c of st.centres) {
      const permCommit = bytesToHex(k256(cat(hexToBytes(c.permSeedA), hexToBytes(c.permSeedB), hexToBytes(c.permSalt))));
      const a = [examId, c.evm, c.ctHashA, c.ctHashB, permCommit] as const;
      st.txs[`addCentre:${c.name}`] = await relay(board, "addCentre", [...a, await sign(board, await read<Hex>("centreDigest", a))]);
    }
    saveState(st);
    writePublic(st, "manifest.json", {
      exam: label, examId, contract: EXAM, hourglass: contracts.hourglass, chain: net_.chainId,
      roundA, roundB, unlockA: st.unlockA, unlockB: st.unlockB, threshold, keypers,
      board: board.acc.evm, leakHunter: hunter.acc.evm, paperCommitA: commitA, paperCommitB: commitB, manifestRoot,
      centres: st.centres.map((c) => ({ name: c.name, evm: c.evm, cosmos: c.cosmos, ctHashA: c.ctHashA, ctHashB: c.ctHashB, sealedA: `sealed/${c.name}-A.json`, sealedB: `sealed/${c.name}-B.json` })),
      txs: st.txs,
    });
    say(`\nexam ${label} live. Ciphertexts are public in deployments/demo/${examId.slice(0, 10)}/ — they open at ${st.unlockA}.`);
    say(`keypers: keep \`zerohour-keyper run\` going (all three) so round ${roundA} is released on time.`);
  },

  async open([name]) {
    const st = loadState();
    const c = st.centres.find((x) => x.name === name) ?? (() => { throw new Error(`centres: ${st.centres.map((x) => x.name).join(", ")}`); })();
    const centre = await centreActor(c);
    const board = await loadActor("board", "board");
    const round = await read<number>("activeRound", [st.examId]);
    const set = round === st.roundB ? "B" : "A";
    const sealed: SealedPaper = JSON.parse(readFileSync(resolve(pubDir(st), `sealed/${c.name}-${set}.json`), "utf8"));
    const onchain = await read<readonly [boolean, Hex, Hex, Hex, bigint, number]>("centres", [st.examId, c.evm]);
    if (sealedHash(sealed).toLowerCase() !== (set === "A" ? onchain[1] : onchain[2]).toLowerCase()) throw new Error("ciphertext does not match the on-chain ctHash — tampered copy");
    say(`set ${set}, round ${round}: ciphertext matches on-chain ctHash`);

    const seeds: Record<string, Uint8Array> = {};
    for (const k of st.keypers) {
      const s = await chainSeed(k, round);
      say(`  keyper ${k}: ${s ? "seed released" : "not yet"}`);
      if (s) seeds[k] = s;
    }
    const t0 = performance.now();
    const plain = await openPaper(sealed, seeds, centre.seal);
    const p: Paper = JSON.parse(new TextDecoder().decode(plain));
    say(`decrypted in ${(performance.now() - t0).toFixed(0)} ms: "${p.title}", ${p.questions.length} questions. Q1: ${p.questions[0].text}`);
    writeFileSync(resolve(SECRETS, `${c.name}-${set}.opened.json`), JSON.stringify(p, null, 2), { mode: 0o600 });

    // v2 receipt: the centre signs keccak256 of the exact plaintext it decrypted. After the
    // fairness reveal anyone can rebuild this centre's copy and check it is the committed one.
    const paperHash = bytesToHex(k256(plain));
    const existing = await read<Hex>("receiptOf", [st.examId, c.evm, set === "B"]);
    if (BigInt(existing) === 0n) {
      const d = await read<Hex>("openDigest", [st.examId, c.evm, set === "B", paperHash]);
      st.txs[`recordOpening:${c.name}`] = await relay(board, "recordOpening", [st.examId, c.evm, paperHash, await sign(centre, d)]);
      say(`  receipt names paper ${paperHash.slice(0, 18)}…`);
      saveState(st);
    } else say(`receipt already on chain for set ${set} (paper ${existing.slice(0, 18)}…)`);
  },

  async leak(args) {
    const st = loadState();
    const name = args[0];
    const decoys = numOpt(args, "--decoys", 998);
    const culprit = st.centres.find((x) => x.name === name) ?? (() => { throw new Error(`centres: ${st.centres.map((x) => x.name).join(", ")}`); })();
    const board = await loadActor("board", "board");
    const hunter = await loadActor("leak-hunter", "hunter");
    const set = (await read<number>("activeRound", [st.examId])) === st.roundB ? "b" : "a";
    const p = paper(set);
    const seedOf = (c: CentreState) => hexToBytes(set === "a" ? c.permSeedA : c.permSeedB);

    // The "leaked photo": what an OCR pass reads off 4 questions of the culprit's copy.
    const leaked = makeVariant(p, culprit.name, seedOf(culprit));
    const obs: Observation[] = [0, 1, 2, 3].map((i) => ({ position: i, questionId: leaked.paper.questions[i].id, firstOption: leaked.paper.questions[i].options[0] }));
    const variants = [
      ...st.centres.map((c) => makeVariant(p, c.name, seedOf(c))),
      ...Array.from({ length: decoys }, (_, i) => makeVariant(p, `simulated-centre-${i}`, rand32())),
    ];
    const ranking = traceLeak(variants, obs).slice(0, 5);
    say(`trace over ${variants.length} centres (${st.centres.length} real${decoys ? ` + ${decoys} simulated` : ""}):`);
    ranking.forEach((r) => say(`  ${r.centre.padEnd(22)} posterior ${r.posterior.toFixed(6)}  (${r.matches}/${r.observed})`));
    const top = ranking[0];
    const accused = st.centres.find((c) => c.name === top.centre);
    if (!accused) throw new Error("top match is not a real centre — not filing");
    if (args.includes("--no-file")) return say("(--no-file: trace only, nothing filed)");

    const evidence = { examId: st.examId, set: set.toUpperCase(), observations: obs, ranking, method: "noisy-channel posterior over per-centre permutations, epsilon=0.05", at: new Date().toISOString() };
    await fileLeakReport(st, accused, evidence, top.posterior, board, hunter);
  },

  async photo(args) {
    const st = loadState();
    const name = args[0];
    const set = (await read<number>("activeRound", [st.examId])) === st.roundB ? "b" : "a";
    const from = numOpt(args, "--from", 3), to = numOpt(args, "--to", 7);
    mkdirSync(resolve(SECRETS, "leaks"), { recursive: true });
    // --master: the setters' master copy (canonical order), as it exists before sealing
    if (name === "--master") {
      const out = resolve(SECRETS, "leaks", `master-${set}-q${from}-${to}.html`);
      writeFileSync(out, pageHtml(paper(set), from, to));
      return say(`wrote ${out}  (paper ${set.toUpperCase()}, master copy)\nopen it, screenshot or photograph the page, then: npm run demo -- hunt <image>`);
    }
    const c = st.centres.find((x) => x.name === name) ?? (() => { throw new Error(`usage: photo <centre>|--master; centres: ${st.centres.map((x) => x.name).join(", ")}`); })();
    const v = makeVariant(paper(set), c.name, hexToBytes(set === "a" ? c.permSeedA : c.permSeedB));
    const out = resolve(SECRETS, "leaks", `${c.name}-q${from}-${to}.html`);
    writeFileSync(out, pageHtml(v.paper, from, to));
    say(`wrote ${out}\nopen it, screenshot or photograph the page, then: npm run demo -- hunt <image>`);
  },

  async hunt(args) {
    const st = loadState();
    const photo = args[0];
    if (!photo || !existsSync(photo)) throw new Error("usage: npm run demo -- hunt <photo.png|jpg> [--decoys N] [--file]");
    const decoys = numOpt(args, "--decoys", 998);
    const set = (await read<number>("activeRound", [st.examId])) === st.roundB ? "b" : "a";
    const canonical = paper(set);

    const reader = args.includes("--reader") ? args[args.indexOf("--reader") + 1] : "api";
    if (reader !== "api" && reader !== "claude-code") throw new Error("--reader must be api or claude-code");
    say(`1. reading the photo with Claude (vision, structured output, via ${reader === "api" ? "the Claude API" : "Claude Code"})…`);
    const reading = reader === "api" ? await readPhoto(photo) : await readPhotoWithClaudeCode(photo);
    const t = reading.transcription;
    say(`   ${reading.model}, ${reading.usage.input} in / ${reading.usage.output} out tokens; ${t.questions.length} question(s) read${t.legible ? "" : " (marked illegible)"}`);
    if (t.notes) say(`   notes: ${t.notes}`);

    say(`2. matching the transcription to the canonical paper (code, no model)…`);
    const { matched, observations } = matchToPaper(t, canonical);
    for (const m of matched) say(`   Q${m.printedNumber}: ${m.dropped ? `dropped (${m.dropped})` : `${m.questionId}, text match ${m.textScore.toFixed(2)}${m.firstOption ? `, first option "${m.firstOption}"` : ""}`}`);

    say(`3. tracing against the setters' master copy + ${st.centres.length} real + ${decoys} simulated centre variants…`);
    const real = st.centres.map((c) => makeVariant(canonical, c.name, hexToBytes(set === "a" ? c.permSeedA : c.permSeedB)));
    const simulated = Array.from({ length: decoys }, (_, i) => makeVariant(canonical, `simulated-centre-${i}`, rand32()));
    const verdict = traceAndDecide(observations, real, simulated, masterCopy(canonical));
    verdict.ranking.slice(0, 5).forEach((r) => say(`   ${r.centre.padEnd(26)} posterior ${r.posterior.toFixed(6)}  (${r.matches}/${r.observed})`));
    say(`4. verdict: ${verdict.source === "centre" ? "attributable to a centre" : verdict.source === "master" ? "pre-distribution leak" : "not attributable"}: ${verdict.reason}`);

    if (verdict.source === "master") {
      // Nobody to accuse; the paper itself is burned. Write the public switch evidence for the board.
      const [unlocked, onchain] = await Promise.all([read<boolean>("isUnlocked", [st.examId]), read<{ usingBackup: boolean }>("getExam", [st.examId])]);
      if (onchain.usingBackup) return say("   already on the backup paper; nothing to switch");
      const evidence = {
        kind: "zerohour-switch-evidence-v1", examId: st.examId, set: set.toUpperCase(), photoHash: reading.photoHash,
        reader: { model: reading.model, responseId: reading.responseId, transcription: t },
        matched, observations, ranking: verdict.ranking.slice(0, 10), verdict: verdict.reason,
        paperAUnlockedAtHunt: unlocked,
        population: { master: 1, real: verdict.realCentres, simulated: verdict.simulatedCentres },
        method: "Claude transcribes; deterministic text match; noisy-channel posterior over the master copy and every centre's permutation, epsilon=0.05",
        at: new Date().toISOString(),
      };
      const text = JSON.stringify(evidence, null, 2);
      const hash = bytesToHex(k256(enc.encode(text)));
      const file = resolve(SECRETS, "leaks", `switch-evidence-${hash.slice(0, 10)}.json`);
      writeFileSync(file, text);
      say(`   paper ${set.toUpperCase()} leaked before sealing${unlocked ? "" : " and before its bell"}. Evidence ${hash.slice(0, 10)} written to ${file}`);
      return say(`   the board decides: npm run demo -- switch ${file}`);
    }
    if (!verdict.fileable) return;
    if (!args.includes("--file")) return say(`   (dry run: add --file to seal the evidence and file reportLeak at >= ${FILE_THRESHOLD})`);
    const accused = st.centres.find((c) => c.name === verdict.top!.centre)!;
    const evidence = {
      examId: st.examId, set: set.toUpperCase(), photoHash: reading.photoHash,
      reader: { model: reading.model, responseId: reading.responseId, transcription: t },
      matched, observations, ranking: verdict.ranking.slice(0, 10),
      population: { real: verdict.realCentres, simulated: verdict.simulatedCentres },
      method: "Claude transcribes; deterministic text match; noisy-channel posterior over per-centre permutations, epsilon=0.05",
      at: new Date().toISOString(),
    };
    await fileLeakReport(st, accused, evidence, verdict.top!.posterior, await loadActor("board", "board"), await loadActor("leak-hunter", "hunter"));
  },

  /**
   * Export a centre's DECRYPTION key only: the 32-byte QoreSeal seed (HKDF of the BIP-39 seed under
   * QoreSeal's own label). It opens that centre's copies and nothing else: it cannot recover the
   * phrase, sign a transaction, move funds or file a receipt. This is what the centre console takes.
   */
  async "decryption-key"([name]) {
    const spec = ACTORS.find((a) => a.name === name && a.role === "centre");
    if (!spec) throw new Error(`usage: decryption-key <centre>; centres: ${ACTORS.filter((a) => a.role === "centre").map((a) => a.name).join(", ")}`);
    const c = await loadActor(spec.name, "centre");
    const key = `zerohour-centre-key:${bytesToHex(c.seal.seed).slice(2)}`;
    const out = resolve(SECRETS, `${spec.name}.decryption-key.txt`);
    writeFileSync(out, key + "\n", { mode: 0o600 });
    say(`wrote ${out}\nload it in the centre console after the bell. It opens only ${spec.name}'s copies.`);
  },

  /**
   * The board moves every centre to the pre-sealed backup paper B in one ML-DSA-87 signed call.
   * The reason on chain is keccak256 of the evidence file, which is published as-is: paper A is
   * retired by the switch and the leaked text is public already, so anyone can re-hash it.
   */
  async switch([file]) {
    const st = loadState();
    if (!file || !existsSync(file)) throw new Error("usage: npm run demo -- switch <switch-evidence.json>  (written by: hunt <photo>)");
    const text = readFileSync(file, "utf8");
    const ev = JSON.parse(text);
    if (ev.kind !== "zerohour-switch-evidence-v1" || ev.examId?.toLowerCase() !== st.examId.toLowerCase()) throw new Error("evidence is not a switch evidence file for this exam");
    const reasonHash = bytesToHex(k256(enc.encode(text)));
    const e = await read<{ usingBackup: boolean; roundB: number; keypers: readonly Hex[] }>("getExam", [st.examId]);
    if (e.usingBackup) throw new Error("already switched to the backup paper");
    const rec = await keyperRecord(e.keypers[0]);
    const now = Number((await pub.getBlock()).timestamp);
    if (now >= roundTime(rec, e.roundB)) throw new Error("too late: backup paper B is already unlocking");
    say(`switching ${st.label} to backup paper B (round ${st.roundB}, bell ${st.unlockB}); reason ${reasonHash.slice(0, 18)}…`);
    const board = await loadActor("board", "board");
    st.txs.switchToBackup = await relay(board, "switchToBackup", [st.examId, reasonHash, await sign(board, await read<Hex>("switchDigest", [st.examId, reasonHash]))]);
    saveState(st);
    mkdirSync(pubDir(st), { recursive: true });
    writeFileSync(resolve(pubDir(st), `switch-${reasonHash.slice(0, 10)}.json`), text);
    say(`every centre is now on paper B. Public evidence: deployments/demo/${st.examId.slice(0, 10)}/switch-${reasonHash.slice(0, 10)}.json`);
  },

  /**
   * The corrupt keyper. It hands its seed for an exam round to a briber before the bell: one 32-byte
   * value derived from its own chain secret, exactly what a real bribe would buy.
   */
  async bribe(args) {
    const st = loadState();
    const id = Number(args[0]);
    const k = KEYPERS.find((x) => x.id === id) ?? (() => { throw new Error(`keyper ids: ${KEYPERS.map((x) => x.id).join(", ")}`); })();
    const addr = await keyperAddress(k);
    if (!st.keypers.some((x) => x.toLowerCase() === addr.toLowerCase())) throw new Error(`keyper #${id} is not a keyper of ${st.label}`);
    const round = numOpt(args, "--round", st.roundA);
    const secret = JSON.parse(readFileSync(resolve(ROOT, k.env.KEYPER_HOME, "chain.secret.json"), "utf8"));
    const seed = seedAt(hexToBytes(secret.top), secret.maxRound, round);
    const rec = await keyperRecord(addr);
    let h = seed;
    for (let r = round; r >= rec.nextRound; r--) h = k256(h);
    if (bytesToHex(h) !== rec.lastHash.toLowerCase()) throw new Error("derived seed does not hash to the on-chain chain head");
    const now = Number((await pub.getBlock()).timestamp);
    const bell = roundTime(rec, round);
    if (now >= bell) throw new Error(`round ${round} has already opened; a seed now is not a leak`);
    say(`keyper #${id} (${addr}) hands its round ${round} seed to the briber, ${Math.round((bell - now) / 60)} min before the bell.`);
    say(`  seed ${bytesToHex(seed)} hashes down to the keyper's on-chain chain head: it is the real seed.`);

    // What the briber can do with it: nothing. One seed is one Shamir share; the paper needs THRESHOLD.
    const c = st.centres[0];
    const sealed: SealedPaper = JSON.parse(readFileSync(resolve(pubDir(st), `sealed/${c.name}-A.json`), "utf8"));
    try {
      await openPaper(sealed, { [addr]: seed }, generateSealKeys());
      throw new Error("UNEXPECTED: the paper opened with one seed");
    } catch (e) {
      say(`  briber tries ${c.name}'s published ciphertext with it: ${(e as Error).message}`);
    }
    mkdirSync(resolve(SECRETS, "bribery"), { recursive: true });
    const file = resolve(SECRETS, "bribery", `leak-k${id}-r${round}.json`);
    writeFileSync(file, JSON.stringify({ examId: st.examId, keyper: addr, round, seed: bytesToHex(seed), handedOverAt: new Date(now * 1000).toISOString(), bell: new Date(bell * 1000).toISOString() }, null, 2), { mode: 0o600 });
    say(`  the seed changes hands off chain: ${file}`);
  },

  /** Anyone who holds an early seed: commit (binds the reward to them), then reveal. The contract slashes. */
  async whistleblow([file]) {
    const st = loadState();
    if (!file || !existsSync(file)) throw new Error("usage: npm run demo -- whistleblow <secrets/demo/bribery/leak-*.json>");
    const leak = JSON.parse(readFileSync(file, "utf8")) as { keyper: Hex; round: number; seed: Hex };
    const w = await loadActor("whistleblower", "watcher");
    const before = await pub.getBalance({ address: w.acc.evm as Hex });
    const bell = Number(await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "roundTime", args: [leak.keyper, leak.round] }));
    const now = Number((await pub.getBlock()).timestamp);
    if (now >= bell) throw new Error("the round has opened; the seed is no longer evidence");
    say(`whistleblower ${w.acc.evm} holds keyper ${leak.keyper}'s round ${leak.round} seed, ${Math.round((bell - now) / 60)} min before that round opens.`);
    const salt = bytesToHex(rand32());
    const commitment = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "reportCommitment", args: [leak.keyper, leak.round, leak.seed, salt, w.acc.evm as Hex] });
    say(`1. commit (hides the seed and binds the reward to this account, so nobody can front-run it)`);
    await sendAs(w, contracts.hourglass, registryAbi, "commitReport", [commitment]);
    say(`2. reveal`);
    const rc = await sendAs(w, contracts.hourglass, registryAbi, "revealReport", [leak.keyper, leak.round, leak.seed, salt]);
    const ev = parseEventLogs({ abi: registryAbi, logs: rc.logs, eventName: "KeyperSlashed" })[0];
    if (!ev) throw new Error("no KeyperSlashed event");
    const after = await pub.getBalance({ address: w.acc.evm as Hex });
    const rec = await keyperRecord(leak.keyper);
    st.txs[`slash:${leak.keyper}`] = rc.transactionHash;
    saveState(st);
    say(`SLASHED: keyper ${leak.keyper} round ${leak.round}. Reward ${formatEther(ev.args.reward)} QOR to the whistleblower; the same amount burned.`);
    say(`  keyper record now: slashed=${rec.slashed}, bond=${formatEther(rec.bond)} QOR. Whistleblower balance ${formatEther(before)} -> ${formatEther(after)} QOR (after gas).`);
  },

  async reveal() {
    const st = loadState();
    const board = await loadActor("board", "board");
    const backup = (await read<number>("activeRound", [st.examId])) === st.roundB;
    const [canon, salt, p] = backup ? [st.canonB, st.saltB, paper("b")] : [st.canonA, st.saltA, paper("a")];
    for (const c of st.centres) {
      const v = makeVariant(p, c.name, hexToBytes(backup ? c.permSeedB : c.permSeedA));
      if (!isFairVariant(p, v)) throw new Error(`${c.name} variant is not fair`);
    }
    const a = [st.examId, canon, salt] as const;
    st.txs.revealFairness = await relay(board, "revealFairness", [...a, await sign(board, await read<Hex>("revealDigest", a))]);
    saveState(st);
    writePublic(st, "reveal.json", {
      canonicalPaper: p, canonicalPaperHash: canon, salt, set: backup ? "B" : "A",
      centres: st.centres.map((c) => ({ name: c.name, evm: c.evm, permSeedA: c.permSeedA, permSeedB: c.permSeedB, permSalt: c.permSalt })),
      check: "keccak(canonicalPaperHash ‖ salt) == paperCommit on chain; keccak(permSeedA ‖ permSeedB ‖ permSalt) == permCommit; makeVariant(canonical, centre, permSeed) reproduces each sealed paper",
    });
    say("fairness revealed: the canonical paper and every centre's order match the commitments made before the exam.");
  },

  async status() {
    const st = loadState();
    const [unlocked, round] = await Promise.all([read<boolean>("isUnlocked", [st.examId]), read<number>("activeRound", [st.examId])]);
    say(`${st.label}  ${st.examId}\nactive round ${round} (${round === st.roundB ? "backup B" : "A"}), unlocks ${round === st.roundB ? st.unlockB : st.unlockA}; unlocked=${unlocked}`);
    for (const k of st.keypers) say(`  keyper ${k}: ${(await chainSeed(k, round)) ? "released" : "pending"}`);
    for (const c of st.centres) {
      const r = await read<readonly [boolean, Hex, Hex, Hex, bigint, number]>("centres", [st.examId, c.evm]);
      say(`  ${c.name.padEnd(18)} opened ${r[4] ? new Date(Number(r[4]) * 1000).toISOString() : "—"}  leak reports ${r[5]}`);
    }
  },
};

const [cmd = "status", ...rest] = process.argv.slice(2);
const fn = commands[cmd];
if (!fn) {
  console.error(`usage: npm run demo -- ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}
fn(rest).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
