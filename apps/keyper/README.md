# zerohour-keyper

The Hourglass keyper daemon. A keyper holds one 32-byte secret, the top of a hash chain.
Every 5 minutes a new round "opens", and the keyper publishes that round's seed on QoreChain.
Any paper sealed to round *r* needs ≥ *t* keypers' round-*r* seeds, so nobody can open it
before then, the keypers included, unless *t* of them collude. A keyper who publishes a seed early
can be **slashed**: anyone holding the early seed can commit-reveal it and take half the bond.

## The one rule

**A round's seed never leaves this machine before chain time passes its unlock time.**
This rule covers eth_call and gas estimation (the RPC operator sees calldata) as well as
reverted transactions. The daemon gates on the **latest block's timestamp** plus a safety
margin, checks the gate again on a fresh block right before it derives the seed, and verifies the seed
against the on-chain `lastHash` locally before sending anything.

## Run a keyper (testnet, about 5 minutes)

```bash
cd apps/keyper && npm install
npx tsx src/cli.ts new        # fresh account -> ~/.zerohour-keyper/account.secret.json
#   fund the printed qor1… address: https://dashboard.qorechain.io/faucet
npx tsx src/cli.ts setup      # ML-DSA-87 key, seed chain, ML-DSA-signed register + 1 QOR bond
npx tsx src/cli.ts run        # daemon: releases every exam round the moment it is due
```

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
