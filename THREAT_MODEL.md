# ZeroHour threat model

What ZeroHour protects, from whom, how, and where it stops. Every "live" claim below names the code
that enforces it and, where one exists, the testnet transaction that shows it happening.
Contracts referred to are the audited **v2** ones (`deployments/testnet.json`).

## 1. What we protect

| Asset | Property | Until |
|---|---|---|
| Each centre's question paper | Nobody but the board can read it | The exam bell (round *r* on chain time) |
| The same paper after the bell | Only that centre can read its copy | The fairness reveal after the exam |
| Fairness | Every centre got the same questions, and the copy it opened is the one committed before the exam | Forever (public, re-checkable) |
| Accountability | An early seed costs its keyper the bond; a leaked copy names its centre | Forever |

## 2. Parties and what each is trusted with

| Party | Trusted to | Not trusted to |
|---|---|---|
| Exam board | Write the paper and backup; run the switch and reveal honestly | Nothing below depends on the board keeping the paper secret from *others* |
| Keypers (*n*, threshold *t*) | Fewer than *t* collude; at least *t* are online at the bell | Any single keyper is honest |
| Centres | Guard their own ML-KEM-1024 key | Open anything early, or another centre's copy |
| Printer, courier, strongroom, mirrors | Nothing | They only ever hold ciphertext |
| QoreChain validators | Block timestamps roughly track real time; the PQC precompiles are correct | Anything about paper content |
| Leak Hunter model (Claude) | Transcribe a photo | Accuse anyone: code decides, at ≥ 99% posterior, only on operator request |

## 3. Threats and defences

| # | Threat | Defence | Enforced by | Status |
|---|---|---|---|---|
| T1 | Someone at the press, in transport or in a strongroom copies the paper | They hold ciphertext only. Lock 1 (time) needs *t* keyper seeds that do not exist publicly before the bell; lock 2 needs the centre's key | `packages/hourglass/src/seal.ts` | Live |
| T2 | A centre opens early | Its key opens only lock 2 of its own envelope. `recordOpening` reverts `NotUnlocked` before *t* seeds | `ZeroHourExam.recordOpening`, test `test_nobodyOpensBeforeThreshold` | Live |
| T3 | One keyper leaks its seed early | One seed opens nothing. Anyone holding it commits, then reveals; the contract checks the seed against the keyper's chain and that the commit predates the round, then pays half the bond to the reporter and burns half. Commit binds the reporter, so it cannot be front-run | `HourglassRegistry.revealReport`; tests `test_earlyLeak_isSlashed_reporterPaidHalf`, `test_report_cannotBeFrontRun` | Live: keyper slashed on 16 Nov, tx `0xa5cdae7f…023a` |
| T4 | *t* keypers trade seeds | Every accomplice can turn the others in for half a bond | as T3 | Live |
| T5 | *t* keypers trade **decrypted pieces** for one paper instead of seeds | Not slashable: the contract cannot verify a piece, and any check we could add would let the board (who created the pieces) frame keypers. The defence is lock 2: pieces open nothing without a centre's key, so an early read needs *t* keypers **and** a corrupt centre, and the leaked copy carries that centre's order (T8). Independent keypers raise the bar | Design | Residual risk, stated |
| T6 | A keyper is offline at the bell | Any *t* of *n* open it | `ZeroHourExam.isUnlocked` | Live (2 of 3) |
| T7 | The paper leaks before sealing (setting room) | Only the master copy has the canonical order. The Leak Hunter traces against it and every centre; a master match accuses no centre and recommends the switch. The board moves every centre to backup B (sealed to a later round) in one ML-DSA-87 signed call; the reason on chain is the hash of the published evidence | `apps/demo/src/hunter.ts`, `ZeroHourExam.switchToBackup` | Live: 20 Nov, tx `0x2c4e1503…8d40`, 13 min before the bell |
| T8 | A centre leaks after opening (or before, via T5) | Every centre's copy has its own question and option order. A few questions from a photo name the centre at ≥ 99% posterior; the Leak Hunter files an ML-DSA-87 signed report with sealed evidence | `hunter.ts`, `ZeroHourExam.reportLeak` | Live: real phone photo → Pune-17, tx `0xf9ffec97…d95f` |
| T9 | The board seals a centre something other than the committed paper | Each v2 receipt signs keccak256 of the exact plaintext the centre decrypted. After the reveal anyone rebuilds that copy and compares | `ZeroHourExam.receiptOf`, `apps/web/src/lib/exam.ts verifyFairness` | Live: exam `0x53cf9dc2`, 3/3 receipts match |
| T10 | A ciphertext file is swapped | Each copy's hash is on chain before the exam; console and demo refuse a mismatch | `addCentre`, `sealedFor` | Live |
| T11 | The board seals to an attacker's key | Centre keys are read from QoreChain's KEM registry and bound to the account by a hybrid-signed recipient card | `@qorechain/qoreseal resolveRecipient` | Live |
| T12 | Harvest now, decrypt later | Locks are ML-KEM-1024 (and QoreSeal's ML-KEM-1024 + X25519 hybrid), symmetric layers AES-256-GCM, authority ML-DSA-87. EVM transactions are still ECDSA-signed but carry no authority | All contracts | Live |
| T13 | A seed leaks to the RPC operator before its time (eth_call, gas estimation, a reverted tx) | The daemon gates on the latest block's timestamp, rechecks on a fresh block, verifies the seed locally and never estimates gas with a seed | `apps/keyper/src/schedule.ts`, `daemon.ts` | Live |
| T14 | A keyper's ECDSA key is stolen | ECDSA has no authority: register, exit and withdraw need ML-DSA-87, release needs the seed, and the withdraw recipient is inside the signature. Windows are scoped to the registry | `HourglassRegistry`; test `test_qdayDrill_classicalKeyAloneCannotDrain` | Live: Q-Day Drill 18 Nov, nothing taken from the account that runs keyper #1 |
| T15 | Someone squats an exam id or fakes the threshold with a duplicated keyper | v2 derives the id from (board, label) and rejects duplicate, unregistered, slashed or off-clock keypers | `createExam`, `_checkKeypers`; v2 regression tests | Live |
| T16 | An exited keyper re-registers to replay old signatures | v2 retires a keyper for good on withdrawal | `HourglassRegistry.retired`; v2 regression tests | Live |
| T17 | Prompt injection in a leaked photo steers the Leak Hunter | The model only transcribes; it never sees centres or variants. Matching, tracing and the filing rule are code; framing a centre needs its secret order | `hunter.ts` | Live |
| T18 | The exam board leaks the paper itself | Not prevented: the board writes it. Detected if the leak is in the master order (T7); unequal papers are caught by T9 | — | Next: multi-setter sealing |

## 4. Residual risks we accept today

1. **The board can read the paper** (T18). Next step: split authorship so no single setter holds a whole paper.
2. **Piece-trading keypers are not slashable** (T5). Defence is lock 2 plus keyper independence.
3. **All three keypers are run by us.** Independence is the point of a keyper set; recruiting outside keypers is in progress.
4. **Testnet economics.** Bonds are 1 test QOR; a real exam would set bond and threshold far higher.
5. **Block time.** Validators collectively choose timestamps; a skew of seconds moves the bell by seconds.
6. **The centre console takes a centre's recovery phrase**, which also controls its account. Acceptable for the
   judges' centre (public on purpose); a real centre should load only its decryption key.
7. **Leak tracing is closed-world.** The posterior ranks the candidate set; 998 of the 1,000 traced centres are simulated. A leaker who re-orders questions evades attribution (but cannot frame another centre).

## 5. Audit log

| Date | Finding | Result |
|---|---|---|
| 15 Nov | `isUnlocked` ignored seeds revealed by a later release, locking an exam forever | Fixed, redeployed as v1 |
| 20 Nov | Release gas formula too low for long chain walks; daemon retried unchanged | Fixed, regression test from real receipts |
| 20 Nov | Self-audit: re-registration replay, duplicate keypers, squattable ids, one receipt per centre (each proved with a test); overclaims on fairness and collusion | v2 contracts deployed; site wording corrected |

Details: [AI_USAGE.md](AI_USAGE.md#the-self-audit-20-nov).
