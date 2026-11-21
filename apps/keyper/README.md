# zerohour-keyper

The Hourglass keyper daemon. A keyper holds one 32-byte secret, the top of a hash chain.
Every 5 minutes a new round "opens", and the keyper publishes that round's seed on QoreChain.
Any paper sealed to round *r* needs ≥ *t* keypers' round-*r* seeds, so no centre can open it
before then. Keypers cannot read papers either: each copy is also sealed to its centre's own key. A keyper who publishes a seed early
can be **slashed**: anyone holding the early seed can commit-reveal it and take half the bond.

## The one rule

**A round's seed never leaves this machine before chain time passes its unlock time.**
This rule covers eth_call and gas estimation (the RPC operator sees calldata) as well as
reverted transactions. The daemon gates on the **latest block's timestamp** plus a safety
margin, checks the gate again on a fresh block right before it derives the seed, and verifies the seed
against the on-chain `lastHash` locally before sending anything.

## Become an outside keyper (testnet, about 10 minutes)

A keyper set only means something if its members are independent. If you run one, a real ZeroHour exam
will depend on your seeds: the board seals every centre's paper partly to your round keys, and your daemon
opens it at the bell. You never see a paper (each copy is also sealed to its centre), and we never see your
secrets: you send us only public keys.

```bash
git clone https://github.com/Nixon-CSE/zerohour && cd zerohour/apps/keyper
npm ci --prefix ../../packages/hourglass && npm ci      # Node 20+

npx tsx src/cli.ts new        # 1. fresh account -> ~/.zerohour-keyper/account.secret.json (never share it)
#                               2. fund the printed qor1… address with ~2 test QOR:
#                                  https://dashboard.qorechain.io/faucet
npx tsx src/cli.ts setup      # 3. registers your ML-DSA-87 key, creates a 60-day seed chain on the shared
                              #    ZeroHour clock, signs the registration and posts the 1 QOR bond
npx tsx src/cli.ts export-pk --hours 48 --out my-round-keys.json
#                               4. PUBLIC: your next 48 h of ML-KEM-1024 round keys with Merkle proofs
npx tsx src/cli.ts run        # 5. leave it running: it releases each exam round the moment it opens
```

Then send `my-round-keys.json` and your `0x…` address to the ZeroHour board (open an issue on the repo).
The board checks every key against **your** `pkRoot` on chain before sealing to it
(`npm run demo -- exam --outside my-round-keys.json`), so a tampered file is refused.
Your keyper then appears on the [Keypers page](https://zerohour-exam.vercel.app/keypers/) and in the
exam's bubbles at the bell.

What you risk: the 1 test-QOR bond, and only if a seed of yours is published before its round. The daemon
never does that (see the rule above). To leave: `exit`, wait a day, `withdraw`.

| Command | What it does |
|---|---|
| `status` | account, balance, EVM window, bond, next round and when it unlocks |
| `run [--heartbeat N] [--dry-run]` | watch `ExamCreated` for exams that list you; release their rounds on time. `--heartbeat N` also posts the current round whenever N rounds are unrevealed |
| `release-now [--dry-run]` | one-shot release of the current round |

## Security properties

- **Scoped EVM window.** Every EVM transaction on QoreChain needs a window opened by a
  hybrid (ECDSA + ML-DSA-87) native message. The daemon opens windows **scoped to the
  Hourglass registry only**, so a stolen ECDSA key cannot move funds through the EVM lane.
  On drill day, our ECDSA key is published to the attacker bot on purpose.
- **Self-check at start.** The daemon refuses to run if the local chain's anchor, genesis,
  round length or length differs from the registry record, or if the keyper was slashed.
- **Chain time is authoritative.** Local clock skew of more than 60 s is logged, never trusted.
- Logs go to `~/.zerohour-keyper/releases.jsonl`, and the exam-scan cursor goes to `state.json`.

Env overrides are documented in [`src/config.ts`](src/config.ts).
