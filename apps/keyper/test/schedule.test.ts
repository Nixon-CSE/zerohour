import { test } from "node:test";
import assert from "node:assert/strict";
import { currentRound, plan, releaseGas, roundTime, type KeyperClock } from "../src/schedule.ts";
import { windowProblem } from "../src/native.ts";

const clock: KeyperClock = { genesis: 1_000_000, roundSeconds: 300, maxRound: 100, nextRound: 1 };
const at = (r: number, plus = 0) => roundTime(clock, r) + plus;

test("never releases a round before chain time passes unlock + safety", () => {
  for (const dt of [-300, -1, 0, 1]) {
    const p = plan({ clock, chainTime: at(10, dt), targets: [10], safetySeconds: 2 });
    assert.equal(p.action, "wait", `dt=${dt}`);
  }
  const p = plan({ clock, chainTime: at(10, 2), targets: [10], safetySeconds: 2 });
  assert.deepEqual(p, { action: "release", round: 10, reason: "target", steps: 10 });
});

test("heartbeat never runs ahead of chain time either", () => {
  const p = plan({ clock, chainTime: at(7, 1), targets: [], heartbeatEvery: 1, safetySeconds: 2 });
  assert.equal(p.action, "release");
  assert.equal((p as any).round, 6, "round 7 is 1 s old, inside the safety margin");
  assert.ok(at(6) + 2 <= at(7, 1));
});

test("releases due exam rounds smallest first, skipping already-revealed ones", () => {
  const c = { ...clock, nextRound: 12 };
  const p = plan({ clock: c, chainTime: at(40, 10), targets: [30, 10, 20, 20, 99] });
  assert.deepEqual(p, { action: "release", round: 20, reason: "target", steps: 9 });
});

test("waits with a countdown to the next exam round", () => {
  const p = plan({ clock, chainTime: at(5), targets: [9] });
  assert.deepEqual(p, { action: "wait", nextTarget: 9, secondsUntil: 4 * 300 + 2 });
});

test("ignores targets beyond the chain, reports exhaustion", () => {
  assert.deepEqual(plan({ clock, chainTime: at(500), targets: [101] }), { action: "wait" });
  assert.deepEqual(plan({ clock: { ...clock, nextRound: 101 }, chainTime: at(500), targets: [] }), { action: "done" });
});

test("heartbeat only fires once enough rounds are unrevealed", () => {
  assert.equal(plan({ clock, chainTime: at(3, 5), targets: [], heartbeatEvery: 12 }).action, "wait");
  assert.deepEqual(plan({ clock, chainTime: at(12, 5), targets: [], heartbeatEvery: 12 }), { action: "release", round: 12, reason: "heartbeat", steps: 12 });
});

test("round arithmetic and gas scale with walk length", () => {
  assert.equal(currentRound(clock, clock.genesis - 1), -1);
  assert.equal(currentRound(clock, at(42, 299)), 42);
  assert.equal(currentRound(clock, at(10_000)), 100);
  assert.ok(releaseGas(8640) > releaseGas(1));
});

test("window checks: scope, budget, liveness", () => {
  const w = { found: true, live: true, nativeOnly: false, remainingTxs: 3n, remainingBlocks: 100n, remainingValue: 1_000n, allowedTargets: ["0xAbC"] } as any;
  assert.equal(windowProblem(w, "0xabc", 500n), null);
  assert.match(windowProblem(w, "0xdef", 500n)!, /scoped/);
  assert.match(windowProblem(w, "0xabc", 900n, 200n)!, /budget/);
  assert.match(windowProblem({ ...w, live: false }, "0xabc", 1n)!, /expired/);
  assert.match(windowProblem({ found: false } as any, "0xabc", 1n)!, /no window/);
});
