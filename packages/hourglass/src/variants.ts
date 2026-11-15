/**
 * Per-centre paper variants and leak tracing (traitor tracing for exam papers).
 *
 * Every centre gets the SAME questions, reordered: question order and option order are
 * derived from a secret per-centre permutation seed (SHAKE256 stream -> Fisher-Yates). The
 * board commits keccak(permSeed ‖ salt) on chain before the exam and reveals afterwards.
 *
 * A leaked fragment — a photo transcription, a PDF page, or just a "Q1-B, Q2-D…" answer
 * key — is scored against every centre's variant with a simple noisy-channel model, giving a
 * posterior over centres. Each observed (position -> question) or (position -> answer letter)
 * pair carries ~log2(n!) / ~2 bits, so a handful of observations pins down one of thousands.
 */
import { shake256 } from "@qorechain/pqc";

export interface Question {
  id: string;
  text: string;
  options: string[];
  answer: number; // index into options
}
export interface Paper {
  title: string;
  questions: Question[];
}
export interface Variant {
  centre: string;
  order: string[]; // question ids by position
  options: Record<string, number[]>; // question id -> option permutation (display idx -> canonical idx)
  paper: Paper; // the reordered paper actually sealed to the centre
  answerKey: string[]; // letter per position
}

const LETTERS = "ABCDEFGH";

function stream(seed: Uint8Array, label: string, n: number): Uint8Array {
  return shake256(new Uint8Array([...seed, ...new TextEncoder().encode(label)]), n);
}

/** Unbiased Fisher-Yates driven by a SHAKE256 stream (rejection sampling on 32-bit words). */
export function permutation(n: number, seed: Uint8Array, label: string): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  const bytes = stream(seed, label, 4 * n * 4);
  let p = 0;
  const next = () => {
    if (p + 4 > bytes.length) throw new Error("stream exhausted");
    const v = new DataView(bytes.buffer, bytes.byteOffset + p, 4).getUint32(0);
    p += 4;
    return v;
  };
  for (let i = n - 1; i > 0; i--) {
    const m = i + 1;
    const limit = Math.floor(0x1_0000_0000 / m) * m;
    let r = next();
    while (r >= limit) r = next();
    const j = r % m;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makeVariant(paper: Paper, centre: string, permSeed: Uint8Array): Variant {
  const qPerm = permutation(paper.questions.length, permSeed, "questions");
  const ordered = qPerm.map((i) => paper.questions[i]);
  const options: Record<string, number[]> = {};
  const qs: Question[] = ordered.map((q) => {
    const oPerm = permutation(q.options.length, permSeed, `options:${q.id}`);
    options[q.id] = oPerm;
    return { id: q.id, text: q.text, options: oPerm.map((k) => q.options[k]), answer: oPerm.indexOf(q.answer) };
  });
  return {
    centre,
    order: ordered.map((q) => q.id),
    options,
    paper: { title: paper.title, questions: qs },
    answerKey: qs.map((q) => LETTERS[q.answer]),
  };
}

/** What a leak lets us observe at a given position of the leaked copy. */
export interface Observation {
  position: number;
  questionId?: string; // the question seen at this position (from OCR/text match)
  firstOption?: string; // text of the option printed first (option-order fingerprint)
  answerLetter?: string; // from a leaked answer key
}

export interface TraceResult {
  centre: string;
  posterior: number;
  matches: number;
  observed: number;
}

/**
 * Score each variant. `epsilon` = probability an observation is wrong (OCR/typo noise).
 * Correct observation: log(1 - eps); wrong: log(eps / (choices - 1)).
 */
export function traceLeak(variants: Variant[], obs: Observation[], epsilon = 0.05): TraceResult[] {
  const scored = variants.map((v) => {
    let ll = 0;
    let matches = 0;
    let observed = 0;
    for (const o of obs) {
      const q = v.paper.questions[o.position];
      if (!q) continue;
      const checks: [boolean, number][] = [];
      if (o.questionId !== undefined) checks.push([q.id === o.questionId, v.paper.questions.length]);
      if (o.firstOption !== undefined) checks.push([q.options[0] === o.firstOption, q.options.length]);
      if (o.answerLetter !== undefined) checks.push([LETTERS[q.answer] === o.answerLetter.toUpperCase(), q.options.length]);
      for (const [ok, choices] of checks) {
        observed++;
        if (ok) {
          matches++;
          ll += Math.log(1 - epsilon);
        } else ll += Math.log(epsilon / Math.max(1, choices - 1));
      }
    }
    return { centre: v.centre, ll, matches, observed };
  });
  const max = Math.max(...scored.map((s) => s.ll));
  const z = scored.reduce((acc, s) => acc + Math.exp(s.ll - max), 0);
  return scored
    .map((s) => ({ centre: s.centre, posterior: Math.exp(s.ll - max) / z, matches: s.matches, observed: s.observed }))
    .sort((a, b) => b.posterior - a.posterior);
}

/** Fairness: every variant is a reordering of the canonical paper (same questions, same answers). */
export function isFairVariant(canonical: Paper, v: Variant): boolean {
  const byId = new Map(canonical.questions.map((q) => [q.id, q]));
  if (v.paper.questions.length !== canonical.questions.length) return false;
  return v.paper.questions.every((q) => {
    const c = byId.get(q.id);
    if (!c || c.text !== q.text) return false;
    if ([...q.options].sort().join("\u0000") !== [...c.options].sort().join("\u0000")) return false;
    return q.options[q.answer] === c.options[c.answer];
  });
}
