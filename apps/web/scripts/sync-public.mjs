// Copy the committed public record (deployments/) into public/ so the static site serves the
// exact files whose hashes are on chain. Nothing here is secret: secrets/ is never read.
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { snapshot } from "./snapshot-logs.mjs";

const root = resolve(import.meta.dirname, "../../..");
const out = resolve(import.meta.dirname, "../public/deployments");
rmSync(out, { recursive: true, force: true });
cpSync(resolve(root, "deployments"), out, { recursive: true, filter: (p) => !p.includes("secret") });
if (!existsSync(resolve(out, "testnet.json"))) throw new Error("deployments/testnet.json missing");
// A static site can't list directories, so write an index of published exam records.
const demo = resolve(out, "demo");
const exams = existsSync(demo)
  ? readdirSync(demo)
      .filter((d) => existsSync(resolve(demo, d, "manifest.json")))
      .map((d) => {
        const m = JSON.parse(readFileSync(resolve(demo, d, "manifest.json"), "utf8"));
        return { dir: `demo/${d}`, examId: m.examId, exam: m.exam, contract: m.contract };
      })
  : [];
writeFileSync(resolve(out, "exams.json"), JSON.stringify(exams, null, 2));
console.log("synced deployments/ -> public/deployments/");

// Event snapshot: optional (the site works without it, just scans more on first load).
try {
  const r = await snapshot(out);
  console.log(`event snapshot: ${r.logs} logs up to block ${r.head}`);
} catch (e) {
  console.warn(`event snapshot skipped (${e.shortMessage ?? e.message}); the browser will scan from the deploy blocks`);
}
