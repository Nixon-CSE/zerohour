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
```

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
