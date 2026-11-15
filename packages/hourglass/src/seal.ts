/**
 * Two-lock sealing for ZeroHour.
 *
 *   timeKey  : random 32 B, Shamir-split t-of-n; share i is ML-KEM-1024-encapsulated to keyper
 *              i's public key for `round` and AES-256-GCM-wrapped with the shared secret.
 *   recipKey : random 32 B, sealed with QoreSeal (hybrid ML-KEM-1024 + X25519) to the centre.
 *   dataKey  : keccak256("zerohour-v1" ‖ timeKey ‖ recipKey); the paper is AES-256-GCM under it.
 *
 * Opening needs BOTH ≥ t released seeds for `round` AND the centre's QoreSeal secret keys.
 */
import { mlkem1024 } from "@qorechain/pqc";
import { open as qsOpen, seal as qsSeal, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";
import { combine, split } from "shamir-secret-sharing";
import { bytesToHex, hexToBytes, k256, roundKeypair } from "./chain.ts";

const subtle = globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const PURPOSE = "zerohour-paper-v1";

/** copy into a plain ArrayBuffer-backed view (WebCrypto's BufferSource typing) */
const buf = (u: Uint8Array) => new Uint8Array(u) as Uint8Array<ArrayBuffer>;

async function aesGcm(key: Uint8Array, iv: Uint8Array, data: Uint8Array, decrypt = false, aad?: Uint8Array) {
  const k = await subtle.importKey("raw", buf(key), "AES-GCM", false, [decrypt ? "decrypt" : "encrypt"]);
  const params = { name: "AES-GCM", iv: buf(iv), ...(aad ? { additionalData: buf(aad) } : {}) };
  return new Uint8Array(decrypt ? await subtle.decrypt(params, k, buf(data)) : await subtle.encrypt(params, k, buf(data)));
}

export interface KeyperRoundKey {
  keyper: string; // 0x EVM address of the keyper in HourglassRegistry
  publicKey: Uint8Array; // ML-KEM-1024 pk for this round
}

export interface SealedPaper {
  v: 1;
  chainId: string;
  round: number;
  threshold: number;
  shares: { keyper: string; kemCt: string; iv: string; ct: string }[];
  recipient: string; // QoreSeal envelope (hex)
  iv: string;
  ct: string; // AES-GCM(dataKey, paper), AAD = header hash
}

function header(chainId: string, round: number, threshold: number, keypers: string[]) {
  return k256(new TextEncoder().encode(JSON.stringify({ PURPOSE, chainId, round, threshold, keypers: keypers.map((k) => k.toLowerCase()) })));
}

export async function sealPaper(args: {
  plaintext: Uint8Array;
  chainId: string;
  round: number;
  threshold: number;
  keypers: KeyperRoundKey[];
  recipient: SealRecipient;
}): Promise<SealedPaper> {
  const { plaintext, chainId, round, threshold, keypers, recipient } = args;
  if (threshold < 2 || threshold > keypers.length) throw new Error("need 2 <= threshold <= keypers");
  const timeKey = rand(32);
  const recipKey = rand(32);
  const pieces = await split(timeKey, keypers.length, threshold);
  const shares = await Promise.all(
    keypers.map(async (k, i) => {
      const { cipherText, sharedSecret } = mlkem1024.encapsulate(k.publicKey);
      const iv = rand(12);
      return { keyper: k.keyper, kemCt: bytesToHex(cipherText), iv: bytesToHex(iv), ct: bytesToHex(await aesGcm(sharedSecret, iv, pieces[i])) };
    }),
  );
  const env = qsSeal({ chainId, purpose: PURPOSE, recipients: [recipient], plaintext: recipKey });
  const dataKey = k256(new Uint8Array([...new TextEncoder().encode("zerohour-v1"), ...timeKey, ...recipKey]));
  const iv = rand(12);
  const aad = header(chainId, round, threshold, keypers.map((k) => k.keyper));
  return { v: 1, chainId, round, threshold, shares, recipient: bytesToHex(env), iv: bytesToHex(iv), ct: bytesToHex(await aesGcm(dataKey, iv, plaintext, false, aad)) };
}

/** Open with released seeds (keyed by keyper address) and the centre's QoreSeal keys. */
export async function openPaper(sealed: SealedPaper, seeds: Record<string, Uint8Array>, centreKeys: SealKeyPair): Promise<Uint8Array> {
  const lower = Object.fromEntries(Object.entries(seeds).map(([k, v]) => [k.toLowerCase(), v]));
  const got: Uint8Array[] = [];
  for (const s of sealed.shares) {
    const seed = lower[s.keyper.toLowerCase()];
    if (!seed) continue;
    const { secretKey } = roundKeypair(seed);
    const ss = mlkem1024.decapsulate(secretKey, hexToBytes(s.kemCt));
    got.push(await aesGcm(ss, hexToBytes(s.iv), hexToBytes(s.ct), true));
    if (got.length === sealed.threshold) break;
  }
  if (got.length < sealed.threshold) throw new Error(`locked: ${got.length}/${sealed.threshold} keyper seeds released`);
  const timeKey = await combine(got);
  const recipKey = qsOpen({ chainId: sealed.chainId, purpose: PURPOSE, envelope: hexToBytes(sealed.recipient), keys: centreKeys });
  const dataKey = k256(new Uint8Array([...new TextEncoder().encode("zerohour-v1"), ...timeKey, ...recipKey]));
  const aad = header(sealed.chainId, sealed.round, sealed.threshold, sealed.shares.map((s) => s.keyper));
  return aesGcm(dataKey, hexToBytes(sealed.iv), hexToBytes(sealed.ct), true, aad);
}

/** Hash committed on chain as the centre's ctHash. */
export const sealedHash = (s: SealedPaper): `0x${string}` => bytesToHex(k256(new TextEncoder().encode(JSON.stringify(s))));
