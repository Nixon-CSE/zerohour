/** Chain-wide views: every exam on ZeroHourExam, every keyper and every seed release on the registry. */
import { hexToBytes, verifySeed } from "@zerohour/hourglass";
import { decodeEventLog, type Hex } from "viem";
import { ADDR, EV, FROM_BLOCK, blockTime, client, examAbi, keyperRecord, roundTime, scanLogs, type KeyperRecord } from "./chain";
import { eq, examIndex } from "./exam";

export interface Release {
  keyper: Hex;
  round: number;
  seed: Hex;
  tx: Hex;
  block: bigint;
  time: number; // block timestamp
  unlockAt: number; // the round's unlock time on that keyper's clock
  verified: boolean; // keccak^(round+1)(seed) == anchor, recomputed here
}

const decode = (l: any) => decodeEventLog({ abi: Object.values(EV), data: l.data, topics: l.topics });

let keyperCache: Promise<{ keypers: KeyperRecord[]; releases: Release[]; slashes: Slash[] }> | null = null;

export interface Slash { keyper: Hex; round: number; tx: Hex; reporter: Hex; reward: bigint; block: bigint; time: number; unlockAt: number }

/** All keypers ever registered, their live records, and every release with its timing checked. */
export function registryState(refresh = false) {
  if (!keyperCache || refresh) {
    keyperCache = (async () => {
      const logs = await scanLogs(ADDR.hourglass, FROM_BLOCK.hourglass, [EV.registered, EV.released, EV.slashed]);
      const addrs = [...new Set(logs.map((l) => (decode(l).args as any).keyper as Hex))];
      const keypers = await Promise.all(addrs.map((a) => keyperRecord(a)));
      const byAddr = new Map(keypers.map((k) => [k.address.toLowerCase(), k]));
      const releases: Release[] = [];
      const slashes: Slash[] = [];
      for (const l of logs) {
        const d = decode(l);
        const a = d.args as any;
        const k = byAddr.get(a.keyper.toLowerCase())!;
        if (d.eventName === "SeedReleased") {
          const round = Number(a.round);
          releases.push({
            keyper: a.keyper, round, seed: a.seed, tx: l.transactionHash!, block: l.blockNumber!, time: 0,
            unlockAt: roundTime(k, round), verified: verifySeed(hexToBytes(a.seed), round, hexToBytes(k.anchor)),
          });
        } else if (d.eventName === "KeyperSlashed") slashes.push({ keyper: a.keyper, round: Number(a.round), tx: l.transactionHash!, reporter: a.reporter, reward: a.reward, block: l.blockNumber!, time: 0, unlockAt: roundTime(k, Number(a.round)) });
      }
      await Promise.all([...releases, ...slashes].map(async (r) => (r.time = await blockTime(r.block))));
      return { keypers, releases: releases.reverse(), slashes };
    })();
    keyperCache.catch(() => (keyperCache = null));
  }
  return keyperCache;
}

export interface ExamSummary {
  id: Hex;
  name: string | null;
  board: Hex;
  round: number;
  usingBackup: boolean;
  threshold: number;
  keypers: KeyperRecord[];
  unlockAt: number;
  unlocked: boolean;
  revealed: boolean;
  centres: number;
  createdBlock: bigint;
}

export async function allExams(): Promise<ExamSummary[]> {
  const [logs, index] = await Promise.all([scanLogs(ADDR.exam, FROM_BLOCK.exam, [EV.examCreated]), examIndex()]);
  const out = await Promise.all(
    logs.map(async (l) => {
      const id = (decode(l).args as any).examId as Hex;
      const [e, unlocked, centres] = await Promise.all([
        client.readContract({ address: ADDR.exam, abi: examAbi, functionName: "getExam", args: [id] }),
        client.readContract({ address: ADDR.exam, abi: examAbi, functionName: "isUnlocked", args: [id] }),
        client.readContract({ address: ADDR.exam, abi: examAbi, functionName: "getCentres", args: [id] }),
      ]);
      const keypers = await Promise.all(e.keypers.map((k) => keyperRecord(k)));
      const round = e.usingBackup ? e.roundB : e.roundA;
      return {
        id, name: index.find((x) => eq(x.examId, id))?.exam ?? null, board: e.board, round, usingBackup: e.usingBackup,
        threshold: e.threshold, keypers, unlockAt: roundTime(keypers[0], round), unlocked, revealed: e.revealed,
        centres: centres.length, createdBlock: l.blockNumber!,
      };
    }),
  );
  return out.reverse();
}

/** First release that made round `r` public for keyper `k` (a later round reveals earlier ones). */
export const revealOf = (rel: Release[], k: string, r: number) =>
  rel.filter((x) => eq(x.keyper, k) && x.round >= r).sort((a, b) => a.time - b.time)[0];
