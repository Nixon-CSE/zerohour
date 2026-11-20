/** Chain-wide views: every exam on ZeroHourExam, every keyper and every seed release on the registry. */
import { hexToBytes, verifySeed } from "@zerohour/hourglass";
import { decodeEventLog, type Hex } from "viem";
import { DEPLOYMENTS, EV, blockTime, client, examAbi, keyperRecord, roundTime, scanLogs, type Deployment, type KeyperRecord } from "./chain";
import { eq, examIndex } from "./exam";

export interface Release {
  keyper: Hex;
  registry: Hex;
  v: 1 | 2;
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

export interface Slash { keyper: Hex; registry: Hex; v: 1 | 2; round: number; tx: Hex; reporter: Hex; reward: bigint; block: bigint; time: number; unlockAt: number }

/** All keypers ever registered on every contract generation (newest first), with every release timing-checked. */
export function registryState(refresh = false) {
  if (!keyperCache || refresh) {
    keyperCache = (async () => {
      const per = await Promise.all(DEPLOYMENTS.map((d) => oneRegistry(d)));
      return {
        keypers: per.flatMap((p) => p.keypers),
        releases: per.flatMap((p) => p.releases).sort((a, b) => b.time - a.time),
        slashes: per.flatMap((p) => p.slashes),
      };
    })();
    keyperCache.catch(() => (keyperCache = null));
  }
  return keyperCache;
}

async function oneRegistry(dep: Deployment) {
  const logs = await scanLogs(dep.hourglass, dep.fromHourglass, [EV.registered, EV.released, EV.slashed]);
  const addrs = [...new Set(logs.map((l) => (decode(l).args as any).keyper as Hex))];
  const keypers = await Promise.all(addrs.map((a) => keyperRecord(a, dep.hourglass)));
  const byAddr = new Map(keypers.map((k) => [k.address.toLowerCase(), k]));
  const releases: Release[] = [];
  const slashes: Slash[] = [];
  for (const l of logs) {
    const d = decode(l);
    const a = d.args as any;
    const k = byAddr.get(a.keyper.toLowerCase())!;
    const base = { keyper: a.keyper as Hex, registry: dep.hourglass, v: dep.v, tx: l.transactionHash!, block: l.blockNumber!, time: 0 };
    if (d.eventName === "SeedReleased") {
      const round = Number(a.round);
      releases.push({ ...base, round, seed: a.seed, unlockAt: roundTime(k, round), verified: verifySeed(hexToBytes(a.seed), round, hexToBytes(k.anchor)) });
    } else if (d.eventName === "KeyperSlashed") slashes.push({ ...base, round: Number(a.round), reporter: a.reporter, reward: a.reward, unlockAt: roundTime(k, Number(a.round)) });
  }
  await Promise.all([...releases, ...slashes].map(async (r) => (r.time = await blockTime(r.block))));
  return { keypers, releases, slashes };
}

export interface ExamSummary {
  id: Hex;
  v: 1 | 2;
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
  const index = await examIndex();
  const per = await Promise.all(DEPLOYMENTS.map(async (dep) => {
    const logs = await scanLogs(dep.exam, dep.fromExam, [EV.examCreated]);
    return Promise.all(
      logs.map(async (l) => {
        const id = (decode(l).args as any).examId as Hex;
        const [e, unlocked, centres] = await Promise.all([
          client.readContract({ address: dep.exam, abi: examAbi, functionName: "getExam", args: [id] }),
          client.readContract({ address: dep.exam, abi: examAbi, functionName: "isUnlocked", args: [id] }),
          client.readContract({ address: dep.exam, abi: examAbi, functionName: "getCentres", args: [id] }),
        ]);
        const keypers = await Promise.all(e.keypers.map((k) => keyperRecord(k, dep.hourglass)));
        const round = e.usingBackup ? e.roundB : e.roundA;
        return {
          id, v: dep.v, name: index.find((x) => eq(x.examId, id))?.exam ?? null, board: e.board, round, usingBackup: e.usingBackup,
          threshold: e.threshold, keypers, unlockAt: roundTime(keypers[0], round), unlocked, revealed: e.revealed,
          centres: centres.length, createdBlock: l.blockNumber!,
        };
      }),
    );
  }));
  return per.flat().sort((a, b) => b.unlockAt - a.unlockAt);
}

/** First release that made round `r` public for keyper `k` (a later round reveals earlier ones). */
export const revealOf = (rel: Release[], k: string, r: number, registry?: string) =>
  rel.filter((x) => eq(x.keyper, k) && (!registry || eq(x.registry, registry)) && x.round >= r).sort((a, b) => a.time - b.time)[0];
