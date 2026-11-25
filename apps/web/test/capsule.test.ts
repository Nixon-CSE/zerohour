import { test } from "node:test";
import assert from "node:assert/strict";
import { bech32ToEvm, checkCapsule, type BeaconIndex, type Capsule } from "../src/lib/capsule.ts";

// The judges' centre, as published in deployments/demo/judge-centre.json.
const JUDGES_QOR = "qor1gt92tqr0qjm6u5w06js2ldxupzh2pgcruskwqj";
const JUDGES_EVM = "0x42caa5806f04b7ae51cfd4a0afb4dc08aea0a303";

test("bech32ToEvm: the judges' qor1 address is the same account as its 0x address", () => {
  assert.equal(bech32ToEvm(JUDGES_QOR).toLowerCase(), JUDGES_EVM);
  assert.equal(bech32ToEvm(JUDGES_QOR.toUpperCase()).toLowerCase(), JUDGES_EVM);
});

test("bech32ToEvm: refuses typos, wrong prefix, bad characters and mixed case instead of misreading them", () => {
  const typo = JUDGES_QOR.slice(0, 10) + (JUDGES_QOR[10] === "q" ? "p" : "q") + JUDGES_QOR.slice(11);
  assert.throws(() => bech32ToEvm(typo), /checksum/);
  assert.throws(() => bech32ToEvm(JUDGES_QOR.replace("qor1", "cosmos1")), /qor1/);
  assert.throws(() => bech32ToEvm(JUDGES_QOR.slice(0, -1) + "b"), /invalid bech32 character|checksum/);
  assert.throws(() => bech32ToEvm("Qor1" + JUDGES_QOR.slice(4)), /mixed-case/);
});

const K = ["0x104C6d4f856f0e3CbC5c92474BF18AE19b882bc1", "0x17aB3569aF1136D8CF22Ccc83b22ec73a4FE5BbA", "0x2E547cA9A3b7697b1fF8833c0D59D922dBCdab06"] as const;
const idx: BeaconIndex = {
  v: 1, chainId: "qorechain-diana", registry: "0xAF59A5e81c0F5D85ec79f3fE6F33Bd8A923fD834", genesis: 1_795_179_900, roundSeconds: 300, every: 3, threshold: 2,
  keypers: K.map((address, i) => ({ id: i + 1, address, pkRoot: "0x00" })), days: [], recipients: ["centre-judges"],
};
const round = 1377;
const good: Capsule = {
  v: 1, kind: "zerohour-capsule", chainId: idx.chainId, registry: idx.registry, round, at: new Date((idx.genesis + round * 300) * 1000).toISOString(),
  threshold: 2, keypers: [...K], recipient: { name: "centre-judges", label: "Judges' centre", address: JUDGES_QOR },
  sealed: { v: 1, chainId: idx.chainId, round, threshold: 2, shares: K.map((keyper) => ({ keyper, kemCt: "0x", iv: "0x", ct: "0x" })), recipient: "0x", iv: "0x", ct: "0x" },
  createdAt: "2026-11-25T07:42:34.940Z",
};

test("checkCapsule: a genuine capsule is accepted", () => {
  assert.equal(checkCapsule(good, idx), null);
});

test("checkCapsule: forged capsules are refused, each with its reason", () => {
  const later = { ...good, round: round + 3, at: new Date((idx.genesis + (round + 3) * 300) * 1000).toISOString() };
  assert.match(checkCapsule(later, idx)!, /does not match what is sealed/); // a later bell on the label, the old round inside
  assert.match(checkCapsule({ ...good, registry: "0x000000000000000000000000000000000000dEaD" }, idx)!, /different keyper registry/);
  assert.match(checkCapsule({ ...good, at: "2026-11-25T06:50:00.000Z" }, idx)!, /bell time does not match/);
  assert.match(checkCapsule({ ...good, keypers: [K[0], K[1], "0x000000000000000000000000000000000000bEEF"] }, idx)!, /not ZeroHour's/);
  assert.match(checkCapsule({ ...good, keypers: [K[0], K[1]] }, idx)!, /does not match the sealed shares/);
  assert.match(checkCapsule({ ...good, sealed: { ...good.sealed, threshold: 1 } }, idx)!, /does not match what is sealed/);
  assert.match(checkCapsule({ hello: "world" } as unknown as Capsule, idx)!, /not a ZeroHour capsule/);
});
