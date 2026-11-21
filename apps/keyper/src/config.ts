/**
 * Keyper configuration. Everything has a testnet default; override with env vars.
 *
 *   KEYPER_HOME      directory for this keyper's files (default ~/.zerohour-keyper)
 *   KEYPER_ACCOUNT   account secret  (default $KEYPER_HOME/account.secret.json)  { mnemonic }
 *   KEYPER_CHAIN     seed-chain secret (default $KEYPER_HOME/chain.secret.json) { top, maxRound, genesis, roundSeconds }
 *   HOURGLASS / ZEROHOUR_EXAM / EXAM_FROM_BLOCK / QORE_EVM_RPC / QORE_REST_URL / QORE_RPC_URL
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getNetwork } from "@qorechain/sdk";
import { defineChain, type Hex } from "viem";

const env = process.env;
const net = getNetwork("testnet");

export const HOME = resolve(env.KEYPER_HOME ?? resolve(homedir(), ".zerohour-keyper"));
export const paths = {
  account: resolve(env.KEYPER_ACCOUNT ?? resolve(HOME, "account.secret.json")),
  chain: resolve(env.KEYPER_CHAIN ?? resolve(HOME, "chain.secret.json")),
  public: resolve(HOME, "keyper.public.json"),
  state: resolve(HOME, "state.json"),
  log: resolve(HOME, "releases.jsonl"),
  leaves: resolve(HOME, "pk-leaves.json"), // public: keccak256(pk_r) for every round
};

export const net_ = {
  chainId: net.chainId, // qorechain-diana
  rest: env.QORE_REST_URL ?? net.endpoints.rest,
  rpc: env.QORE_RPC_URL ?? net.endpoints.rpc,
  evmRpc: env.QORE_EVM_RPC ?? "https://evm-testnet.qore.host",
};

/** v2 (20 Nov 2026). v1 (registry 0x5CF8…f1AA, exam 0x3494…c250) is retired: see deployments/testnet.json. */
export const contracts = {
  hourglass: (env.HOURGLASS ?? "0xAF59A5e81c0F5D85ec79f3fE6F33Bd8A923fD834") as Hex,
  exam: (env.ZEROHOUR_EXAM ?? "0x358545bc6d0321705f8944e32560681e788949ad") as Hex,
  examFromBlock: BigInt(env.EXAM_FROM_BLOCK ?? "10434414"),
};

export const tuning = {
  pollMs: Number(env.POLL_MS ?? 5_000),
  safetySeconds: Number(env.SAFETY_SECONDS ?? 2),
  // Release the current round once this many are unrevealed, so a release never has to walk a long chain
  // (a 1,296-step walk ran out of gas on 20 Nov). 288 = one day of 5-minute rounds; 0 = exam rounds only.
  heartbeatEvery: Number(env.HEARTBEAT_EVERY ?? 288),
  maxFeeGwei: BigInt(env.MAX_FEE_GWEI ?? 500),
  windowBlocks: BigInt(env.WINDOW_BLOCKS ?? 8_000),
  windowTxs: BigInt(env.WINDOW_TXS ?? 20),
  windowGasPerTx: BigInt(env.WINDOW_GAS_PER_TX ?? 1_500_000),
  logChunk: BigInt(env.LOG_CHUNK ?? 5_000),
  bondWei: BigInt(env.BOND_WEI ?? 10n ** 18n),
  roundSeconds: Number(env.ROUND_SECONDS ?? 300),
  maxRound: Number(env.MAX_ROUND ?? 17_280), // 60 days of 5-minute rounds
  // All keypers of an exam must share one clock. Default: the ZeroHour v2 keyper clock (20 Nov 2026 13:05 UTC).
  genesis: Number(env.GENESIS ?? 1_795_179_900),
};

export const chain = defineChain({
  id: 9800,
  name: "QoreChain Diana testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [net_.evmRpc] } },
});
