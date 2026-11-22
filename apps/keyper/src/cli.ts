#!/usr/bin/env -S npx tsx
/**
 * zerohour-keyper — run an Hourglass keyper for ZeroHour on QoreChain testnet.
 *
 *   new                 create a fresh keyper account (fund it from the faucet next)
 *   setup               register the ML-DSA-87 key, create the seed chain, post the bond
 *   status              account, window, keyper record, upcoming exam rounds
 *   run                 the daemon: release every exam round the moment it is due
 *     --heartbeat N     also release the current round whenever N rounds are unrevealed
 *     --dry-run         plan and verify, never broadcast
 *   release-now         one-shot: release the current round (e.g. drill-day transaction)
 *   exit | withdraw     leave the registry: request exit, then (after the delay) withdraw the bond
 *   export-pk R [R..]   print round R's ML-KEM-1024 public key + Merkle proof against pkRoot (JSON)
 *
 * Files live in $KEYPER_HOME (default ~/.zerohour-keyper); see src/config.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { weiToUqorCeil } from "@qorechain/evm";
import { mldsa87 } from "@qorechain/pqc";
import { anchorOf, bytesToHex, hexToBytes, k256, merkleLevels, merkleRoot, pkLeaf, proofFromLevels, roundKeypair, seedAt, verifyMerkle } from "@zerohour/hourglass";
import { formatEther, toHex, type Hex } from "viem";
import { contracts, net_, paths, tuning } from "./config.ts";
import { run, type ChainSecret } from "./daemon.ts";
import { createAccountFile, ensurePqcKey, loadAccount, openWindow, windowProblem, windowStatus } from "./native.ts";
import { fees, keyperRecord, pub, registryAbi, wallet } from "./registry.ts";
import { currentRound, roundTime } from "./schedule.ts";

const flag = (args: string[], name: string) => args.includes(name);
const opt = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** The seed chain: $KEYPER_CHAIN_SECRET (JSON, for containers) or the chain.secret.json file. */
function loadSecret(): ChainSecret {
  const fromEnv = process.env.KEYPER_CHAIN_SECRET?.trim();
  const s = fromEnv ? JSON.parse(fromEnv) : existsSync(paths.chain) ? JSON.parse(readFileSync(paths.chain, "utf8")) : null;
  if (!s) throw new Error(`no seed chain at ${paths.chain} — run: zerohour-keyper setup`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(s.top) || ![s.maxRound, s.genesis, s.roundSeconds].every(Number.isInteger)) {
    throw new Error("seed chain secret must be {top: 0x…32 bytes, maxRound, genesis, roundSeconds}");
  }
  return s;
}

/** keccak256(pk_r) for every round — public; cached in $KEYPER_HOME so proofs are instant. */
function pkLeaves(secret: ChainSecret): Uint8Array[] {
  if (existsSync(paths.leaves)) {
    const c = JSON.parse(readFileSync(paths.leaves, "utf8"));
    if (c.top === bytesToHex(k256(hexToBytes(secret.top))) && c.leaves.length === secret.maxRound + 1) return c.leaves.map(hexToBytes);
  }
  console.error(`deriving ${secret.maxRound + 1} ML-KEM-1024 round keys (one-time, ~1 min)…`);
  const leaves: Uint8Array[] = new Array(secret.maxRound + 1);
  let s = hexToBytes(secret.top);
  for (let r = secret.maxRound; r >= 0; r--) {
    leaves[r] = pkLeaf(roundKeypair(s).publicKey);
    s = k256(s); // seed[r-1] = keccak256(seed[r])
  }
  mkdirSync(dirname(paths.leaves), { recursive: true });
  // `top` here is keccak(top): identifies the chain without revealing anything usable
  writeFileSync(paths.leaves, JSON.stringify({ top: bytesToHex(k256(hexToBytes(secret.top))), leaves: leaves.map(bytesToHex) }));
  return leaves;
}

/** Commitments for a seed chain: anchor + Merkle root over all round ML-KEM-1024 public keys. */
function commitments(secret: ChainSecret): { anchor: Hex; pkRoot: Hex } {
  const leaves = pkLeaves(secret);
  return { anchor: bytesToHex(anchorOf(hexToBytes(secret.top), secret.maxRound)), pkRoot: bytesToHex(merkleRoot(leaves)) };
}

/** Load the seed chain, or create one: a single 32-byte secret; everything else is derived. */
function loadOrCreateChain(): ChainSecret {
  if (existsSync(paths.chain)) return loadSecret();
  const top = crypto.getRandomValues(new Uint8Array(32));
  const genesis = tuning.genesis ?? Math.ceil(Date.now() / 1000 / tuning.roundSeconds) * tuning.roundSeconds;
  const secret = { top: toHex(top), maxRound: tuning.maxRound, genesis, roundSeconds: tuning.roundSeconds };
  mkdirSync(dirname(paths.chain), { recursive: true });
  writeFileSync(paths.chain, JSON.stringify(secret, null, 2), { mode: 0o600 });
  return secret;
}

const commands: Record<string, (a: string[]) => Promise<void>> = {
  async new() {
    const acc = await createAccountFile();
    console.log(`keyper account created -> ${paths.account} (keep it secret, keep it safe)`);
    console.log(`  native ${acc.cosmos}\n  evm    ${acc.evm}`);
    console.log(`next: fund ${acc.cosmos} at https://dashboard.qorechain.io/faucet, then: zerohour-keyper setup`);
  },

  async setup() {
    const acc = await loadAccount();
    const me = acc.evm as Hex;
    const pq = await ensurePqcKey(acc);
    console.log(pq ? `registered ML-DSA-87 key: ${pq}` : "ML-DSA-87 key already registered");

    const rec = await keyperRecord(me);
    if (rec.registered) return console.log("already a registered keyper — nothing more to do. Next: zerohour-keyper run");

    const secret = loadOrCreateChain();
    const { anchor, pkRoot } = commitments(secret);
    writeFileSync(paths.public, JSON.stringify({ keyper: me, registry: contracts.hourglass, anchor, pkRoot, genesis: secret.genesis, roundSeconds: secret.roundSeconds, maxRound: secret.maxRound }, null, 2));

    const bond = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "minBond" });
    const value = tuning.bondWei > bond ? tuning.bondWei : bond;
    const args = [me, anchor, pkRoot, BigInt(secret.genesis), secret.roundSeconds, secret.maxRound] as const;
    const digest = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "registerDigest", args });
    const sig = mldsa87.sign(acc.pqc.secretKey, hexToBytes(digest));

    // registration carries no secret (anchor and pkRoot are public), so estimating is safe
    const gas = ((await pub.estimateContractGas({ address: contracts.hourglass, abi: registryAbi, functionName: "register", args: [...args, toHex(sig)], value, account: me })) * 13n) / 10n;
    const fee = await fees();
    const cost = weiToUqorCeil(gas * fee.maxFeePerGas);
    const bondUqor = weiToUqorCeil(value);
    if (windowProblem(await windowStatus(acc), contracts.hourglass, cost, bondUqor)) {
      console.log(`window: ${await openWindow(acc, [contracts.hourglass], cost, bondUqor)}`);
    }
    const hash = await wallet(acc.privateKey as Hex).writeContract({ address: contracts.hourglass, abi: registryAbi, functionName: "register", args: [...args, toHex(sig)], value, gas, ...fee });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`register (bond ${formatEther(value)} QOR, ML-DSA-87 signed): ${hash} -> ${rc.status}`);
    console.log(`genesis ${new Date(secret.genesis * 1000).toISOString()}, ${secret.roundSeconds}s rounds. Next: zerohour-keyper run`);
  },

  async status() {
    const acc = await loadAccount();
    const me = acc.evm as Hex;
    const [rec, w, bal, head] = await Promise.all([keyperRecord(me), windowStatus(acc), pub.getBalance({ address: me }), pub.getBlock()]);
    console.log(`keyper   ${me}  (${acc.cosmos})`);
    console.log(`balance  ${formatEther(bal)} QOR`);
    console.log(`window   ${!w.found ? "none" : `${w.live ? "live" : "dead"}; ${w.remainingTxs} txs, ${w.remainingBlocks} blocks, scope ${w.allowedTargets.join(",") || "any"}`}`);
    console.log(`registry ${contracts.hourglass}  (${net_.chainId})`);
    if (!rec.registered) return console.log("not registered — run: zerohour-keyper setup");
    const t = Number(head.timestamp);
    console.log(`record   bond ${formatEther(rec.bond)} QOR, slashed=${rec.slashed}, nextRound ${rec.nextRound}/${rec.maxRound}`);
    console.log(`clock    round ${currentRound(rec, t)} now; round ${rec.nextRound} unlocks ${new Date(roundTime(rec, rec.nextRound) * 1000).toISOString()}`);
  },

  async run(args) {
    const hb = opt(args, "--heartbeat");
    await run(await loadAccount(), loadSecret(), { dryRun: flag(args, "--dry-run"), once: flag(args, "--once"), heartbeatEvery: hb ? Number(hb) : tuning.heartbeatEvery });
  },

  /** Publish round public keys so a board can seal to them. Refuses rounds already revealed. */
  async "export-pk"(args) {
    const acc = await loadAccount();
    const secret = loadSecret();
    const rec = await keyperRecord(acc.evm as Hex);
    if (!rec.registered) throw new Error("not registered");
    const leaves = pkLeaves(secret);
    const levels = merkleLevels(leaves); // built once; every proof is then a few lookups
    const root = levels[levels.length - 1][0];
    if (bytesToHex(root).toLowerCase() !== rec.pkRoot.toLowerCase()) throw new Error("local pk leaves do not match on-chain pkRoot");
    // --hours N: every round of the next N hours (to publish for boards); otherwise explicit rounds
    const hours = args.includes("--hours") ? Number(args[args.indexOf("--hours") + 1]) : 0;
    const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
    let rounds: number[];
    if (hours > 0) {
      const now = Math.floor(Date.now() / 1000);
      const first = Math.max(rec.nextRound, Math.floor((now - rec.genesis) / rec.roundSeconds) + 1);
      const last = Math.min(secret.maxRound, first + Math.ceil((hours * 3600) / rec.roundSeconds));
      rounds = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    } else rounds = args.filter((a) => /^\d+$/.test(a)).map(Number);
    if (!rounds.length || rounds.some((r) => !Number.isInteger(r) || r < 0 || r > secret.maxRound)) throw new Error("usage: export-pk <round> [round…] | export-pk --hours N [--out file.json]");
    // One walk down the chain: seed[r-1] = keccak(seed[r]), so start at the highest round and step down
    // (rebuilding each seed from the top would cost maxRound hashes per round).
    const sorted = [...new Set(rounds)].sort((x, y) => y - x);
    const seeds = new Map<number, Uint8Array>();
    let cur = seedAt(hexToBytes(secret.top), secret.maxRound, sorted[0]);
    let at = sorted[0];
    for (const r of sorted) {
      while (at > r) { cur = k256(cur); at--; }
      seeds.set(r, cur);
    }
    const keys = rounds.map((round) => {
      if (round < rec.nextRound) throw new Error(`round ${round} is already revealed — sealing to it would be pointless`);
      const publicKey = roundKeypair(seeds.get(round)!).publicKey;
      const proof = proofFromLevels(levels, round);
      if (!verifyMerkle(pkLeaf(publicKey), round, proof, root)) throw new Error("self-check failed");
      return { round, publicKey: bytesToHex(publicKey), proof: proof.map(bytesToHex) };
    });
    const json = JSON.stringify({ keyper: acc.evm, registry: contracts.hourglass, pkRoot: rec.pkRoot, genesis: rec.genesis, roundSeconds: rec.roundSeconds, keys });
    if (outFile) {
      writeFileSync(outFile, json);
      console.error(`wrote ${keys.length} round public keys (rounds ${keys[0].round}-${keys[keys.length - 1].round}) with Merkle proofs to ${outFile}. Public data: send it to the exam board.`);
    } else console.log(json);
  },

  /** Start leaving: ML-DSA-87 signed; the bond unlocks after the registry's exit delay. */
  async exit() {
    const acc = await loadAccount();
    const me = acc.evm as Hex;
    const digest = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "exitDigest", args: [me] });
    const sig = toHex(mldsa87.sign(acc.pqc.secretKey, hexToBytes(digest)));
    console.log(`requestExit on ${contracts.hourglass}: ${await sendPq(acc, "requestExit", [me, sig])}`);
  },

  /** Withdraw the bond to this account (the recipient is bound inside the ML-DSA-87 signature). */
  async withdraw() {
    const acc = await loadAccount();
    const me = acc.evm as Hex;
    const digest = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "withdrawDigest", args: [me, me] });
    const sig = toHex(mldsa87.sign(acc.pqc.secretKey, hexToBytes(digest)));
    console.log(`withdraw from ${contracts.hourglass}: ${await sendPq(acc, "withdraw", [me, me, sig])}`);
  },

  async "release-now"(args) {
    await run(await loadAccount(), loadSecret(), { once: true, heartbeatEvery: 1, dryRun: flag(args, "--dry-run") });
  },
};

/** Relay an ML-DSA-authorised registry call from this account through a registry-scoped window. */
async function sendPq(acc: Awaited<ReturnType<typeof loadAccount>>, functionName: "requestExit" | "withdraw", args: readonly unknown[]) {
  const me = acc.evm as Hex;
  const gas = ((await pub.estimateContractGas({ address: contracts.hourglass, abi: registryAbi, functionName, args: args as any, account: me })) * 13n) / 10n;
  const fee = await fees();
  const cost = weiToUqorCeil(gas * fee.maxFeePerGas);
  if (windowProblem(await windowStatus(acc), contracts.hourglass, cost)) console.log(`window: ${await openWindow(acc, [contracts.hourglass], cost)}`);
  const hash = await wallet(acc.privateKey as Hex).writeContract({ address: contracts.hourglass, abi: registryAbi, functionName, args: args as any, gas, ...fee });
  const rc = await pub.waitForTransactionReceipt({ hash });
  return `${hash} -> ${rc.status}`;
}

const [cmd = "status", ...rest] = process.argv.slice(2);
const fn = commands[cmd];
if (!fn) {
  console.error(`usage: zerohour-keyper ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}
fn(rest).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
