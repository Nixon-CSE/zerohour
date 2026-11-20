/** On-chain reads/writes against HourglassRegistry and ZeroHourExam (viem). */
import { createPublicClient, createWalletClient, http, parseAbi, parseAbiItem, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, contracts, tuning } from "./config.ts";

export const registryAbi = parseAbi([
  "function registerDigest(address,bytes32,bytes32,uint64,uint32,uint32) view returns (bytes32)",
  "function register(address,bytes32,bytes32,uint64,uint32,uint32,bytes) payable",
  "function release(address,uint32,bytes32)",
  "function minBond() view returns (uint256)",
  "function exitDigest(address) view returns (bytes32)",
  "function withdrawDigest(address,address) view returns (bytes32)",
  "function requestExit(address,bytes)",
  "function withdraw(address,address,bytes)",
  "function seedOf(address,uint32) view returns (bytes32)",
  "function keypers(address) view returns (bytes32 anchor, bytes32 pkRoot, uint64 genesis, uint32 roundSeconds, uint32 maxRound, uint32 nextRound, bytes32 lastHash, uint128 bond, uint64 exitAt, bool slashed, bool registered)",
  "event SeedReleased(address indexed keyper, uint32 indexed round, bytes32 seed)",
  "event KeyperSlashed(address indexed keyper, uint32 indexed round, bytes32 seed, address indexed reporter, uint256 reward)",
]);
const examCreated = parseAbiItem(
  "event ExamCreated(bytes32 indexed examId, address indexed board, uint32 roundA, uint32 roundB, uint8 threshold, address[] keypers)",
);

export const pub = createPublicClient({ chain, transport: http() });

export async function keyperRecord(keyper: Hex) {
  const r = await pub.readContract({ address: contracts.hourglass, abi: registryAbi, functionName: "keypers", args: [keyper] });
  const [anchor, pkRoot, genesis, roundSeconds, maxRound, nextRound, lastHash, bond, exitAt, slashed, registered] = r;
  return { anchor, pkRoot, genesis: Number(genesis), roundSeconds, maxRound, nextRound, lastHash, bond, exitAt, slashed, registered };
}

export async function chainTime(): Promise<{ height: bigint; time: number }> {
  const b = await pub.getBlock({ blockTag: "latest" });
  return { height: b.number, time: Number(b.timestamp) };
}

export interface ExamTarget {
  examId: Hex;
  round: number;
  set: "A" | "B";
  threshold: number;
  block: bigint;
}

/** Scan ExamCreated logs in chunks from `from` to head; keep the exams listing `keyper`. */
export async function scanExamTargets(keyper: Hex, from: bigint, to: bigint): Promise<ExamTarget[]> {
  const out: ExamTarget[] = [];
  for (let lo = from; lo <= to; lo += tuning.logChunk) {
    const hi = lo + tuning.logChunk - 1n < to ? lo + tuning.logChunk - 1n : to;
    const logs = await pub.getLogs({ address: contracts.exam, event: examCreated, fromBlock: lo, toBlock: hi });
    for (const l of logs) {
      const a = l.args;
      if (!a.keypers?.some((k) => k.toLowerCase() === keyper.toLowerCase())) continue;
      const base = { examId: a.examId!, threshold: a.threshold!, block: l.blockNumber! };
      out.push({ ...base, round: a.roundA!, set: "A" }, { ...base, round: a.roundB!, set: "B" });
    }
  }
  return out;
}

export function wallet(privateKey: Hex) {
  return createWalletClient({ chain, transport: http(), account: privateKeyToAccount(privateKey) });
}

export async function fees() {
  const [gasPrice, tip] = await Promise.all([pub.getGasPrice(), pub.estimateMaxPriorityFeePerGas().catch(() => 0n)]);
  const cap = tuning.maxFeeGwei * 10n ** 9n;
  const maxFeePerGas = gasPrice * 2n < cap ? gasPrice * 2n : cap;
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

export async function sendRelease(privateKey: Hex, keyper: Hex, round: number, seed: Uint8Array, gas: bigint, fee: Awaited<ReturnType<typeof fees>>) {
  const hash = await wallet(privateKey).writeContract({
    address: contracts.hourglass,
    abi: registryAbi,
    functionName: "release",
    args: [keyper, round, toHex(seed)],
    gas,
    ...fee,
  });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return { hash, status: rc.status, block: rc.blockNumber, gasUsed: rc.gasUsed };
}
