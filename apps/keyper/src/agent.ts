/**
 * Least-privilege keyper key, on QoreChain's smart accounts (x/abstractaccount, testnet).
 *
 * The always-on server should not hold the keyper's recovery phrase: that phrase moves the account's QOR and signs
 * the ML-DSA-87 exit and withdraw messages that take the bond. Instead the keyper (the owner, on an offline machine)
 * links an ed25519 *agent* key with one spending rule:
 *
 *   - permission "evm" only, and the call allowlist holds exactly HourglassRegistry.release(address,uint32,bytes32);
 *   - every denom bounded to the minimum (no value can leave the account through the agent);
 *   - an expiry, after which the owner re-links (the chain caps session length).
 *
 * The server keeps the agent key, a low-value relayer account that pays the native fee, and the seed chain. A stolen
 * agent key can only post seeds through release(), which the registry checks against the keyper's hash chain anyway.
 * The seed chain itself must live on the server (that is what a keyper does), so this does not protect against an
 * early seed leak: slashing does. It removes fund and bond theft from a server compromise.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  decodeAuthenticatorExecutions,
  evmAuthSignBytesV2,
  executeEvmMsg,
  fetchAuthNonce,
  fetchAuthenticators,
  fetchSpendingRules,
  linkAuthenticatorMsgs,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEd25519,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { encodeFunctionData, toFunctionSelector, toHex, type Hex } from "viem";
import { contracts, net_ } from "./config.ts";
import { broadcastNative, broadcastNativeResult } from "./native.ts";
import { registryAbi } from "./registry.ts";

export const RELEASE_SELECTOR = toFunctionSelector("release(address,uint32,bytes32)");
export const AGENT_LABEL = "zerohour-keyper-release";

/** The single spending rule: release() on the registry, and no value. Exported for tests. */
export function agentRule(registry: string) {
  return {
    enabled: true,
    allowedDenoms: ["uqor"],
    perTxLimit: "1", // uqor; the chain requires every denom to be bounded, and release() moves none
    dailyLimit: "1",
    allowedEvmCalls: [`${registry.toLowerCase()}/${RELEASE_SELECTOR}`],
  };
}

export const agentPubkey = (seed: Uint8Array) => ed25519.getPublicKey(seed);

/** Owner-signed (hybrid ML-DSA-87): replace the account's spending rules with agentRule and link the agent key. */
export async function linkAgent(owner: UnifiedAccount, seed: Uint8Array, opts: { days: number; force?: boolean }) {
  // No abstract-account record yet (HTTP 404 "not found") means no rules; linking creates it for account == owner.
  const existing = await fetchSpendingRules({ rest: net_.rest, address: owner.cosmos }).catch((e: Error) => {
    if (/404|not found/i.test(e.message)) return [];
    throw e;
  });
  const rules = (existing as unknown as { rules?: unknown[] }).rules ?? (Array.isArray(existing) ? existing : []);
  if (rules.length && !opts.force) {
    throw new Error(`${owner.cosmos} already has ${rules.length} spending rule(s); linking replaces them wholesale. Re-run with --force if that is intended.`);
  }
  const proof = signAuthenticatorLinkEd25519({ chainId: net_.chainId, account: owner.cosmos, privateKey: seed });
  const expiryUnix = Math.floor(Date.now() / 1000) + Math.round(opts.days * 86400);
  const msgs = linkAuthenticatorMsgs({
    owner: owner.cosmos,
    chainId: net_.chainId, // the SDK verifies the possession proof before building anything
    scheme: "ed25519",
    pubkey: proof.pubkey,
    permissions: ["evm"],
    expiryUnix,
    label: AGENT_LABEL,
    possessionProof: proof.possessionProof,
    spendingRule: agentRule(contracts.hourglass),
  });
  const tx = await broadcastNative(owner, "hybrid", msgs);
  return { tx, pubkey: toHex(proof.pubkey), expiryUnix };
}

/** Owner-signed: disable the agent key at once. */
export async function revokeAgent(owner: UnifiedAccount, pubkey: Uint8Array) {
  return broadcastNative(owner, "hybrid", [revokeAuthenticatorMsg({ owner: owner.cosmos, scheme: "ed25519", pubkey })]);
}

export async function agentStatus(account: string, pubkey: Uint8Array) {
  const none = (e: Error) => { if (/404|not found/i.test(e.message)) return []; throw e; };
  const [keys, rules, nonce] = await Promise.all([
    fetchAuthenticators({ rest: net_.rest, address: account }).catch(none),
    fetchSpendingRules({ rest: net_.rest, address: account }).catch(none),
    fetchAuthNonce({ rest: net_.rest, address: account, pubkey }),
  ]);
  return { keys, rules, nonce };
}

/**
 * Native gas for one MsgExecuteEVM. The chain runs the call with exactly `evmGas` and refuses a transaction that
 * provisions less, plus the message's own verification and bookkeeping. Measured on testnet; see the release log.
 */
export const AGENT_NATIVE_OVERHEAD_GAS = 350_000; // measured 26 Nov: 377,696 native gas in total for a 74,590-gas release (about 303k besides the EVM call), plus margin

/** Any EVM call signed by the agent key, submitted and paid for by the relayer, executed FROM the keyper's account. */
export async function executeViaAgent(args: {
  account: { evm: Hex; cosmos: string };
  agentKey: Uint8Array; // the agent's ed25519 private key
  relayer: UnifiedAccount;
  to: Hex;
  value?: string; // wei, decimal
  data: Hex;
  evmGas: bigint;
}) {
  const pubkey = agentPubkey(args.agentKey);
  const { nonce } = await fetchAuthNonce({ rest: net_.rest, address: args.account.cosmos, pubkey });
  const data = new Uint8Array(Buffer.from(args.data.slice(2), "hex"));
  const value = args.value ?? "0";
  const digest = evmAuthSignBytesV2({ chainId: net_.chainId, account: args.account.cosmos, pubkey, to: args.to, value, data, nonce, gasLimit: args.evmGas });
  const signature = ed25519.sign(digest, args.agentKey);
  const msg = executeEvmMsg({ relayer: args.relayer.cosmos, account: args.account.cosmos, scheme: "ed25519", pubkey, signature, to: args.to, value, data, gasLimit: args.evmGas, nonce });
  // Hybrid: QoreChain refuses classical-only native txs from accounts without an ML-DSA-87 key (no classical fallback).
  const res = await broadcastNativeResult(args.relayer, "hybrid", [msg], Number(args.evmGas) + AGENT_NATIVE_OVERHEAD_GAS);
  // A failed but authorised execution is code 0 with success=false, and it consumes the nonce: never read it as success.
  const [out] = decodeAuthenticatorExecutions(res as any, [msg]);
  return {
    hash: res.transactionHash as string,
    status: out?.success ? ("success" as const) : ("reverted" as const),
    block: BigInt(res.height ?? 0),
    gasUsed: out?.gasUsed ?? 0n,
    nativeGasUsed: BigInt(res.gasUsed ?? 0),
    nonce: BigInt(nonce),
    reason: out?.success ? undefined : out?.reason || out?.vmError,
  };
}

/** release(keyper, round, seed) through the agent. */
export function releaseViaAgent(args: { keyper: { evm: Hex; cosmos: string }; agentKey: Uint8Array; relayer: UnifiedAccount; round: number; seed: Uint8Array; evmGas: bigint }) {
  const data = encodeFunctionData({ abi: registryAbi, functionName: "release", args: [args.keyper.evm, args.round, toHex(args.seed)] });
  return executeViaAgent({ account: args.keyper, agentKey: args.agentKey, relayer: args.relayer, to: contracts.hourglass, data, evmGas: args.evmGas });
}
