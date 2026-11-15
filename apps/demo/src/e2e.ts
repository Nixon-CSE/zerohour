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
  bytesToHex, hexToBytes, isFairVariant, k256, makeVariant, merkleRoot, openPaper, pkLeaf, sealPaper, sealedHash, traceLeak, verifyMerkle,
  type Observation, type Paper, type SealedPaper,
} from "@zerohour/hourglass";
import { contracts, net_ } from "@zerohour/keyper/src/config.ts";
import { openWindow, windowProblem, windowStatus } from "@zerohour/keyper/src/native.ts";
import { fees, keyperRecord, pub, wallet } from "@zerohour/keyper/src/registry.ts";
import { currentRound, roundTime } from "@zerohour/keyper/src/schedule.ts";
import { parseAbi, toHex, type Hex } from "viem";
import { ACTORS, PUBLIC, ROOT, SECRETS, loadActor, setupActor, topUp, type Actor } from "./actors.ts";

const examAbi = parseAbi([
  "function createDigest(bytes32,address,address,address[],uint8,uint32,uint32,bytes32,bytes32,bytes32) view returns (bytes32)",
  "function createExam(bytes32,address,address,address[],uint8,uint32,uint32,bytes32,bytes32,bytes32,bytes)",
  "function centreDigest(bytes32,address,bytes32,bytes32,bytes32) view returns (bytes32)",
  "function addCentre(bytes32,address,bytes32,bytes32,bytes32,bytes)",
  "function openDigest(bytes32,address,bool) view returns (bytes32)",
  "function recordOpening(bytes32,address,bytes)",
  "function leakDigest(bytes32,address,bytes32,uint16,bytes32) view returns (bytes32)",
  "function reportLeak(bytes32,address,bytes32,uint16,bytes32,bytes)",
  "function revealDigest(bytes32,bytes32,bytes32) view returns (bytes32)",
  "function revealFairness(bytes32,bytes32,bytes32,bytes)",
  "function isUnlocked(bytes32) view returns (bool)",
  "function activeRound(bytes32) view returns (uint32)",
  "function centres(bytes32,address) view returns (bool registered, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit, uint64 openedAt, uint32 leakReports)",
]);
const registryAbi = parseAbi(["function seedOf(address,uint32) view returns (bytes32)"]);

const EXAM = contracts.exam;
const KEYPER_CLI = resolve(ROOT, "apps/keyper/src/cli.ts");
const STATE = resolve(SECRETS, "exam.json");
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
const KEYPERS = [
  { id: 1, env: { KEYPER_HOME: "secrets/keyper1-home", KEYPER_ACCOUNT: "secrets/drill.secret.json", KEYPER_CHAIN: "secrets/keyper1.secret.json" } },
  { id: 2, env: { KEYPER_HOME: "secrets/keyper2-home" } },
  { id: 3, env: { KEYPER_HOME: "secrets/keyper3-home" } },
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
    const board = await loadActor("board", "board");
    const hunter = await loadActor("leak-hunter", "hunter");
    const centres = await Promise.all(ACTORS.filter((a) => a.role === "centre").map((a) => loadActor(a.name, "centre")));

    // 1. keypers: same clock, round keys verified against each keyper's on-chain pkRoot
    const keypers = await Promise.all(KEYPERS.map(keyperAddress));
    const recs = await Promise.all(keypers.map(keyperRecord));
    recs.forEach((r, i) => {
      if (!r.registered || r.slashed) throw new Error(`keyper #${i + 1} not usable`);
      if (r.genesis !== recs[0].genesis || r.roundSeconds !== recs[0].roundSeconds) throw new Error(`keyper #${i + 1} is on a different clock`);
    });
    const head = await pub.getBlock();
    const roundA = currentRound(recs[0], Number(head.timestamp)) + Math.max(2, Math.ceil((minutes * 60) / recs[0].roundSeconds));
    const roundB = roundA + 2;
    say(`exam rounds: A=${roundA} (${new Date(roundTime(recs[0], roundA) * 1000).toISOString()}), B=${roundB} (${new Date(roundTime(recs[0], roundB) * 1000).toISOString()})`);

    const roundKeys: Record<number, { keyper: string; publicKey: Uint8Array }[]> = { [roundA]: [], [roundB]: [] };
    for (const [i, k] of KEYPERS.entries()) {
      const out = JSON.parse(keyperCli(k, ["export-pk", String(roundA), String(roundB)]).trim().split("\n").pop()!);
      for (const key of out.keys) {
        const pk = hexToBytes(key.publicKey);
        if (!verifyMerkle(pkLeaf(pk), key.round, key.proof.map(hexToBytes), hexToBytes(recs[i].pkRoot))) throw new Error(`keyper #${k.id}: bad Merkle proof for round ${key.round}`);
        roundKeys[key.round].push({ keyper: keypers[i], publicKey: pk });
      }
      say(`keyper #${k.id} ${keypers[i]}: round keys ${roundA}/${roundB} verified against on-chain pkRoot`);
    }

    // 2. centres: recipient = on-chain ML-KEM key + hybrid-signed card, verified
    const recipients = await Promise.all(
      centres.map(async (c) => {
        const card: RecipientCard = JSON.parse(readFileSync(resolve(PUBLIC, "cards", `${c.name}.card.json`), "utf8"));
        return resolveRecipient({ rest: net_.rest, chainId: net_.chainId, address: c.acc.cosmos, card });
      }),
    );

    // 3. per-centre variants, sealed with both locks
    const label = `ZEROHOUR-DEMO-${new Date().toISOString().slice(0, 16)}`;
    const examId = bytesToHex(k256(enc.encode(label)));
    const [pA, pB] = [paper("a"), paper("b")];
    const st: ExamState = {
      examId, label, roundA, roundB,
      unlockA: new Date(roundTime(recs[0], roundA) * 1000).toISOString(),
      unlockB: new Date(roundTime(recs[0], roundB) * 1000).toISOString(),
      keypers, threshold: THRESHOLD, saltA: bytesToHex(rand32()), saltB: bytesToHex(rand32()), canonA: canonHash(pA), canonB: canonHash(pB),
      centres: [], txs: {},
    };
    for (const [i, c] of centres.entries()) {
      const permSeedA = rand32(), permSeedB = rand32(), permSalt = rand32();
      const sealSet = (p: Paper, seed: Uint8Array, round: number) =>
        sealPaper({ plaintext: enc.encode(JSON.stringify(makeVariant(p, c.name, seed).paper)), chainId: net_.chainId, round, threshold: THRESHOLD, keypers: roundKeys[round], recipient: recipients[i] });
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
    const cArgs = [examId, board.acc.evm, hunter.acc.evm, keypers, THRESHOLD, roundA, roundB, commitA, commitB, manifestRoot] as const;
    st.txs.createExam = await relay(board, "createExam", [...cArgs, await sign(board, await read<Hex>("createDigest", cArgs))]);
    for (const c of st.centres) {
      const permCommit = bytesToHex(k256(cat(hexToBytes(c.permSeedA), hexToBytes(c.permSeedB), hexToBytes(c.permSalt))));
      const a = [examId, c.evm, c.ctHashA, c.ctHashB, permCommit] as const;
      st.txs[`addCentre:${c.name}`] = await relay(board, "addCentre", [...a, await sign(board, await read<Hex>("centreDigest", a))]);
    }
    saveState(st);
    writePublic(st, "manifest.json", {
      exam: label, examId, contract: EXAM, hourglass: contracts.hourglass, chain: net_.chainId,
      roundA, roundB, unlockA: st.unlockA, unlockB: st.unlockB, threshold: THRESHOLD, keypers,
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

    if (onchain[4] === 0n) {
      const d = await read<Hex>("openDigest", [st.examId, c.evm, set === "B"]);
      st.txs[`recordOpening:${c.name}`] = await relay(board, "recordOpening", [st.examId, c.evm, await sign(centre, d)]);
      saveState(st);
    } else say(`receipt already on chain (openedAt ${new Date(Number(onchain[4]) * 1000).toISOString()})`);
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
    const evidenceBytes = enc.encode(JSON.stringify(evidence));
    const evidenceHash = bytesToHex(k256(evidenceBytes));
    const envelope = qsSeal({ chainId: net_.chainId, purpose: "zerohour-leak-evidence-v1", recipients: [recipientOf(board.seal)], plaintext: evidenceBytes });
    const sealedRef = bytesToHex(k256(envelope));
    writePublic(st, `leak-${evidenceHash.slice(0, 10)}.sealed.json`, { evidenceHash, sealedEvidenceRef: sealedRef, envelope: bytesToHex(envelope), sealedTo: "board (QoreSeal)" });
    const bps = Math.min(10_000, Math.floor(top.posterior * 10_000));
    const a = [st.examId, accused.evm, evidenceHash, bps, sealedRef] as const;
    st.txs[`reportLeak:${accused.name}`] = await relay(board, "reportLeak", [...a, await sign(hunter, await read<Hex>("leakDigest", a))]);
    saveState(st);
    say(`Leak Hunter (ML-DSA-87) attributed the leak to ${accused.name} at ${(bps / 100).toFixed(2)}%; evidence sealed to the board.`);
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
    say("fairness revealed: every centre's variant is provably a reordering of the same paper.");
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
