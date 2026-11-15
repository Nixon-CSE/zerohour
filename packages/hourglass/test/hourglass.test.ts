import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";
import {
  anchorOf, merkleProof, merkleRoot, pkLeaf, roundKeypair, seedAt, verifyMerkle, verifySeed,
  openPaper, sealPaper, sealedHash,
  makeVariant, traceLeak, isFairVariant, type Paper, type Observation,
} from "../src/index.ts";

const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

// ---------------------------------------------------------------- chain
test("seed chain: released seeds verify against the anchor; later seeds stay hidden", () => {
  const top = rand(32);
  const N = 50;
  const anchor = anchorOf(top, N);
  for (const r of [0, 7, 49, 50]) assert.ok(verifySeed(seedAt(top, N, r), r, anchor));
  assert.ok(!verifySeed(seedAt(top, N, 8), 7, anchor), "seed of round 8 must not pass as round 7");
  assert.ok(!verifySeed(rand(32), 7, anchor));
});

test("round public keys commit to a Merkle root with verifiable proofs", () => {
  const top = rand(32);
  const N = 12;
  const leaves = Array.from({ length: N + 1 }, (_, r) => pkLeaf(roundKeypair(seedAt(top, N, r)).publicKey));
  const root = merkleRoot(leaves);
  for (const i of [0, 5, 12]) assert.ok(verifyMerkle(leaves[i], i, merkleProof(leaves, i), root));
  assert.ok(!verifyMerkle(leaves[4], 5, merkleProof(leaves, 5), root));
});

// ---------------------------------------------------------------- sealing
async function sealedFixture() {
  const N = 20, ROUND = 9;
  const keypers = Array.from({ length: 5 }, (_, i) => ({ address: `0x${String(i + 1).padStart(40, "0")}`, top: rand(32) }));
  const centre = generateSealKeys();
  const paper = new TextEncoder().encode(JSON.stringify({ q1: "Which organelle is the powerhouse of the cell?" }));
  const sealed = await sealPaper({
    plaintext: paper,
    chainId: "qorechain-diana",
    round: ROUND,
    threshold: 3,
    keypers: keypers.map((k) => ({ keyper: k.address, publicKey: roundKeypair(seedAt(k.top, N, ROUND)).publicKey })),
    recipient: recipientOf(centre),
  });
  const seed = (i: number) => seedAt(keypers[i].top, N, ROUND);
  return { keypers, centre, paper, sealed, seed, N, ROUND };
}

test("opens with 3 of 5 released seeds + the centre's keys", async () => {
  const f = await sealedFixture();
  const out = await openPaper(f.sealed, { [f.keypers[0].address]: f.seed(0), [f.keypers[2].address]: f.seed(2), [f.keypers[4].address]: f.seed(4) }, f.centre);
  assert.deepEqual(out, f.paper);
  assert.match(sealedHash(f.sealed), /^0x[0-9a-f]{64}$/);
});

test("stays locked with only 2 of 5 seeds", async () => {
  const f = await sealedFixture();
  await assert.rejects(openPaper(f.sealed, { [f.keypers[0].address]: f.seed(0), [f.keypers[1].address]: f.seed(1) }, f.centre), /locked: 2\/3/);
});

test("a different centre cannot open it even after the bell", async () => {
  const f = await sealedFixture();
  const seeds = Object.fromEntries([0, 1, 2].map((i) => [f.keypers[i].address, f.seed(i)]));
  await assert.rejects(openPaper(f.sealed, seeds, generateSealKeys()));
});

test("seeds of a different round do not open it", async () => {
  const f = await sealedFixture();
  const seeds = Object.fromEntries([0, 1, 2].map((i) => [f.keypers[i].address, seedAt(f.keypers[i].top, f.N, f.ROUND - 1)]));
  await assert.rejects(openPaper(f.sealed, seeds, f.centre));
});

test("tampering with the header (round) breaks authentication", async () => {
  const f = await sealedFixture();
  const seeds = Object.fromEntries([0, 1, 2].map((i) => [f.keypers[i].address, f.seed(i)]));
  await assert.rejects(openPaper({ ...f.sealed, round: f.ROUND + 1 }, seeds, f.centre));
});

// ---------------------------------------------------------------- variants & leak tracing
function demoPaper(n = 30): Paper {
  return {
    title: "Mock NEET — Biology",
    questions: Array.from({ length: n }, (_, i) => ({
      id: `Q${i + 1}`,
      text: `Question ${i + 1}`,
      options: [`A${i}`, `B${i}`, `C${i}`, `D${i}`],
      answer: i % 4,
    })),
  };
}

test("variants are deterministic, distinct per centre, and provably fair", () => {
  const paper = demoPaper();
  const seed = rand(32);
  const v1 = makeVariant(paper, "C1", seed);
  const v1again = makeVariant(paper, "C1", seed);
  const v2 = makeVariant(paper, "C2", rand(32));
  assert.deepEqual(v1.order, v1again.order);
  assert.notDeepEqual(v1.order, v2.order);
  assert.ok(isFairVariant(paper, v1) && isFairVariant(paper, v2));
  const tampered = structuredClone(v1);
  tampered.paper.questions[0].answer = (tampered.paper.questions[0].answer + 1) % 4;
  assert.ok(!isFairVariant(paper, tampered));
});

test("a leaked 12-letter answer key (with one typo) identifies 1 centre out of 1000", () => {
  const paper = demoPaper(180);
  const variants = Array.from({ length: 1000 }, (_, i) => makeVariant(paper, `centre-${i}`, rand(32)));
  const culprit = variants[417];
  const obs: Observation[] = Array.from({ length: 12 }, (_, p) => ({ position: p, answerLetter: culprit.answerKey[p] }));
  obs[3].answerLetter = culprit.answerKey[3] === "A" ? "B" : "A"; // OCR/typo noise
  const [top] = traceLeak(variants, obs);
  assert.equal(top.centre, "centre-417");
  assert.ok(top.posterior > 0.99, `posterior ${top.posterior}`);
});

test("a leaked photo of 4 questions (order + first option) identifies the centre", () => {
  const paper = demoPaper(180);
  const variants = Array.from({ length: 1000 }, (_, i) => makeVariant(paper, `centre-${i}`, rand(32)));
  const culprit = variants[17];
  const obs: Observation[] = [0, 1, 2, 3].map((p) => ({
    position: p,
    questionId: culprit.paper.questions[p].id,
    firstOption: culprit.paper.questions[p].options[0],
  }));
  const [top] = traceLeak(variants, obs);
  assert.equal(top.centre, "centre-17");
  assert.ok(top.posterior > 0.999);
});
