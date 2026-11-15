/**
 * Everything the consoles know comes from here: QoreChain testnet over public JSON-RPC.
 * No ZeroHour backend sits in between. If this page says a seed was released on time,
 * the browser checked it against the chain itself.
 */
import { createPublicClient, defineChain, http, parseAbi, parseAbiItem, toEventSelector, type Hex, type Log } from "viem";

export const qorechain = defineChain({
  id: 9800,
  name: "QoreChain testnet (qorechain-diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: ["https://evm-testnet.qore.host"] } },
});

export const ADDR = {
  hourglass: "0x5CF8c43C52483bF09F9a32D07a614250bd60f1AA" as Hex,
  exam: "0x3494389A2C3BC5ea6cc0749F23C6a864aEE9c250" as Hex,
};
export const FROM_BLOCK = { hourglass: 10_136_128n, exam: 10_140_062n };
// explore.qore.network serves /tx/<hash> and /address/<addr>; switch its network selector to Testnet.
export const EXPLORER = "https://explore.qore.network";

export const client = createPublicClient({ chain: qorechain, transport: http(undefined, { batch: true, retryCount: 3 }) });

export const examAbi = parseAbi([
  "struct Exam { address board; address leakHunter; uint8 threshold; bool usingBackup; bool revealed; uint32 roundA; uint32 roundB; bytes32 paperCommitA; bytes32 paperCommitB; bytes32 manifestRoot; address[] keypers; }",
  "function getExam(bytes32) view returns (Exam)",
  "function getCentres(bytes32) view returns (address[])",
  "function centres(bytes32,address) view returns (bool registered, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit, uint64 openedAt, uint32 leakReports)",
  "function isUnlocked(bytes32) view returns (bool)",
  "function activeRound(bytes32) view returns (uint32)",
]);

export const registryAbi = parseAbi([
  "function keypers(address) view returns (bytes32 anchor, bytes32 pkRoot, uint64 genesis, uint32 roundSeconds, uint32 maxRound, uint32 nextRound, bytes32 lastHash, uint128 bond, uint64 exitAt, bool slashed, bool registered)",
  "function seedOf(address,uint32) view returns (bytes32)",
]);

export const EV = {
  examCreated: parseAbiItem("event ExamCreated(bytes32 indexed examId, address indexed board, uint32 roundA, uint32 roundB, uint8 threshold, address[] keypers)"),
  centreAdded: parseAbiItem("event CentreAdded(bytes32 indexed examId, address indexed centre, bytes32 ctHashA, bytes32 ctHashB, bytes32 permCommit)"),
  switched: parseAbiItem("event SwitchedToBackup(bytes32 indexed examId, bytes32 reasonHash)"),
  opened: parseAbiItem("event PaperOpened(bytes32 indexed examId, address indexed centre, bool backup, uint64 at)"),
  leak: parseAbiItem("event LeakReported(bytes32 indexed examId, address indexed centre, bytes32 evidenceHash, uint16 confidenceBps, bytes32 sealedEvidenceRef)"),
  revealed: parseAbiItem("event FairnessRevealed(bytes32 indexed examId, bytes32 canonicalPaperHash, bytes32 salt)"),
  registered: parseAbiItem("event KeyperRegistered(address indexed keyper, bytes32 anchor, bytes32 pkRoot, uint64 genesis, uint32 roundSeconds, uint32 maxRound, uint256 bond)"),
  released: parseAbiItem("event SeedReleased(address indexed keyper, uint32 indexed round, bytes32 seed)"),
  slashed: parseAbiItem("event KeyperSlashed(address indexed keyper, uint32 indexed round, bytes32 seed, address indexed reporter, uint256 reward)"),
};

const blockTimes = new Map<bigint, Promise<number>>();

/** The RPC caps eth_getLogs at 10,000 blocks, so scan in parallel chunks. */
const CHUNK = 9_999n;

interface Snapshot { head: bigint; logs: Log[]; blocks: Map<bigint, number> }
let snap: Promise<Snapshot | null> | null = null;
/**
 * Build-time snapshot of contract events (public/deployments/logs.json). It only saves
 * re-scanning old blocks: anything newer than its head is read live, and all contract
 * state is always read live.
 */
function snapshot(): Promise<Snapshot | null> {
  snap ??= fetch("/deployments/logs.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j && {
      head: BigInt(j.head),
      logs: j.logs.map((l: any) => ({ ...l, blockNumber: BigInt(l.blockNumber) })),
      blocks: new Map(Object.entries(j.blocks as Record<string, number>).map(([k, v]) => [BigInt(k), v])),
    })
    .catch(() => null);
  return snap;
}

export async function scanLogs(address: Hex, from: bigint, events: readonly (typeof EV)[keyof typeof EV][], to?: bigint): Promise<Log[]> {
  const [head, s] = await Promise.all([to ?? client.getBlockNumber(), snapshot()]);
  const topics = new Set(events.map((e) => toEventSelector(e)));
  const cached = s ? s.logs.filter((l) => l.address.toLowerCase() === address.toLowerCase() && l.blockNumber! >= from && topics.has(l.topics[0] as Hex)) : [];
  if (s) s.blocks.forEach((t, n) => { if (!blockTimes.has(n)) blockTimes.set(n, Promise.resolve(t)); });
  const start = s && s.head + 1n > from ? s.head + 1n : from;
  const ranges: [bigint, bigint][] = [];
  for (let a = start; a <= head; a += CHUNK + 1n) ranges.push([a, a + CHUNK > head ? head : a + CHUNK]);
  const out: Log[][] = new Array(ranges.length);
  let i = 0;
  const worker = async () => {
    while (i < ranges.length) {
      const k = i++;
      out[k] = await client.getLogs({ address, events: events as any, fromBlock: ranges[k][0], toBlock: ranges[k][1] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, ranges.length) }, worker));
  return [...cached, ...out.flat()].sort((x, y) => (x.blockNumber === y.blockNumber ? (x.logIndex ?? 0) - (y.logIndex ?? 0) : Number((x.blockNumber ?? 0n) - (y.blockNumber ?? 0n))));
}

export interface KeyperRecord {
  address: Hex;
  anchor: Hex;
  pkRoot: Hex;
  genesis: number;
  roundSeconds: number;
  maxRound: number;
  nextRound: number;
  lastHash: Hex;
  bond: bigint;
  exitAt: number;
  slashed: boolean;
  registered: boolean;
}

export async function keyperRecord(address: Hex): Promise<KeyperRecord> {
  const r = await client.readContract({ address: ADDR.hourglass, abi: registryAbi, functionName: "keypers", args: [address] });
  return {
    address,
    anchor: r[0],
    pkRoot: r[1],
    genesis: Number(r[2]),
    roundSeconds: r[3],
    maxRound: r[4],
    nextRound: r[5],
    lastHash: r[6],
    bond: r[7],
    exitAt: Number(r[8]),
    slashed: r[9],
    registered: r[10],
  };
}

export const roundTime = (k: Pick<KeyperRecord, "genesis" | "roundSeconds">, r: number) => k.genesis + r * k.roundSeconds;

/** Latest block: its timestamp is the clock every unlock is judged by. */
export async function chainHead() {
  const b = await client.getBlock();
  return { number: b.number, time: Number(b.timestamp) };
}

export function blockTime(n: bigint): Promise<number> {
  if (!blockTimes.has(n)) blockTimes.set(n, client.getBlock({ blockNumber: n }).then((b) => Number(b.timestamp)));
  return blockTimes.get(n)!;
}

export const short = (h: string, n = 6) => (h.length <= 2 * n + 2 ? h : `${h.slice(0, n + 2)}…${h.slice(-n)}`);
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
