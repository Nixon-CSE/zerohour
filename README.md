# ZeroHour

**Exam papers that no printer, courier or exam centre can open before the bell.**
A post-quantum time lock on QoreChain, built for *Build Before Q-Day* (Encrypted Apps).

Live: **https://zerohour-exam.vercel.app** · every number on the site is read from QoreChain testnet and re-checked in your browser.

---

## Try it in two minutes

1. Open the [Public exam of 20 Nov](https://zerohour-exam.vercel.app/exam/?id=0x53cf9dc20c56b3abec5f0763981dab01f541fdb78cff5bc650c0c9d80e8670b0).
   The bell was at 17:50 UTC; three bonded keypers posted their seeds 12–13 s later.
2. On the **Judges' centre** card press **Open it yourself**, then **Use the judges' key**, then **Open paper**.
   That centre's decryption key is public on purpose ([`deployments/demo/judge-centre.json`](deployments/demo/judge-centre.json)).
   Your browser fetches the public ciphertext, checks it against the hash on chain, rebuilds the time key
   from the keypers' public seeds, and decrypts with the centre's ML-KEM-1024 key. Nothing is sent anywhere.
3. Under the paper it confirms two things: this is **the copy that centre signed for on chain**, and it is
   **exactly the copy rebuilt from the board's public fairness reveal**.

## The problem

Paper leaks cancel national exams: millions of students re-sit, months are lost. The leak is rarely the
exam board; it is someone among the thousands who handle the paper between the printer and the hall.
ZeroHour removes the readable paper from all of them until the bell.

## How it works

```
 board ──seals──▶ each centre's copy (its own question + option order)
                   lock 1: time key, Shamir 2-of-3 to the keypers' round-r ML-KEM-1024 keys
                   lock 2: QoreSeal (ML-KEM-1024 + X25519) to that centre's on-chain key
 ciphertexts public weeks ahead ─────────────────────────────────────────────▶ anyone mirrors them
 bell (round r, judged by block time) ──▶ keypers post 32-byte seeds ──▶ lock 1 opens for everyone
 each centre opens lock 2 with its own key ──▶ signs a receipt naming the paper's hash (ML-DSA-87)
 after the exam ──▶ board reveals paper + orders ──▶ anyone rebuilds every copy and checks the receipts
```

| Piece | What it is |
|---|---|
| [`contracts/`](contracts) | `HourglassRegistry` (bonded keypers, hash-chain seeds, commit-reveal slashing) and `ZeroHourExam` (exams, per-centre ciphertext hashes, backup switch, receipts, leak reports, fairness reveal). Every board, centre, keyper and Leak Hunter action is authorised by **ML-DSA-87** through QoreChain's `pqcVerify` precompile; classical keys carry no authority. No owner, no admin. |
| [`packages/hourglass`](packages/hourglass) | The crypto: seed chains, ML-KEM-1024 round keys with Merkle commitments, two-lock sealing, per-centre variants, leak tracing. Runs unchanged in Node and the browser. |
| [`apps/keyper`](apps/keyper) | The keyper daemon. Releases a round only once **chain** time passes it, never leaks a seed through gas estimation, and refuses to run on a chain that does not match its registry record. |
| [`apps/demo`](apps/demo) | Drives every real run below: board, centres, keypers, Leak Hunter, whistleblower. |
| [`apps/web`](apps/web) | The static site and the centre console. No backend. |

### The Leak Hunter (AI)

A leaked paper usually surfaces as a phone photo. Claude Opus 5.5 reads the photo (transcription only, strict
JSON schema; it never sees the centre list). Deterministic code then matches the questions and traces their
order against every centre's copy, and against the setters' master copy. A centre is accused only at ≥ 99%
posterior; a match on the master copy accuses no centre and recommends switching to the backup paper.
Details: [`apps/demo/README.md`](apps/demo/README.md).

## Real runs on testnet

| Exam | What it shows |
|---|---|
| [Demo, 15 Nov](https://zerohour-exam.vercel.app/exam/?id=0xe54bb5d08c756ff06bdeb69145566653781d71644beecc8c0c47e3abd6b2b1ed) | The full cycle. Later, a **real iPhone photo** of a leaked page was traced to Pune-17 at posterior 1.0 out of 1,000 centres, and the signed report filed on chain. |
| [Bribery, 21 Nov (v2)](https://zerohour-exam.vercel.app/exam/?id=0x6be0830d95f076da06e0294c2b22d40e86879fe8bbb82c2cccdb1bef970325ae) | A keyper sold its seed 16 min early. One seed opened nothing (locked 1/2); a whistleblower proved it on chain and the keyper's bond was **slashed** (half to the whistleblower, half burned). Its daemon then refused to run, and the exam opened on time without it. First run on v1: [16 Nov](https://zerohour-exam.vercel.app/exam/?id=0x2db24058ffccbd8251cc5cf93396a5d0c4c9dd0a8b6a2379bdfc7b064399c716). |
| [Backup, 21 Nov (v2)](https://zerohour-exam.vercel.app/exam/?id=0x4da31f8134603dfccaaa4fa59a19c4d7f501a47acfd20f407260e476803ed94f) | A page of paper A leaked **before** its bell in the setters' own order. The Leak Hunter accused no centre; the board moved every centre to backup paper B in one signed transaction, 14 min before A's bell; B opened at its own bell for all three centres. First run on v1: [20 Nov](https://zerohour-exam.vercel.app/exam/?id=0x4c518322756d385729bea2e801f332b1b2aba2a7e100d7bc65f71585faae889a). |
| [Public, 20 Nov](https://zerohour-exam.vercel.app/exam/?id=0x53cf9dc20c56b3abec5f0763981dab01f541fdb78cff5bc650c0c9d80e8670b0) | First exam on the audited **v2** contracts, with the judges' centre. Every receipt matches the reveal. |
| [Outside keyper, 21 Nov](https://zerohour-exam.vercel.app/exam/?id=0x7bc70985a00c7ee5e22f067b1bec43162eeb73f6c16be0afa3eaf6542790658b) | 3 of 3, and the third keyper only ever sent the board its **public** round keys with Merkle proofs, each checked against its on-chain root. All three released 7-11 s after the bell. That keyper is a test account we run ourselves; no other team has joined yet. An [earlier attempt](https://zerohour-exam.vercel.app/exam/?id=0x74c361d34ccfddf0f48a4a810c27eaf5ebf10a98658c851b5fe5a84b30bfcfd5) released 6 min late because the one laptop running all three keypers fell asleep: the lock held, but liveness needs keypers on independent machines. |

Each run's transactions are in `deployments/demo/<id>/run.json`. Contract addresses: [`deployments/testnet.json`](deployments/testnet.json).

## What it does not protect against

- **The exam board.** It writes the paper, so it can read it. ZeroHour removes the paper from everyone after the
  board. Splitting authorship across setters is the next step.
- **Keypers and a centre colluding.** A keyper can hand over its decrypted piece of one paper without leaving
  evidence the contract can check; the bond only catches leaked *seeds*. Reading early still needs the
  threshold of keypers **and** a centre's key, and a paper leaked through a centre carries that centre's order.
  Independent keypers are the real defence; today all three are run by us.
- **Testnet scale.** Bonds are 1 test QOR; two real centres plus a judges' centre; 998 of the 1,000 traced
  centres are simulated.

The full threat model is in [THREAT_MODEL.md](THREAT_MODEL.md) and on the [Security page](https://zerohour-exam.vercel.app/security/).
On 20 Nov we audited our own code, proved four contract flaws with tests, and redeployed as v2
([AI_USAGE.md](AI_USAGE.md#the-self-audit-20-nov)).

## Verify and run

```bash
cd contracts && forge test                 # 31 tests, incl. fuzzing and the audit regressions
cd packages/hourglass && npm i && npm test # 11
cd apps/keyper && npm i && npm test        # 11
cd apps/demo && npm i && npm test          # 8 Leak Hunter tests, no API key needed
cd apps/web && npm i && npm run dev        # the site against live testnet
```

Run your own keyper on testnet in about five minutes: [`apps/keyper/README.md`](apps/keyper/README.md).

## Q-Day Drill

The drill account handed its ECDSA key to the organisers' attacker bot on 18 Nov. Nothing was taken:
every action that matters needs its ML-DSA-87 key, and its EVM windows are scoped to the registry.
That account still runs keyper #1.

## Credits

Everything in this repository was written during the fest (from 4 Nov 2026). It builds on these open-source
libraries, kits and templates:

- **QoreChain:** `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/pqc` (ML-DSA-87, ML-KEM-1024) and
  `@qorechain/qoreseal`. The EVM-window helper follows the pattern of the `create-qorechain-dapp` Foundry
  template's `scripts/window.ts`. The `pqcVerify` and `pqcKeyStatus` precompiles are QoreChain's.
- **Contracts:** [Foundry](https://github.com/foundry-rs/foundry) and `forge-std`.
- **Crypto and chain clients:** [`shamir-secret-sharing`](https://github.com/privy-io/shamir-secret-sharing),
  [viem](https://viem.sh), [CosmJS](https://github.com/cosmos/cosmjs) (`@cosmjs/stargate`).
- **Website:** [Next.js](https://nextjs.org), React, Tailwind CSS, [shadcn/ui](https://ui.shadcn.com) on
  Radix UI, lucide-react, three.js with React Three Fiber and drei.
- **Leak Hunter:** Claude (Anthropic) reads the photo through Claude Code or `@anthropic-ai/sdk`; `zod` for the
  output schema.

The exam papers in `apps/demo/papers` are original mock questions written for this demo.

## How it was built

One developer with Claude Code. The workflow, what the AI generated, what the human did, and the mistakes
the agent caught in its own work are in [AI_USAGE.md](AI_USAGE.md).

MIT licence.
