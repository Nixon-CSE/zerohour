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
 *
 * Files live in $KEYPER_HOME (default ~/.zerohour-keyper); see src/config.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { weiToUqorCeil } from "@qorechain/evm";
import { mldsa87 } from "@qorechain/pqc";
import { bytesToHex, hexToBytes, k256, merkleRoot, pkLeaf, roundKeypair } from "@zerohour/hourglass";
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

function loadSecret(): ChainSecret {
  if (!existsSync(paths.chain)) throw new Error(`no seed chain at ${paths.chain} — run: zerohour-keyper setup`);
  return JSON.parse(readFileSync(paths.chain, "utf8"));
}

/** Commitments for a seed chain: anchor + Merkle root over all round ML-KEM-1024 public keys. */
function commitments(top: Uint8Array, maxRound: number): { anchor: Hex; pkRoot: Hex } {
  console.log(`deriving ${maxRound + 1} ML-KEM-1024 round keys (one-time, ~1 min)…`);
  const leaves: Uint8Array[] = new Array(maxRound + 1);
  let s = top;
  for (let r = maxRound; r >= 0; r--) {
    leaves[r] = pkLeaf(roundKeypair(s).publicKey);
    s = k256(s); // seed[r-1] = keccak256(seed[r])
  }
  return { anchor: bytesToHex(k256(s)), pkRoot: bytesToHex(merkleRoot(leaves)) };
}

/** Load the seed chain, or create one: a single 32-byte secret; everything else is derived. */
function loadOrCreateChain(): ChainSecret {
  if (existsSync(paths.chain)) return loadSecret();
  const top = crypto.getRandomValues(new Uint8Array(32));
  const genesis = Math.ceil(Date.now() / 1000 / tuning.roundSeconds) * tuning.roundSeconds;
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
    const { anchor, pkRoot } = commitments(hexToBytes(secret.top), secret.maxRound);
    writeFileSync(paths.public, JSON.stringify({ keyper: me, registry: contracts.hourglass, anchor, pkRoot, genesis: secret.genesis, roundSeconds: secret.roundSeconds, maxRound: secret.maxRound }, null, 2));

    const bond = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "minBond" });
    const value = tuning.bondWei > bond ? tuning.bondWei : bond;
    const args = [me, anchor, pkRoot, BigInt(secret.genesis), secret.roundSeconds, secret.maxRound] as const;
    const digest = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "registerDigest", args });
    const sig = mldsa87.sign(acc.pqc.secretKey, hexToBytes(digest));

    const gas = 1_500_000n;
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

  async "release-now"(args) {
    await run(await loadAccount(), loadSecret(), { once: true, heartbeatEvery: 1, dryRun: flag(args, "--dry-run") });
  },
};

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
