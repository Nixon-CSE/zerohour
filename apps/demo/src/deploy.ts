/**
 * Deploy HourglassRegistry + ZeroHourExam (v2) from the board account.
 *
 *   WINDOW_TXS=2 WINDOW_BLOCKS=120 npx tsx src/deploy.ts
 *
 * Contract creation needs an UNSCOPED EVM window, so the deployer must be an account whose
 * classical key is private. (v1 was deployed from the drill account, whose ECDSA key is
 * published after the Q-Day Drill; an unscoped window there would let anyone send anything.)
 * The window is sized to exactly the two deploy transactions. Neither contract has an owner,
 * so the deployer keeps no power afterwards.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { weiToUqorCeil } from "@qorechain/evm";
import { openWindow, windowProblem, windowStatus } from "@zerohour/keyper/src/native.ts";
import { fees, pub, wallet } from "@zerohour/keyper/src/registry.ts";
import { parseEther, type Hex } from "viem";
import { ROOT, loadActor } from "./actors.ts";

const artifact = (name: string) => {
  const j = JSON.parse(readFileSync(resolve(ROOT, `contracts/out/${name}.sol/${name}.json`), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object as Hex };
};

const board = await loadActor("board", "board");
const w = wallet(board.acc.privateKey as Hex);
const fee = await fees();
const DEPLOY_GAS = 6_000_000n;
const cost = weiToUqorCeil(DEPLOY_GAS * fee.maxFeePerGas);
const why = windowProblem(await windowStatus(board.acc), "0x0000000000000000000000000000000000000000", cost);
// an existing scoped window cannot create contracts, so open an unscoped one unless one is live and unscoped
const ws = await windowStatus(board.acc);
if (why || ws.allowedTargets.length) console.log(`window (unscoped, 2 txs) -> ${await openWindow(board.acc, [], cost)}`);

async function deploy(name: string, args: unknown[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await w.deployContract({ abi, bytecode, args, gas: DEPLOY_GAS, ...fee });
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success" || !rc.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
  console.log(`${name}: ${rc.contractAddress}  block ${rc.blockNumber}  tx ${hash}  gas ${rc.gasUsed}`);
  return rc;
}

const reg = await deploy("HourglassRegistry", [parseEther("1"), 86_400n]);
const exam = await deploy("ZeroHourExam", [reg.contractAddress]);
console.log(JSON.stringify({ hourglass: reg.contractAddress, hourglassBlock: reg.blockNumber.toString(), exam: exam.contractAddress, examBlock: exam.blockNumber.toString() }));
