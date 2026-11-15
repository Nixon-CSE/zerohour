/**
 * Release scheduling — pure, no I/O, fully unit-tested.
 *
 * The one rule a keyper must never break: a round's seed may not leave this machine before
 * CHAIN time has passed that round's unlock time. "Leave" includes eth_call / eth_estimateGas
 * (the RPC operator sees calldata) and a reverted tx (the seed is in the mempool and in the
 * block). Any of those lets a watcher commitReport() and slash the bond.
 *
 * So the gate is the latest block's timestamp, not the local clock: every later block has
 * timestamp >= that, so any report committed after we broadcast is not "early" evidence.
 */

export interface KeyperClock {
  genesis: number; // unix seconds of round 0
  roundSeconds: number;
  maxRound: number;
  nextRound: number; // lowest round not yet revealed on chain
}

export const roundTime = (k: KeyperClock, r: number) => k.genesis + r * k.roundSeconds;

/** Latest round whose time has come at `t` (or -1 before genesis), capped at maxRound. */
export function currentRound(k: KeyperClock, t: number): number {
  if (t < k.genesis) return -1;
  return Math.min(k.maxRound, Math.floor((t - k.genesis) / k.roundSeconds));
}

export interface PlanInput {
  clock: KeyperClock;
  chainTime: number; // timestamp of the latest block
  targets: number[]; // rounds some exam depends on (from ExamCreated where we are a keyper)
  heartbeatEvery?: number; // also release the current round once this many rounds are unrevealed (0 = off)
  safetySeconds?: number; // extra margin after the unlock time (default 2 s)
}

export type Plan =
  | { action: "release"; round: number; reason: "target" | "heartbeat"; steps: number }
  | { action: "wait"; nextTarget?: number; secondsUntil?: number }
  | { action: "done" };

export function plan(p: PlanInput): Plan {
  const { clock, chainTime } = p;
  const safety = p.safetySeconds ?? 2;
  const isDue = (r: number) => roundTime(clock, r) + safety <= chainTime;
  const open = [...new Set(p.targets)].filter((r) => r >= clock.nextRound && r <= clock.maxRound).sort((a, b) => a - b);

  // Smallest due target first: each exam round gets its own seedOf entry and its own event.
  const due = open.find(isDue);
  if (due !== undefined) return { action: "release", round: due, reason: "target", steps: due + 1 - clock.nextRound };

  const hb = p.heartbeatEvery ?? 0;
  if (hb > 0) {
    const cur = currentRound(clock, chainTime - safety);
    if (cur >= clock.nextRound && cur - clock.nextRound + 1 >= hb) {
      return { action: "release", round: cur, reason: "heartbeat", steps: cur + 1 - clock.nextRound };
    }
  }

  if (clock.nextRound > clock.maxRound) return { action: "done" };
  const next = open[0];
  if (next === undefined) return { action: "wait" };
  return { action: "wait", nextTarget: next, secondsUntil: Math.max(0, roundTime(clock, next) + safety - chainTime) };
}

/** Gas limit for release(): base cost + one keccak per walked step, with headroom. */
export const releaseGas = (steps: number) => BigInt(150_000 + 120 * Math.max(1, steps));
