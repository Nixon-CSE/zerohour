import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { linkAuthenticatorMsgs, signAuthenticatorLinkEd25519, validateSpendingRules, verifyAuthenticatorLinkProof } from "@qorechain/sdk";
import { agentPubkey, agentRule, RELEASE_SELECTOR } from "../src/agent.ts";

const REGISTRY = "0xAF59A5e81c0F5D85ec79f3fE6F33Bd8A923fD834";
const ACCOUNT = "qor1zpxx6nu9du8re0zujfr5huv2uxdcs27pw5lyv8";

test("the agent may call exactly one function: HourglassRegistry.release(address,uint32,bytes32)", () => {
  assert.equal(RELEASE_SELECTOR, keccak256(toBytes("release(address,uint32,bytes32)")).slice(0, 10));
  assert.equal(RELEASE_SELECTOR, "0x020908fe");
  const r = agentRule(REGISTRY);
  assert.deepEqual(r.allowedEvmCalls, [`${REGISTRY.toLowerCase()}/0x020908fe`]); // one target, one selector
  assert.equal(r.enabled, true);
});

test("the rule lets no value out: every denom bounded to the minimum the chain accepts", () => {
  const r = agentRule(REGISTRY);
  assert.deepEqual(r.allowedDenoms, ["uqor"]);
  assert.equal(r.perTxLimit, "1");
  assert.equal(r.dailyLimit, "1");
  // The SDK's own validation (the chain's rules) accepts it.
  assert.doesNotThrow(() => validateSpendingRules([r as never]));
});

test("linking builds [MsgUpdateSpendingRules, MsgRegisterAuthenticator] with a possession proof the chain will accept", () => {
  const key = new Uint8Array(32).fill(9);
  const proof = signAuthenticatorLinkEd25519({ chainId: "qorechain-diana", account: ACCOUNT, privateKey: key });
  assert.deepEqual(proof.pubkey, agentPubkey(key));
  assert.ok(verifyAuthenticatorLinkProof({ chainId: "qorechain-diana", account: ACCOUNT, scheme: "ed25519", pubkey: proof.pubkey, possessionProof: proof.possessionProof }));
  const msgs = linkAuthenticatorMsgs({
    owner: ACCOUNT, chainId: "qorechain-diana", scheme: "ed25519", pubkey: proof.pubkey, permissions: ["evm"],
    expiryUnix: 1_798_200_579, label: "zerohour-keyper-release", possessionProof: proof.possessionProof, spendingRule: agentRule(REGISTRY),
  });
  assert.deepEqual(msgs.map((m) => m.typeUrl.split(".").pop()), ["MsgUpdateSpendingRules", "MsgRegisterAuthenticator"]);
  // A proof made for another account is refused before anything is built.
  const other = signAuthenticatorLinkEd25519({ chainId: "qorechain-diana", account: "qor1u87hdzl05pgkau7m77lusz4vguff37w66an0x4", privateKey: key });
  assert.throws(() => linkAuthenticatorMsgs({ owner: ACCOUNT, chainId: "qorechain-diana", scheme: "ed25519", pubkey: other.pubkey, permissions: ["evm"], expiryUnix: 1_798_200_579, possessionProof: other.possessionProof, spendingRule: agentRule(REGISTRY) }));
});
