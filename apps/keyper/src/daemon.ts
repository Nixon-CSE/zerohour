/**
 * The keyper loop. Each tick:
 *   1. read the latest block (height, timestamp) and our on-chain keyper record
 *   2. pick up new ExamCreated events that list us as a keyper (cursor persisted in state.json)
 *   3. plan(): release the smallest exam round whose time has passed, or a heartbeat round
 *   4. re-check chain time, verify the seed against our on-chain lastHash locally, make sure an
 *      EVM window scoped to the registry can carry the tx, then broadcast release()
 *
 * Invariant: the seed for round r is computed, checked and sent only after the latest block's
 * timestamp is >= roundTime(r) + safety. Nothing touches the RPC with a seed before that.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { weiToUqorCeil } from "@qorechain/evm";
import type { UnifiedAccount } from "@qorechain/sdk";
import { anchorOf, bytesToHex, hexToBytes, k256, seedAt } from "@zerohour/hourglass";
import type { Hex } from "viem";
import { contracts, paths, tuning } from "./config.ts";
import { openWindow, windowProblem, windowStatus } from "./native.ts";
import { chainTime, fees, keyperRecord, scanExamTargets, sendRelease, type ExamTarget } from "./registry.ts";
import { plan, releaseGas, roundTime } from "./schedule.ts";

export interface ChainSecret {
  top: string;
  maxRound: number;
  genesis: number;
  roundSeconds: number;
}

interface State {
  examCursor: string; // next block to scan
  targets: ExamTarget[];
}

const log = (event: string, data: Record<string, unknown> = {}) => {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(line);
  try {
    mkdirSync(dirname(paths.log), { recursive: true });
    appendFileSync(paths.log, line + "\n");
  } catch {}
};

function loadState(): State {
  if (!existsSync(paths.state)) return { examCursor: contracts.examFromBlock.toString(), targets: [] };
  const s = JSON.parse(readFileSync(paths.state, "utf8"));
  return { examCursor: s.examCursor ?? "0", targets: (s.targets ?? []).map((t: any) => ({ ...t, block: BigInt(t.block) })) };
}
function saveState(s: State) {
  mkdirSync(dirname(paths.state), { recursive: true });
  writeFileSync(paths.state, JSON.stringify(s, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

/** Refuse to run if our local secret is not the chain the registry holds. */
export function assertSecretMatches(secret: ChainSecret, rec: Awaited<ReturnType<typeof keyperRecord>>) {
  if (!rec.registered) throw new Error("this account is not a registered keyper — run: zerohour-keyper register");
  if (rec.slashed) throw new Error("this keyper has been SLASHED — a seed was revealed early. Stop and investigate.");
  const anchor = bytesToHex(anchorOf(hexToBytes(secret.top), secret.maxRound));
  const mismatch: string[] = [];
  if (anchor.toLowerCase() !== rec.anchor.toLowerCase()) mismatch.push("anchor");
  if (secret.genesis !== rec.genesis) mismatch.push("genesis");
  if (secret.roundSeconds !== rec.roundSeconds) mismatch.push("roundSeconds");
  if (secret.maxRound !== rec.maxRound) mismatch.push("maxRound");
  if (mismatch.length) throw new Error(`local seed chain does not match the registry (${mismatch.join(", ")}) — refusing to release`);
}

export interface RunOptions {
  once?: boolean;
  dryRun?: boolean;
  heartbeatEvery?: number;
  extraTargets?: number[];
}

export async function run(acc: UnifiedAccount, secret: ChainSecret, opts: RunOptions = {}) {
  const me = acc.evm as Hex;
  const top = hexToBytes(secret.top);
  const state = loadState();
  assertSecretMatches(secret, await keyperRecord(me));
  log("start", { keyper: me, registry: contracts.hourglass, exam: contracts.exam, dryRun: !!opts.dryRun, heartbeatEvery: opts.heartbeatEvery ?? 0 });

  let stop = false;
  process.once("SIGINT", () => ((stop = true), log("stopping")));
  let backoff = tuning.pollMs;

  while (!stop) {
    try {
      const head = await chainTime();
      const skew = Math.floor(Date.now() / 1000) - head.time;
      if (Math.abs(skew) > 60) log("clock-skew", { localMinusChain: skew, note: "chain time is authoritative" });

      const rec = await keyperRecord(me);
      if (rec.slashed) {
        log("slashed", { note: "a seed of ours was proven early on chain — stopping for good" });
        process.exitCode = 2;
        return;
      }

      const from = BigInt(state.examCursor);
      if (from <= head.height) {
        const found = await scanExamTargets(me, from, head.height);
        for (const t of found) log("exam-target", { examId: t.examId, set: t.set, round: t.round, at: new Date(roundTime(rec, t.round) * 1000).toISOString() });
        state.targets.push(...found);
        state.examCursor = (head.height + 1n).toString();
        saveState(state);
      }

      const p = plan({
        clock: { genesis: rec.genesis, roundSeconds: rec.roundSeconds, maxRound: rec.maxRound, nextRound: rec.nextRound },
        chainTime: head.time,
        targets: [...state.targets.map((t) => t.round), ...(opts.extraTargets ?? [])],
        heartbeatEvery: opts.heartbeatEvery,
        safetySeconds: tuning.safetySeconds,
      });

      if (p.action === "done") {
        log("chain-exhausted", { nextRound: rec.nextRound, maxRound: rec.maxRound });
        return;
      }
      if (p.action === "wait") {
        if (opts.once) {
          log("nothing-due", { nextRound: rec.nextRound, nextTarget: p.nextTarget, secondsUntil: p.secondsUntil });
          return;
        }
      } else {
        // second gate, on a fresh block, right before the seed is derived
        const now = await chainTime();
        if (roundTime(rec, p.round) + tuning.safetySeconds > now.time) throw new Error(`gate: round ${p.round} not yet due on chain`);

        const seed = seedAt(top, secret.maxRound, p.round);
        let h = seed;
        for (let i = 0; i < p.steps; i++) h = k256(h);
        if (bytesToHex(h).toLowerCase() !== rec.lastHash.toLowerCase()) throw new Error(`seed for round ${p.round} does not hash to on-chain lastHash`);

        const gas = releaseGas(p.steps);
        const fee = await fees();
        const cost = weiToUqorCeil(gas * fee.maxFeePerGas);
        if (opts.dryRun) {
          log("dry-run", { round: p.round, reason: p.reason, steps: p.steps, gas, costUqor: cost });
          return;
        }

        const w = await windowStatus(acc);
        const why = windowProblem(w, contracts.hourglass, cost);
        if (why) {
          const perTx = weiToUqorCeil(tuning.windowGasPerTx * fee.maxFeePerGas);
          const tx = await openWindow(acc, [contracts.hourglass], perTx > cost ? perTx : cost);
          log("window-opened", { reason: why, tx, scope: contracts.hourglass, txs: tuning.windowTxs, blocks: tuning.windowBlocks });
        }

        const r = await sendRelease(acc.privateKey as Hex, me, p.round, seed, gas, fee);
        log("released", { round: p.round, reason: p.reason, steps: p.steps, tx: r.hash, status: r.status, block: r.block, gasUsed: r.gasUsed });
        if (r.status !== "success") throw new Error(`release tx reverted: ${r.hash}`);
        backoff = tuning.pollMs;
        if (opts.once) return;
        continue; // more may be due
      }
      backoff = tuning.pollMs;
    } catch (e) {
      log("error", { message: e instanceof Error ? e.message : String(e) });
      if (opts.once) throw e;
      backoff = Math.min(backoff * 2, 60_000);
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
}
