/**
 * The seal page's trust checks, kept free of React so they can be unit-tested (test/capsule.test.ts).
 * A capsule from a link or a file is untrusted input; a recipient file is published data that must name one account.
 */
import { bytesToHex, type SealedPaper } from "@zerohour/hourglass";
import type { Hex } from "viem";

export type BeaconIndex = { v: 1; chainId: string; registry: Hex; genesis: number; roundSeconds: number; every: number; threshold: number; keypers: { id: number; address: Hex; pkRoot: Hex }[]; days: string[]; recipients: string[] };
export type Capsule = { v: 1; kind: "zerohour-capsule"; chainId: string; registry: Hex; round: number; at: string; threshold: number; keypers: Hex[]; recipient: { name: string; label: string; address: string }; sealed: SealedPaper; createdAt: string };

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
const hrpExpand = (hrp: string) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));

/** qor1… → 0x…: the same 20 bytes. Verifies the bech32 checksum, so a mistyped address is refused, not misread. */
export function bech32ToEvm(addr: string, hrp = "qor"): Hex {
  const a = addr.trim();
  if (a !== a.toLowerCase() && a !== a.toUpperCase()) throw new Error("mixed-case address");
  const s = a.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (s.slice(0, sep) !== hrp) throw new Error(`not a ${hrp}1 address`);
  const data = [...s.slice(sep + 1)].map((c) => { const v = CHARSET.indexOf(c); if (v < 0) throw new Error("invalid bech32 character"); return v; });
  if (data.length < 7 || polymod(hrpExpand(hrp).concat(data)) !== 1) throw new Error("bad bech32 checksum");
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of data.slice(0, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  if (out.length !== 20) throw new Error("not a 20-byte account");
  return bytesToHex(Uint8Array.from(out)) as Hex;
}

/**
 * Accept a capsule only if it names our registry and keypers, and its bell is the round actually sealed into it (the
 * round is bound into the ciphertext header), so the page never shows a false bell or reads "seeds" from someone
 * else's contract. Returns the reason it was refused, or null.
 */
export function checkCapsule(c: Capsule, idx: BeaconIndex): string | null {
  if (c?.kind !== "zerohour-capsule" || !c.sealed || !Array.isArray(c.keypers) || !Array.isArray(c.sealed.shares)) return "not a ZeroHour capsule";
  if (c.registry?.toLowerCase() !== idx.registry.toLowerCase()) return "it names a different keyper registry";
  if (!c.keypers.every((k) => idx.keypers.some((x) => x.address.toLowerCase() === k.toLowerCase()))) return "it names keypers that are not ZeroHour's";
  if (c.round !== c.sealed.round || c.threshold !== c.sealed.threshold || c.chainId !== c.sealed.chainId) return "its label does not match what is sealed inside";
  if (Date.parse(c.at) / 1000 !== idx.genesis + c.round * idx.roundSeconds) return "its bell time does not match its round";
  const sealedKeypers = c.sealed.shares.map((s) => s.keyper.toLowerCase()).sort().join();
  if (sealedKeypers !== c.keypers.map((k) => k.toLowerCase()).sort().join()) return "its keyper list does not match the sealed shares";
  return null;
}
