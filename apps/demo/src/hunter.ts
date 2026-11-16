/**
 * Leak Hunter: from a photo of a leaked paper to a centre, with the model kept on a short leash.
 *
 *   1. Read   Claude (vision, structured output) transcribes what is printed: question numbers,
 *             question text, and options in printed order. It is never told which centres exist,
 *             never sees the variants, and never names a suspect.
 *   2. Match  Plain code matches each transcribed question to the canonical paper by trigram overlap
 *             and maps the first printed option to its canonical text. Weak or ambiguous matches
 *             are dropped, not guessed.
 *   3. Trace  The noisy-channel tracer (packages/hourglass) scores every centre's variant.
 *   4. Decide A report is filed only when the top match is a real centre at >= 99% posterior and the
 *             operator passed --file. Everything else is "inconclusive" and nothing goes on chain.
 *
 * The evidence bundle keeps the photo's keccak hash, the model id, the API response id and the raw
 * transcription, so anyone holding the photo can re-run steps 2-4 and get the same answer.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { bytesToHex, k256, traceLeak, type Observation, type Paper, type TraceResult, type Variant } from "@zerohour/hourglass";

export const MODEL = "claude-opus-5-5";

/**
 * The API key lives in secrets/anthropic.env (gitignored), never in code or chat.
 * An ANTHROPIC_API_KEY already set in the environment wins.
 */
export function loadApiKey() {
  const file = resolve(import.meta.dirname, "../../../secrets/anthropic.env");
  if (!process.env.ANTHROPIC_API_KEY && existsSync(file)) process.loadEnvFile(file);
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("no Claude API key: put ANTHROPIC_API_KEY=... in secrets/anthropic.env");
}

/** What Claude must return. Mirrors the JSON schema sent to the API; checked again with zod. */
export const Transcription = z.object({
  legible: z.boolean(),
  questions: z.array(
    z.object({
      number: z.number().int().nullable(),
      text: z.string(),
      options: z.array(z.string()),
    }),
  ),
  notes: z.string(),
});
export type Transcription = z.infer<typeof Transcription>;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["legible", "questions", "notes"],
  properties: {
    legible: { type: "boolean", description: "false if no exam question can be read with confidence" },
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "text", "options"],
        properties: {
          number: { type: ["integer", "null"], description: "question number exactly as printed, or null if not visible" },
          text: { type: "string", description: "question stem, transcribed verbatim" },
          options: { type: "array", items: { type: "string" }, description: "answer options in the order printed, without their letter labels" },
        },
      },
    },
    notes: { type: "string", description: "anything that limits the reading: cropping, glare, handwriting, partial lines" },
  },
} as const;

const SYSTEM = `You transcribe photographs of printed multiple-choice exam papers for an exam-security audit.

Report only what is printed and legible. For each question you can read, give its printed number, the question text, and its answer options in the order they appear on the page, without the A/B/C/D labels. If a question is cut off, include only the parts you can read and leave a missing number as null. Do not correct, complete, or infer text that is not visible, and do not answer the questions.

If the image is not an exam paper or nothing can be read, set legible to false and explain in notes.`;

const MEDIA: Record<string, "image/png" | "image/jpeg" | "image/webp" | "image/gif"> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

export interface Reading {
  transcription: Transcription;
  model: string;
  responseId: string;
  photoHash: `0x${string}`;
  usage: { input: number; output: number };
}

/** Step 1: Claude reads the photo. Throws on refusal or malformed output; never returns a guess. */
export async function readPhoto(path: string, client?: Anthropic): Promise<Reading> {
  if (!client) { loadApiKey(); client = new Anthropic(); }
  const mediaType = MEDIA[extname(path).toLowerCase()];
  if (!mediaType) throw new Error(`unsupported image type ${extname(path)} (use png, jpg, webp or gif)`);
  const bytes = readFileSync(path);

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } },
          { type: "text", text: "Transcribe every exam question visible in this photo." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`the model declined to read this image (${response.stop_details?.category ?? "no category"})`);
  }
  if (response.stop_reason === "max_tokens") throw new Error("transcription was cut off (max_tokens)");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const parsed = Transcription.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`transcription did not match the schema: ${parsed.error.message}`);

  return {
    transcription: parsed.data,
    model: response.model,
    responseId: response.id,
    photoHash: bytesToHex(k256(new Uint8Array(bytes))),
    usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}

/**
 * Step 1, second reader: the same instructions and schema through Claude Code in headless mode
 * (`claude -p --json-schema`). It runs on the operator's Claude plan instead of API credits and may
 * only use its Read tool, scoped to the photo's folder.
 */
export async function readPhotoWithClaudeCode(path: string): Promise<Reading> {
  const abs = resolve(path);
  if (!MEDIA[extname(abs).toLowerCase()]) throw new Error(`unsupported image type ${extname(abs)} (use png, jpg, webp or gif)`);
  const bytes = readFileSync(abs);
  const prompt = `${SYSTEM}\n\nRead the image file at ${abs} and transcribe every exam question visible in it. Return only the structured output.`;
  const r = spawnSync("claude", [
    "-p", prompt,
    "--output-format", "json",
    "--json-schema", JSON.stringify(SCHEMA),
    "--allowedTools", "Read",
    "--add-dir", dirname(abs),
  ], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 300_000 });
  if (r.error) throw new Error(`could not run claude: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`claude -p failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 500)}`);
  const out = JSON.parse(r.stdout);
  if (out.is_error) throw new Error(`claude -p reported an error: ${String(out.result).slice(0, 500)}`);
  const raw = out.structured_output ?? JSON.parse(String(out.result).replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const parsed = Transcription.safeParse(raw);
  if (!parsed.success) throw new Error(`transcription did not match the schema: ${parsed.error.message}`);
  const models = Object.keys(out.modelUsage ?? {});
  return {
    transcription: parsed.data,
    model: `claude-code:${models.join("+") || "default"}`,
    responseId: String(out.session_id ?? ""),
    photoHash: bytesToHex(k256(new Uint8Array(bytes))),
    usage: { input: out.usage?.input_tokens ?? 0, output: out.usage?.output_tokens ?? 0 },
  };
}

// ------------------------------------------------------------------ step 2: match (no model)

/** Character-trigram Dice similarity: typos cost a few trigrams, not whole words. */
const grams = (s: string) => {
  const t = ` ${s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim()} `;
  const m = new Map<string, number>();
  for (let i = 0; i + 3 <= t.length; i++) m.set(t.slice(i, i + 3), (m.get(t.slice(i, i + 3)) ?? 0) + 1);
  return m;
};
function overlap(a: string, b: string): number {
  const x = grams(a), y = grams(b);
  let shared = 0, total = 0;
  for (const [g, n] of x) { shared += Math.min(n, y.get(g) ?? 0); total += n; }
  for (const n of y.values()) total += n;
  return total ? (2 * shared) / total : 0;
}
const best = <T>(items: T[], score: (t: T) => number) => {
  const s = items.map((t) => ({ t, s: score(t) })).sort((a, b) => b.s - a.s);
  return { top: s[0], margin: s[0].s - (s[1]?.s ?? 0) };
};

export interface MatchedQuestion {
  printedNumber: number;
  questionId: string;
  textScore: number;
  firstOption?: string; // canonical text of the option printed first
  dropped?: string; // why this transcribed question was not used
}

/** Map transcribed questions to canonical ones. Thresholds are deliberately strict: drop rather than guess. */
export function matchToPaper(t: Transcription, canonical: Paper, minScore = 0.5, minMargin = 0.15): { matched: MatchedQuestion[]; observations: Observation[] } {
  const matched: MatchedQuestion[] = [];
  const observations: Observation[] = [];
  const used = new Set<string>();
  for (const q of t.questions) {
    if (q.number === null || q.number < 1 || q.number > canonical.questions.length) {
      matched.push({ printedNumber: q.number ?? -1, questionId: "", textScore: 0, dropped: "no usable question number" });
      continue;
    }
    const { top, margin } = best(canonical.questions, (c) => overlap(q.text, c.text));
    if (top.s < minScore || margin < minMargin || used.has(top.t.id)) {
      matched.push({ printedNumber: q.number, questionId: top.t.id, textScore: top.s, dropped: used.has(top.t.id) ? "duplicate match" : "text match too weak or ambiguous" });
      continue;
    }
    used.add(top.t.id);
    const obs: Observation = { position: q.number - 1, questionId: top.t.id };
    const m: MatchedQuestion = { printedNumber: q.number, questionId: top.t.id, textScore: top.s };
    if (q.options.length) {
      const opt = best(top.t.options, (o) => overlap(q.options[0], o) + (q.options[0].trim().toLowerCase() === o.trim().toLowerCase() ? 1 : 0));
      if (opt.top.s >= 0.5 && opt.margin > 0) obs.firstOption = m.firstOption = opt.top.t;
    }
    matched.push(m);
    observations.push(obs);
  }
  return { matched, observations };
}

// ------------------------------------------------------------------ steps 3-4: trace and decide

export const FILE_THRESHOLD = 0.99;

export interface Verdict {
  ranking: TraceResult[];
  top: TraceResult | null;
  realCentres: number;
  simulatedCentres: number;
  fileable: boolean;
  reason: string;
}

export function traceAndDecide(observations: Observation[], real: Variant[], simulated: Variant[]): Verdict {
  const base = { realCentres: real.length, simulatedCentres: simulated.length };
  if (observations.length < 2) return { ...base, ranking: [], top: null, fileable: false, reason: `only ${observations.length} usable observation(s); need at least 2` };
  const ranking = traceLeak([...real, ...simulated], observations);
  const top = ranking[0];
  const isReal = real.some((v) => v.centre === top.centre);
  if (!isReal) return { ...base, ranking, top, fileable: false, reason: `best match is a simulated centre (${top.centre}); not filing` };
  if (top.posterior < FILE_THRESHOLD) return { ...base, ranking, top, fileable: false, reason: `posterior ${top.posterior.toFixed(4)} is below ${FILE_THRESHOLD}; inconclusive` };
  return { ...base, ranking, top, fileable: true, reason: `${top.centre} at posterior ${top.posterior.toFixed(6)} (${top.matches}/${top.observed} observations agree)` };
}
