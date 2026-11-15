/**
 * Keyper seed chains and round keys.
 *
 *   seed[N] = random 32 bytes (the keyper's only long-term secret)
 *   seed[r-1] = keccak256(seed[r])            (backward hash chain)
 *   anchor  = keccak256(seed[0])              (committed on chain in HourglassRegistry)
 *   round key r = ML-KEM-1024.keygen(SHAKE256(seed[r], 64))
 *
 * Publishing seed[r] reveals every earlier round's seed and key, but nothing about later
 * rounds — so a release is final, compact (32 bytes) and verifiable by anyone.
 */
import { mlkem1024, shake256 } from "@qorechain/pqc";
import { bytesToHex as vBytesToHex, hexToBytes as vHexToBytes, keccak256 } from "viem";

// Browser-safe (no Buffer): the same code runs in the keyper daemon and in the centre console.
export const hexToBytes = (h: string): Uint8Array => vHexToBytes((h.startsWith("0x") ? h : `0x${h}`) as `0x${string}`);
export const bytesToHex = (b: Uint8Array): `0x${string}` => vBytesToHex(b);
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
export const k256 = (b: Uint8Array): Uint8Array => hexToBytes(keccak256(b));

/** Seed for round `r` from the chain top (walks maxRound - r steps). */
export function seedAt(top: Uint8Array, maxRound: number, r: number): Uint8Array {
  if (r < 0 || r > maxRound) throw new RangeError(`round ${r} outside 0..${maxRound}`);
  let s = top;
  for (let i = maxRound; i > r; i--) s = k256(s);
  return s;
}

export function anchorOf(top: Uint8Array, maxRound: number): Uint8Array {
  return k256(seedAt(top, maxRound, 0));
}

/** Same check the contract runs: keccak^(round+1)(seed) == anchor. */
export function verifySeed(seed: Uint8Array, round: number, anchor: Uint8Array): boolean {
  let h = seed;
  for (let i = 0; i <= round; i++) h = k256(h);
  return bytesEqual(h, anchor);
}

export function roundKeypair(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return mlkem1024.keygen(shake256(seed, 64));
}

/** Binary keccak Merkle tree over keccak256(publicKey) leaves (odd node paired with itself). */
export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error("no leaves");
  let level = leaves;
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(k256(new Uint8Array([...level[i], ...(level[i + 1] ?? level[i])])));
    level = next;
  }
  return level[0];
}

export function merkleProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  const proof: Uint8Array[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    proof.push(level[i ^ 1] ?? level[i]);
    const next: Uint8Array[] = [];
    for (let j = 0; j < level.length; j += 2) next.push(k256(new Uint8Array([...level[j], ...(level[j + 1] ?? level[j])])));
    level = next;
    i >>= 1;
  }
  return proof;
}

export function verifyMerkle(leaf: Uint8Array, index: number, proof: Uint8Array[], root: Uint8Array): boolean {
  let h = leaf;
  let i = index;
  for (const sib of proof) {
    h = i & 1 ? k256(new Uint8Array([...sib, ...h])) : k256(new Uint8Array([...h, ...sib]));
    i >>= 1;
  }
  return bytesEqual(h, root);
}

export const pkLeaf = (publicKey: Uint8Array): Uint8Array => k256(publicKey);
