/**
 * Leak Hunter steps 2-4 (match, trace, decide) on the public reveal of exam 0xe54bb5d0.
 * Step 1 (Claude reading the photo) needs an API key and is exercised by `npm run demo -- hunt`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { hexToBytes, makeVariant, type Paper } from "@zerohour/hourglass";
import { MASTER, masterCopy, matchToPaper, traceAndDecide, type Transcription } from "../src/hunter.ts";

const reveal = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../deployments/demo/0xe54bb5d0/reveal.json"), "utf8"));
const canonical: Paper = reveal.canonicalPaper;
const real = reveal.centres.map((c: any) => makeVariant(canonical, c.name, hexToBytes(c.permSeedA)));
const seed = (i: number) => { const b = new Uint8Array(32); new DataView(b.buffer).setUint32(0, i + 1); b[31] = 7; return b; };
const simulated = Array.from({ length: 998 }, (_, i) => makeVariant(canonical, `simulated-centre-${i}`, seed(i)));

/** What a correct reading of secrets/demo/leaks/patna-leak.png looks like (Patna-05, Q3-Q7). */
const patna = real.find((v: any) => v.centre === "centre-patna-05")!;
const photoOf = (from: number, to: number, mangle = (s: string) => s): Transcription => ({
  legible: true,
  notes: "",
  questions: patna.paper.questions.slice(from - 1, to).map((q: any, i: number) => ({ number: from + i, text: mangle(q.text), options: q.options.map(mangle) })),
});

test("a clean five-question photo names Patna-05 out of 1,000 centres", () => {
  const { observations } = matchToPaper(photoOf(3, 7), canonical);
  assert.equal(observations.length, 5);
  const v = traceAndDecide(observations, real, simulated);
  assert.equal(v.top?.centre, "centre-patna-05");
  assert.ok(v.fileable, v.reason);
  assert.ok(v.top!.posterior >= 0.99);
});

test("OCR-style typos in the text still match the right questions", () => {
  const typo = (s: string) => s.replace(/e/g, "c").replace(/ the /, " tbe ");
  const { observations, matched } = matchToPaper(photoOf(3, 7, typo), canonical);
  assert.ok(observations.length >= 3, JSON.stringify(matched));
  const v = traceAndDecide(observations, real, simulated);
  assert.equal(v.top?.centre, "centre-patna-05");
});

test("a single readable question is never enough to file", () => {
  const v = traceAndDecide(matchToPaper(photoOf(3, 3), canonical).observations, real, simulated);
  assert.equal(v.fileable, false);
});

test("text that is not from this paper is dropped, not guessed", () => {
  const t: Transcription = { legible: true, notes: "", questions: [
    { number: 1, text: "What is the capital of France?", options: ["Paris", "Rome", "Madrid", "Berlin"] },
    { number: 2, text: "Solve for x: 2x + 3 = 11", options: ["4", "3", "5", "6"] },
  ] };
  const { observations, matched } = matchToPaper(t, canonical);
  assert.equal(observations.length, 0);
  assert.ok(matched.every((m) => m.dropped));
  assert.equal(traceAndDecide(observations, real, simulated).fileable, false);
});

test("an illegible photo produces no observations", () => {
  const t: Transcription = { legible: false, notes: "blurred", questions: [] };
  assert.equal(traceAndDecide(matchToPaper(t, canonical).observations, real, simulated).fileable, false);
});

test("a photo of Pune-17's copy is not pinned on Patna-05", () => {
  const pune = real.find((v: any) => v.centre === "centre-pune-17")!;
  const t: Transcription = { legible: true, notes: "", questions: pune.paper.questions.slice(2, 7).map((q: any, i: number) => ({ number: 3 + i, text: q.text, options: q.options })) };
  const v = traceAndDecide(matchToPaper(t, canonical).observations, real, simulated);
  assert.equal(v.top?.centre, "centre-pune-17");
});

const master = masterCopy(canonical);

test("a photo of the setters' master copy accuses no centre and calls for the backup paper", () => {
  const t: Transcription = { legible: true, notes: "", questions: canonical.questions.slice(7, 12).map((q, i) => ({ number: 8 + i, text: q.text, options: q.options })) };
  const v = traceAndDecide(matchToPaper(t, canonical).observations, real, simulated, master);
  assert.equal(v.top?.centre, MASTER);
  assert.equal(v.source, "master");
  assert.equal(v.fileable, false, "no reportLeak against a centre");
  assert.ok(v.top!.posterior >= 0.99, v.reason);
});

test("with the master copy in the running, a centre's copy is still pinned on that centre", () => {
  const v = traceAndDecide(matchToPaper(photoOf(3, 7), canonical).observations, real, simulated, master);
  assert.equal(v.top?.centre, "centre-patna-05");
  assert.equal(v.source, "centre");
  assert.ok(v.fileable, v.reason);
});
