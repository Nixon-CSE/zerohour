/**
 * Native-lane plumbing: every EVM tx on QoreChain needs an EVM window, opened by a
 * hybrid-signed (ECDSA + ML-DSA-87) native message. The keyper keeps a window scoped to the
 * Hourglass registry only, so even a stolen ECDSA key can't move funds through the EVM lane.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  generateMnemonic,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowStatus, type EvmWindow } from "@qorechain/evm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { net_, paths, tuning } from "./config.ts";

const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

export function createAccountFile(): Promise<UnifiedAccount> {
  if (existsSync(paths.account)) throw new Error(`${paths.account} exists — refusing to overwrite an account`);
  const mnemonic = generateMnemonic();
  return deriveUnifiedAccount(mnemonic, 0).then((acc) => {
    mkdirSync(dirname(paths.account), { recursive: true });
    writeFileSync(paths.account, JSON.stringify({ purpose: "ZeroHour keyper (testnet)", mnemonic, evm: acc.evm, cosmos: acc.cosmos }, null, 2), { mode: 0o600 });
    return acc;
  });
}

export function loadAccount(): Promise<UnifiedAccount> {
  if (!existsSync(paths.account)) throw new Error(`no account at ${paths.account} — run: zerohour-keyper new`);
  return deriveUnifiedAccount(JSON.parse(readFileSync(paths.account, "utf8")).mnemonic, 0);
}

async function sequence(address: string) {
  const res = await fetch(`${net_.rest}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) throw new Error(`${address} is not on chain yet — fund it at https://dashboard.qorechain.io/faucet`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, any> };
  const a = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(a.account_number ?? "0"), sequence: BigInt(a.sequence ?? "0") };
}

export async function broadcastNative(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[]): Promise<string> {
  const { accountNumber, sequence: seq } = await sequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: net_.rest });
  const transport = await StargateClient.connect(net_.rpc);
  try {
    const res = await signer.signAndBroadcast(transport, { chainId: net_.chainId, accountNumber, sequence: seq, fee: FEE, messages });
    if (res.code !== 0) throw new Error(`native tx failed (code ${res.code}): ${res.transactionHash}`);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

export async function ensurePqcKey(acc: UnifiedAccount): Promise<string | null> {
  const st = await fetchPqcStatus({ rest: net_.rest, address: acc.cosmos });
  if (st.registered) {
    if (isRegisteredPqcKey(st, acc.pqc.publicKey) === false) throw new Error("a DIFFERENT ML-DSA key is registered for this account");
    return null;
  }
  const proofOfPossession = signProofOfPossession({ chainId: net_.chainId, account: acc.cosmos, keypair: acc.pqc });
  return broadcastNative(acc, "classical", [buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession })]);
}

export const windowStatus = (acc: UnifiedAccount) => evmWindowStatus({ rest: net_.rest, address: acc.cosmos });

/** Why the current window can't carry a tx costing `needUqor` to `target` (null = it can). */
export function windowProblem(w: EvmWindow, target: string, needUqor: bigint, value = 0n): string | null {
  if (!w.found) return "no window";
  if (!w.live) return "window expired or exhausted";
  if (w.nativeOnly) return "window is native-only";
  if (w.remainingTxs < 1n) return "no txs left";
  if (w.remainingBlocks < 3n) return "window about to expire";
  if (w.remainingValue < needUqor + value) return `value budget ${w.remainingValue} < ${needUqor + value} uqor`;
  if (w.allowedTargets.length && !w.allowedTargets.map((t) => t.toLowerCase()).includes(target.toLowerCase())) return "window scoped to other targets";
  return null;
}

/** Open a window scoped to `targets` (empty = unscoped, needed for deploys). Returns tx hash. */
export async function openWindow(acc: UnifiedAccount, targets: string[], perTxUqor: bigint, extraUqor = 0n): Promise<string> {
  const msg = openEvmWindowMsg({
    sender: acc.cosmos,
    blocks: tuning.windowBlocks,
    maxTxs: tuning.windowTxs,
    maxValue: perTxUqor * tuning.windowTxs + extraUqor,
    ...(targets.length ? { allowedTargets: targets } : {}),
  });
  return broadcastNative(acc, "hybrid", [msg]);
}
