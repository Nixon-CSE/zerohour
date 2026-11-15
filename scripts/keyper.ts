/**
 * keyper.ts — run an Hourglass keyper (keyper #1 = the drill account).
 *
 *   npm run keyper -- init       create a secret seed chain + ML-KEM-1024 pk commitment
 *   npm run keyper -- check      read pqcKeyStatus for this account via the precompile
 *   npm run keyper -- register   sign registerDigest with ML-DSA-87 and post the bond
 *   npm run keyper -- release [round]   publish the seed for a round whose time has come
 *   npm run keyper -- status     on-chain keyper record + current round
 *
 * Chain:  seed[N] random; seed[r-1] = keccak256(seed[r]); anchor = keccak256(seed[0]).
 * Round keys: ML-KEM-1024 keygen(SHAKE256(seed[r], 64)). pkRoot = Merkle(keccak256(pk_r)).
 */
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { mldsa87, mlkem1024, shake256 } from "@qorechain/pqc";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, parseAbi, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ACCOUNT_SECRET = resolve(here, "../secrets/drill.secret.json");
const CHAIN_SECRET = resolve(here, "../secrets/keyper1.secret.json");
const PUBLIC_OUT = resolve(here, "../deployments/keyper1.public.json");

const REGISTRY = (process.env.HOURGLASS ?? "0x5CF8c43C52483bF09F9a32D07a614250bd60f1AA") as Hex;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS ?? 300); // 5-minute rounds
const MAX_ROUND = Number(process.env.MAX_ROUND ?? 8640); // 30 days
const BOND = BigInt(process.env.BOND_WEI ?? 10n ** 18n); // 1 QOR

const chain = defineChain({
  id: 9800,
  name: "QoreChain Diana testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});
const pub = createPublicClient({ chain, transport: http() });

const abi = parseAbi([
  "function registerDigest(address,bytes32,bytes32,uint64,uint32,uint32) view returns (bytes32)",
  "function register(address,bytes32,bytes32,uint64,uint32,uint32,bytes) payable",
  "function release(address,uint32,bytes32)",
  "function keypers(address) view returns (bytes32 anchor, bytes32 pkRoot, uint64 genesis, uint32 roundSeconds, uint32 maxRound, uint32 nextRound, bytes32 lastHash, uint128 bond, uint64 exitAt, bool slashed, bool registered)",
]);
const pqcAbi = parseAbi(["function pqcKeyStatus(address) view returns (bool, uint8, bytes)"]);

const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const k256 = (b: Uint8Array) => hexToBytes(keccak256(b));
const roundPk = (seed: Uint8Array) => mlkem1024.keygen(shake256(seed, 64)).publicKey;

function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i], b = level[i + 1] ?? level[i];
      next.push(k256(new Uint8Array([...a, ...b])));
    }
    level = next;
  }
  return level[0];
}

async function acc() {
  const { mnemonic } = JSON.parse(readFileSync(ACCOUNT_SECRET, "utf8"));
  return deriveUnifiedAccount(mnemonic, 0);
}
function chainSecret() {
  if (!existsSync(CHAIN_SECRET)) throw new Error("No seed chain yet. Run: npm run keyper -- init");
  return JSON.parse(readFileSync(CHAIN_SECRET, "utf8")) as { top: string; maxRound: number; genesis: number; roundSeconds: number };
}
/** seed for round r, recomputed from the top secret (never stored per round) */
function seedAt(top: Uint8Array, maxRound: number, r: number): Uint8Array {
  let s = top;
  for (let i = maxRound; i > r; i--) s = k256(s);
  return s;
}

const commands: Record<string, (a: string[]) => Promise<void>> = {
  async init() {
    if (existsSync(CHAIN_SECRET)) throw new Error("Seed chain already exists — refusing to overwrite.");
    const top = crypto.getRandomValues(new Uint8Array(32));
    const genesis = Math.floor(Date.now() / 1000 / ROUND_SECONDS) * ROUND_SECONDS; // aligned to a round boundary
    console.log(`deriving ${MAX_ROUND + 1} ML-KEM-1024 round keys…`);
    const seeds: Uint8Array[] = new Array(MAX_ROUND + 1);
    seeds[MAX_ROUND] = top;
    for (let r = MAX_ROUND; r > 0; r--) seeds[r - 1] = k256(seeds[r]);
    const anchor = k256(seeds[0]);
    const leaves = seeds.map((s) => k256(roundPk(s)));
    const root = merkleRoot(leaves);
    mkdirSync(dirname(CHAIN_SECRET), { recursive: true });
    writeFileSync(CHAIN_SECRET, JSON.stringify({ top: toHex(top), maxRound: MAX_ROUND, genesis, roundSeconds: ROUND_SECONDS }, null, 2), { mode: 0o600 });
    mkdirSync(dirname(PUBLIC_OUT), { recursive: true });
    writeFileSync(PUBLIC_OUT, JSON.stringify({ registry: REGISTRY, anchor: toHex(anchor), pkRoot: toHex(root), genesis, roundSeconds: ROUND_SECONDS, maxRound: MAX_ROUND }, null, 2));
    console.log(`anchor ${toHex(anchor)}\npkRoot ${toHex(root)}\ngenesis ${new Date(genesis * 1000).toISOString()}  (${ROUND_SECONDS}s rounds, ${MAX_ROUND} rounds)`);
  },

  async check() {
    const a = await acc();
    const [registered, alg, pk] = await pub.readContract({ address: "0x0000000000000000000000000000000000000a02", abi: pqcAbi, functionName: "pqcKeyStatus", args: [a.evm as Hex] });
    console.log(`pqcKeyStatus(${a.evm}): registered=${registered} algorithmId=${alg} pubkeyBytes=${(pk.length - 2) / 2}`);
    console.log(`matches our ML-DSA-87 key: ${pk.toLowerCase() === toHex(a.pqc.publicKey).toLowerCase()}`);
  },

  async register() {
    const a = await acc();
    const p = JSON.parse(readFileSync(PUBLIC_OUT, "utf8"));
    const args = [a.evm as Hex, p.anchor, p.pkRoot, BigInt(p.genesis), p.roundSeconds, p.maxRound] as const;
    const digest = await pub.readContract({ address: REGISTRY, abi, functionName: "registerDigest", args });
    const sig = mldsa87.sign(a.pqc.secretKey, hexToBytes(digest));
    const wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(a.privateKey as Hex) });
    const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: "register", args: [...args, toHex(sig)], value: BOND, gas: 1_500_000n });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`register tx ${hash} -> ${rc.status}`);
  },

  async release([roundArg]) {
    const a = await acc();
    const s = chainSecret();
    const now = Math.floor(Date.now() / 1000);
    const round = roundArg ? Number(roundArg) : Math.floor((now - s.genesis) / s.roundSeconds);
    const seed = seedAt(hexToBytes(s.top), s.maxRound, round);
    const wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(a.privateKey as Hex) });
    const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: "release", args: [a.evm as Hex, round, toHex(seed)], gas: 3_000_000n });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(`release round ${round} tx ${hash} -> ${rc.status}`);
  },

  async status() {
    const a = await acc();
    const k = await pub.readContract({ address: REGISTRY, abi, functionName: "keypers", args: [a.evm as Hex] });
    console.log({ registry: REGISTRY, keyper: a.evm, ...Object.fromEntries(Object.entries(k).map(([x, v]) => [x, typeof v === "bigint" ? v.toString() : v])) });
  },
};

const [cmd = "status", ...rest] = process.argv.slice(2);
(commands[cmd] ?? (async () => { throw new Error(`Use: ${Object.keys(commands).join(" | ")}`); }))(rest).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
