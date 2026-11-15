/**
 * drill.ts — the ZeroHour drill / keyper account on QoreChain testnet.
 *
 *   npm run account -- new         create a FRESH account (secrets -> ../secrets/drill.secret.json)
 *   npm run account -- status      address, balance, PQC key, EVM window
 *   npm run account -- register    register the account's ML-DSA-87 key (once, after funding)
 *   npm run account -- window [targets...]   open an EVM window (unscoped = deploys allowed)
 *   npm run account -- env         write ../contracts/.env (PRIVATE_KEY) for forge
 *   npm run account -- drill-key   print the ECDSA private key for the Q-Day Drill form
 *
 * Built on the official create-qorechain-dapp Foundry template's window helper.
 * The ML-DSA-87 key is derived from the mnemonic, so the ECDSA private key we hand to
 * the drill bot does NOT reveal it. Never reuse this account for anything of value.
 */
import { StargateClient } from "@cosmjs/stargate";
import {
  EthNativeSigner,
  buildRegisterPqcKeyMsg,
  deriveUnifiedAccount,
  fetchPqcStatus,
  generateMnemonic,
  getNetwork,
  isRegisteredPqcKey,
  openEvmWindowMsg,
  signProofOfPossession,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = resolve(here, "../secrets/drill.secret.json");
const net = getNetwork("testnet");
const REST = process.env.QORE_REST_URL ?? net.endpoints.rest;
const RPC = process.env.QORE_RPC_URL ?? net.endpoints.rpc;
const CHAIN_ID = net.chainId;
const FEE = { amount: [{ denom: "uqor", amount: "100000" }], gas: "800000" };

function loadMnemonic(): string {
  if (!existsSync(SECRET)) throw new Error(`No account yet. Run: npm run account -- new`);
  return JSON.parse(readFileSync(SECRET, "utf8")).mnemonic as string;
}
const account = (): Promise<UnifiedAccount> => deriveUnifiedAccount(loadMnemonic(), 0);

async function accountSequence(address: string) {
  const res = await fetch(`${REST}/cosmos/auth/v1beta1/accounts/${address}`);
  if (res.status === 404) throw new Error(`${address} is not on chain yet: fund it from the faucet first`);
  if (!res.ok) throw new Error(`account query failed: HTTP ${res.status}`);
  const body = (await res.json()) as { account?: Record<string, unknown> };
  const acc = (body.account?.base_account ?? body.account ?? {}) as Record<string, string>;
  return { accountNumber: BigInt(acc.account_number ?? "0"), sequence: BigInt(acc.sequence ?? "0") };
}

async function broadcast(acc: UnifiedAccount, mode: "hybrid" | "classical", messages: any[]) {
  const { accountNumber, sequence } = await accountSequence(acc.cosmos);
  const signer = new EthNativeSigner(acc, { signMode: mode, rest: REST });
  const transport = await StargateClient.connect(RPC);
  try {
    const res = await signer.signAndBroadcast(transport, { chainId: CHAIN_ID, accountNumber, sequence, fee: FEE, messages });
    if (res.code !== 0) throw new Error(`tx failed (code ${res.code}): ${res.transactionHash}`);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}

const commands: Record<string, (args: string[]) => Promise<void>> = {
  async new() {
    if (existsSync(SECRET)) throw new Error(`${SECRET} already exists — refusing to overwrite an account.`);
    const mnemonic = generateMnemonic();
    const acc = await deriveUnifiedAccount(mnemonic, 0);
    mkdirSync(dirname(SECRET), { recursive: true });
    writeFileSync(SECRET, JSON.stringify({ purpose: "ZeroHour drill/keyper — throwaway testnet", mnemonic, evm: acc.evm, cosmos: acc.cosmos }, null, 2), { mode: 0o600 });
    console.log("Fresh drill account created (secrets saved to secrets/drill.secret.json, gitignored).");
    console.log(`  native : ${acc.cosmos}`);
    console.log(`  evm    : ${acc.evm}`);
    console.log("Next: fund the native address from https://dashboard.qorechain.io/faucet");
  },

  async status() {
    const acc = await account();
    console.log(`account : ${acc.cosmos}  /  ${acc.evm}`);
    const bal = await fetch(`${REST}/cosmos/bank/v1beta1/balances/${acc.cosmos}`).then((r) => r.json()).catch(() => ({}));
    console.log(`balance : ${JSON.stringify((bal as any).balances ?? [])}`);
    const pqc = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
    const mine = pqc.registered ? isRegisteredPqcKey(pqc, acc.pqc.publicKey) : false;
    console.log(`PQC key : ${pqc.registered ? (mine === false ? "registered, but NOT this key" : "registered (ML-DSA-87)") : "not registered"}`);
    const w = await evmWindowStatus({ rest: REST, address: acc.cosmos });
    console.log(`window  : ${!w.found ? "none" : `${w.live ? "live" : "not usable"}; ${w.remainingBlocks} blocks, ${w.remainingTxs} txs, ${w.remainingValue} uqor left`}`);
  },

  async register() {
    const acc = await account();
    const pqc = await fetchPqcStatus({ rest: REST, address: acc.cosmos });
    if (pqc.registered) return console.log("PQC key already registered; nothing to do.");
    const proofOfPossession = signProofOfPossession({ chainId: CHAIN_ID, account: acc.cosmos, keypair: acc.pqc });
    const msg = buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
    console.log(`registered ML-DSA-87 key: ${await broadcast(acc, "classical", [msg])}`);
  },

  async window(targets) {
    const acc = await account();
    const blocks = BigInt(process.env.WINDOW_BLOCKS ?? "600");
    const maxTxs = BigInt(process.env.WINDOW_TXS ?? "5");
    const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 250_000_000_000n });
    const bondUqor = BigInt(process.env.WINDOW_EXTRA_UQOR ?? "0"); // e.g. bond value sent in register()
    const maxValue = perTx * maxTxs + bondUqor;
    const scope = targets.length ? { allowedTargets: targets } : {};
    const msg = openEvmWindowMsg({ sender: acc.cosmos, blocks, maxTxs, maxValue, ...scope });
    console.log(`window opened: ${await broadcast(acc, "hybrid", [msg])}`);
    console.log(`  ${blocks} blocks, ${maxTxs} txs, ${maxValue} uqor, targets: ${targets.length ? targets.join(", ") : "any (deploys allowed)"}`);
  },

  async env() {
    const acc = await account();
    const file = resolve(here, "../contracts/.env");
    writeFileSync(file, `PRIVATE_KEY=${acc.privateKey}\n`, { mode: 0o600 });
    console.log(`wrote contracts/.env (gitignored) for ${acc.evm}`);
  },

  async "drill-key"() {
    const acc = await account();
    console.log("Q-Day Drill form -> 'ECDSA private key of the drill account (hex)':");
    console.log(acc.privateKey.replace(/^0x/, ""));
    console.log("(This key goes to the attacker bot and is published. It is a throwaway account.)");
  },
};

const [cmd = "status", ...args] = process.argv.slice(2);
const run = commands[cmd];
if (!run) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}
run(args).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
