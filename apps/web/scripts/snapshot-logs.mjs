// Build-time snapshot of every ZeroHourExam + HourglassRegistry event, plus the timestamps of
// the blocks they sit in. The browser trusts nothing here blindly: it uses the snapshot to skip
// re-scanning old blocks, then reads everything newer than `head` straight from the chain.
// Contract state (bonds, nextRound, isUnlocked, ...) is always read live.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http } from "viem";

const RPC = "https://evm-testnet.qore.host";
const SOURCES = [
  { address: "0x5CF8c43C52483bF09F9a32D07a614250bd60f1AA", from: 10_136_128n },
  { address: "0x3494389A2C3BC5ea6cc0749F23C6a864aEE9c250", from: 10_140_062n },
];
const client = createPublicClient({ transport: http(RPC, { retryCount: 3 }) });

export async function snapshot(outDir) {
  const head = await client.getBlockNumber();
  const logs = [];
  for (const s of SOURCES) {
    for (let a = s.from; a <= head; a += 10_000n) {
      const b = a + 9_999n > head ? head : a + 9_999n;
      const got = await client.getLogs({ address: s.address, fromBlock: a, toBlock: b });
      for (const l of got) logs.push({ address: l.address, topics: l.topics, data: l.data, blockNumber: l.blockNumber.toString(), transactionHash: l.transactionHash, logIndex: l.logIndex });
    }
  }
  const blocks = {};
  for (const n of [...new Set(logs.map((l) => l.blockNumber))]) {
    blocks[n] = Number((await client.getBlock({ blockNumber: BigInt(n) })).timestamp);
  }
  writeFileSync(resolve(outDir, "logs.json"), JSON.stringify({ head: head.toString(), takenAt: new Date().toISOString(), logs, blocks }));
  return { head, logs: logs.length };
}
