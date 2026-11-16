# ZeroHour end-to-end demo (QoreChain testnet)

One script drives a full exam through the real contracts, keys and precompiles on
`qorechain-diana`: no mocks and no local chain.

| Actor | Account | What it holds on chain |
|---|---|---|
| Exam board | `0xe1FD768beFA0516Ef3dBf7bFc80aAC471298F9dA` | ML-DSA-87 key. It relays every EVM tx through a window **scoped to ZeroHourExam** |
| Leak Hunter | `0x1A691732d5056Af8628883732E4240817514Fde3` | ML-DSA-87 key, the only signer `reportLeak` accepts |
| Centre Pune-17 | `0x13e39273957F818746Fd38384374F3ff850E2E8f` | ML-DSA-87 key, an ML-KEM-1024 key in the KEM registry, and a signed QoreSeal recipient card |
| Centre Patna-05 | `0xB82Be3565EA2C31475D791778F8C1eEF6338dce9` | same as Pune-17 |
| Keypers #1, #2, #3 | `0x104C…2bc1`, `0x17aB…5BbA`, `0x2E54…ab06` | 1 QOR bond each, a seed-chain anchor and an ML-KEM `pkRoot`, all on one 300 s clock |

## Run it

```bash
cd apps/demo && npm install
npm run demo -- actors          # fund + register keys for board, hunter, centres
npm run demo -- keypers         # keypers #2/#3 join keyper #1's clock
# in 3 terminals: (cd apps/keyper && KEYPER_HOME=… npx tsx src/cli.ts run)
npm run demo -- exam --in 10    # seal + createExam + addCentre; ciphertexts published to deployments/demo/
npm run demo -- open centre-pune-17     # before the bell: "locked: 0/2". After: decrypts and posts a signed receipt
npm run demo -- leak centre-patna-05    # a 4-question "photo" is traced to 1 of 1,000 centres and a signed report is filed
npm run demo -- reveal          # canonical paper + permutation seeds are published and fairness is proven on chain

# Leak Hunter on a real image
npm run demo -- photo centre-patna-05 --from 3 --to 7     # renders a page of that centre's copy to photograph
npm run demo -- hunt leak.jpg --reader claude-code        # dry run via Claude Code (your Claude plan, no API credits)
npm run demo -- hunt leak.jpg                             # dry run via the Claude API (ANTHROPIC_API_KEY in secrets/anthropic.env)
npm run demo -- hunt leak.jpg --reader claude-code --file # also seal the evidence and file reportLeak
```

### Bribery: a keyper sells its seed and loses its bond

Everything here is on testnet, with real accounts, a real bond and the honest keyper daemon.

```bash
npm run demo -- actors                       # adds the whistleblower: its own account and ML-DSA-87 key
npm run demo -- keypers                      # keyper #4 joins the shared clock with a 1 QOR bond
EXAM_STATE=bribery npm run demo -- exam --in 20 --keypers 1,2,4 --kind bribery
# run the keyper daemons for #1, #2 and #4 (apps/keyper: npx tsx src/cli.ts run)
EXAM_STATE=bribery npm run demo -- bribe 4   # keyper #4 hands its exam-round seed to a briber before the bell
EXAM_STATE=bribery npm run demo -- whistleblow ../../secrets/demo/bribery/leak-k4-r<round>.json
```

1. **The bribe is real.** The seed is derived from keyper #4's own chain secret and checked against its
   on-chain chain head before it changes hands.
2. **It buys nothing alone.** The briber tries it on a published ciphertext and gets `locked: 1/2`.
3. **Anyone holding it can cash it in.** The whistleblower commits a hash binding (keyper, round, seed,
   salt, its own address), so nobody can copy the report from the mempool, then reveals.
4. **The contract slashes.** It checks the seed against the keyper's committed chain and that the commit
   came before the round opened, then sends half the bond to the whistleblower and burns the other half.
5. **The keyper is finished, the exam is not.** Keyper #4's daemon sees the slash and stops for good;
   the contract would refuse its releases anyway. At the bell keypers #1 and #2 open the exam as normal.

### How the Leak Hunter decides

| Step | Done by | What it does |
|---|---|---|
| Read | Claude Opus 5.5 (vision, structured output; through the Claude API or headless Claude Code, same instructions and JSON schema) | Transcribes printed question numbers, text and option order. It never sees the centre list or the variants, and never names a suspect |
| Match | Code | Maps each transcribed question to the canonical paper by trigram similarity; weak or ambiguous matches are dropped |
| Trace | Code (`packages/hourglass`) | Noisy-channel posterior over every centre's permutation (real centres plus simulated ones for scale) |
| Decide | Code | Files only if the top match is a real centre at ≥ 99% posterior **and** the operator passed `--file` |

The sealed evidence records the photo's keccak hash, the model id, the API response id and the raw
transcription, so anyone holding the photo can rerun the match and trace and get the same answer.
A test run on a tilted, slightly blurred photo of Patna-05's page read all five questions, matched each
at 1.00, and named Patna-05 at posterior 1.000000 out of 1,000 centres (10/10 observations; the best
simulated centre matched 5/10). `npm test` covers match, trace and decide without an API key (clean photo, OCR typos, one question,
unrelated text, illegible photo, and a different centre's copy).

## What each step proves

1. **The board seals only to keys it verified.** Each keyper's round key comes with a Merkle proof
   against that keyper's on-chain `pkRoot`. Each centre's key is read from QoreChain's KEM registry
   and bound to the account by its hybrid-signed recipient card.
2. **The ciphertexts are public before the exam.** `deployments/demo/<exam>/sealed/` is committed
   with `ctHash` on chain. Anyone can hold a copy, and nobody can open it.
3. **Nobody opens early.** Before the round, `open` fails with `locked: 0/2 keyper seeds released`,
   even for the centre holding the right key. The receipt call (`recordOpening`) reverts with
   `NotUnlocked`.
4. **At the bell, the opening happens on its own.** The keyper daemons release their seeds without anyone acting. The centre then
   checks the ciphertext against the on-chain `ctHash`, decrypts, and files an ML-DSA-signed receipt.
5. **A leak is attributable.** Four questions from a leaked copy single out the source centre. The
   evidence is QoreSeal-sealed to the board, and only its hash goes on chain, signed by the Leak Hunter.
6. **Every centre's variant is fair.** After the exam, the board reveals the canonical paper and the
   permutation seeds. Anyone can recompute every centre's variant and check both commitments.

The mock papers in `papers/` are original questions written for this demo.
