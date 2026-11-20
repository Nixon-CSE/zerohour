/**
 * Demo actors on QoreChain testnet. Each is a real unified account (ECDSA + ML-DSA-87) with
 * its post-quantum key registered on chain. Centres also publish an ML-KEM-1024 key in the
 * chain's KEM registry plus a hybrid-signed QoreSeal recipient card, so the board seals to
 * keys it reads from the chain — never to a key someone emailed it.
 *
 * Secrets: secrets/demo/<name>.secret.json (gitignored). Public cards: deployments/demo/cards/.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveSealKeys, signRecipientCard, type RecipientCard, type SealKeyPair } from "@qorechain/qoreseal";
import { fetchKemKey, resolveRecipient } from "@qorechain/qoreseal/network";
import { deriveUnifiedAccount, generateMnemonic, msg, type UnifiedAccount } from "@qorechain/sdk";
import { broadcastNative, ensurePqcKey } from "@zerohour/keyper/src/native.ts";
import { net_ } from "@zerohour/keyper/src/config.ts";
import { pub } from "@zerohour/keyper/src/registry.ts";
import { formatEther, hexToBytes, type Hex } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "../../..");
export const SECRETS = resolve(ROOT, "secrets/demo");
export const PUBLIC = resolve(ROOT, "deployments/demo");

export type Role = "board" | "hunter" | "centre" | "watcher";
export interface Actor {
  name: string;
  role: Role;
  acc: UnifiedAccount;
  seal: SealKeyPair; // QoreSeal keys derived from the same mnemonic (index 0)
}

export const ACTORS: { name: string; role: Role; fundQor: number }[] = [
  { name: "board", role: "board", fundQor: 3 },
  { name: "leak-hunter", role: "hunter", fundQor: 0.5 },
  { name: "centre-pune-17", role: "centre", fundQor: 0.5 },
  { name: "centre-patna-05", role: "centre", fundQor: 0.5 },
  { name: "whistleblower", role: "watcher", fundQor: 0.3 }, // anyone who gets hold of an early seed
  // A centre whose recovery phrase is PUBLIC on purpose, so judges can open a real paper in the
  // centre console. Fresh throwaway testnet account; it can only open its own copy.
  { name: "centre-judges", role: "centre", fundQor: 0.25 },
];

/** Actors whose phrase is published (deployments/demo/judge-centre.json) instead of kept secret. */
const PUBLIC_PHRASE: Record<string, string> = { "centre-judges": resolve(PUBLIC, "judge-centre.json") };

export async function loadActor(name: string, role: Role, create = false): Promise<Actor> {
  const pub_ = PUBLIC_PHRASE[name];
  const file = pub_ ?? resolve(SECRETS, `${name}.secret.json`);
  if (!existsSync(file)) {
    if (!create) throw new Error(`no actor ${name} — run: npm run demo -- actors`);
    mkdirSync(dirname(file), { recursive: true });
    const mnemonic = generateMnemonic();
    const a = await deriveUnifiedAccount(mnemonic, 0);
    const purpose = pub_
      ? "PUBLIC ON PURPOSE. ZeroHour judges' centre on QoreChain testnet: paste this phrase into the centre console to open its copy after the bell. Holds a few test QOR and can only open its own paper."
      : `ZeroHour demo ${role} (testnet)`;
    writeFileSync(file, JSON.stringify({ purpose, name, mnemonic, evm: a.evm, cosmos: a.cosmos }, null, 2), { mode: pub_ ? 0o644 : 0o600 });
  }
  const { mnemonic } = JSON.parse(readFileSync(file, "utf8"));
  return { name, role, acc: await deriveUnifiedAccount(mnemonic, 0), seal: deriveSealKeys({ mnemonic }) };
}

export const balanceUqor = async (cosmos: string): Promise<bigint> => {
  const r = await fetch(`${net_.rest}/cosmos/bank/v1beta1/balances/${cosmos}`).then((x) => x.json()).catch(() => ({}));
  const c = ((r as any).balances ?? []).find((b: any) => b.denom === "uqor");
  return BigInt(c?.amount ?? 0);
};

/** Top `to` up to `qor` from `from` (native bank send, hybrid-signed). */
export async function topUp(from: UnifiedAccount, to: string, qor: number): Promise<string | null> {
  const want = BigInt(Math.round(qor * 1e6));
  const have = await balanceUqor(to);
  if (have >= want) return null;
  const send = msg.bank.send({ fromAddress: from.cosmos, toAddress: to, amount: [{ denom: "uqor", amount: (want - have).toString() }] });
  return broadcastNative(from, "hybrid", [send]);
}

/** Centre: publish the QoreSeal ML-KEM-1024 key on chain, then a signed recipient card. */
export async function ensureKemKeyAndCard(a: Actor): Promise<{ tx: string | null; card: RecipientCard }> {
  const st = await fetchKemKey({ rest: net_.rest, address: a.acc.cosmos });
  let tx: string | null = null;
  const same = st.registered && st.publicKey && Buffer.from(st.publicKey).equals(Buffer.from(a.seal.mlkemPublicKey));
  if (!same) {
    tx = await broadcastNative(a.acc, "hybrid", [msg.pqc.registerKemKey({ sender: a.acc.cosmos, algorithmId: 2, publicKey: a.seal.mlkemPublicKey })]);
  }
  const cardFile = resolve(PUBLIC, "cards", `${a.name}.card.json`);
  let card: RecipientCard;
  if (!tx && existsSync(cardFile)) card = JSON.parse(readFileSync(cardFile, "utf8"));
  else {
    const priv = hexToBytes(a.acc.privateKey as Hex);
    card = signRecipientCard({
      chainId: net_.chainId,
      address: a.acc.cosmos,
      keys: a.seal,
      classicalKey: { type: "eth_secp256k1", privateKey: priv, publicKey: hexToBytes(a.acc.publicKey as Hex) },
      pqKey: { secretKey: a.acc.pqc.secretKey },
    });
    mkdirSync(dirname(cardFile), { recursive: true });
    writeFileSync(cardFile, JSON.stringify(card, null, 2));
  }
  // Prove the card resolves against what the chain holds (this is exactly what the board does).
  await resolveRecipient({ rest: net_.rest, chainId: net_.chainId, address: a.acc.cosmos, card });
  return { tx, card };
}

export async function setupActor(funder: UnifiedAccount, spec: (typeof ACTORS)[number]) {
  const a = await loadActor(spec.name, spec.role, true);
  const funded = await topUp(funder, a.acc.cosmos, spec.fundQor);
  if (funded) await new Promise((r) => setTimeout(r, 3000));
  const pq = await ensurePqcKey(a.acc);
  const kem = spec.role === "centre" ? await ensureKemKeyAndCard(a) : null;
  const bal = await pub.getBalance({ address: a.acc.evm as Hex });
  return { name: a.name, evm: a.acc.evm, cosmos: a.acc.cosmos, funded, pqcKeyTx: pq, kemKeyTx: kem?.tx ?? null, balance: formatEther(bal) };
}
