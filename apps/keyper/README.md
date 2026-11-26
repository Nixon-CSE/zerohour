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

Then send `my-round-keys.json` and your `0x…` address to the ZeroHour board with the
[**Become an outside keyper** issue form](https://github.com/Nixon-CSE/zerohour/issues/new?template=become-a-keyper.yml),
right after exporting: the file covers the next 48 hours, and we schedule your exam's bell inside that window and
inside the time you say your daemon will be running (keep `run` going until then, on a machine that will not sleep).
The board checks every key against **your** `pkRoot` on chain before sealing to it
(`npm run demo -- exam --outside my-round-keys.json`), so a tampered file is refused.
Your keyper then appears on the [Keypers page](https://zerohour-exam.vercel.app/keypers/) and in the
exam's bubbles at the bell.

What you risk: the 1 test-QOR bond, and only if a seed of yours is published before its round. The daemon
never does that (see the rule above). To leave: `exit`, wait a day, `withdraw`.

| Command | What it does |
|---|---|
| `status` | account, balance, EVM window, bond, next round and when it unlocks |
| `run [--heartbeat N] [--dry-run]` | watch `ExamCreated` for exams that list you; release their rounds on time. `--heartbeat N` also posts the current round whenever N rounds are unrevealed (default 288, once a day, so no release walks a long chain; `0` = exam rounds only). Backup rounds of exams that never switched are skipped |
| `release-now [--dry-run]` | one-shot release of the current round |

## Run it always-on (a server)

A keyper must be online at every bell. On any Ubuntu server (we use an Azure student VM):

```bash
curl -fsSL https://raw.githubusercontent.com/Nixon-CSE/zerohour/main/apps/keyper/deploy/setup-vm.sh -o setup-vm.sh
sudo bash setup-vm.sh                      # Node 20, the code, a login-less user, the systemd unit
# put KEYPER_MNEMONIC="…" and KEYPER_CHAIN_SECRET='{…}' in /etc/zerohour/keyper-1.env (root, 0600)
sudo systemctl enable --now zerohour-keyper@1
journalctl -u zerohour-keyper@1 -f         # releases, heartbeats, errors
```

The unit restarts the daemon after a failure (at most three times an hour, so a failing release cannot burn gas in a
loop), never restarts a slashed keyper, starts at boot, and can write only its own state directory.
`deploy/push-secrets.py` streams the two secrets over SSH into that root-only file without printing them.
Add `BEACON_EVERY=3` to the env file to also release every third round (every 15 minutes): the public beacon that
messages sealed on the site's "Seal a message" page open with. It costs about 0.0068 test QOR per release with
multi-transaction windows; a keyper that opens a window per release pays a flat 0.1 QOR window fee each time, so
keep the beacon on keypers with normal windows. A container
image is in `Dockerfile` (secrets from the same two environment variables). Run each keyper in exactly one place.

## Agent mode: keep the recovery phrase off the server

A server that releases seeds does not need the account's recovery phrase. With QoreChain smart accounts the keyper
links an ed25519 **agent key** whose spending rule allows exactly one call, `HourglassRegistry.release`
(`0x020908fe`), and no value; a low-value **relayer** account pays the native fee.

```bash
npx tsx src/cli.ts agent-new                 # agent key + relayer account (fund the relayer with ~2 test QOR)
npx tsx src/cli.ts agent-link --days 29      # owner-signed (ML-DSA-87): the release-only rule + the link
npx tsx src/cli.ts agent-probe               # optional: the agent tries 3 forbidden calls; the chain refuses each
npx tsx src/cli.ts agent-revoke              # owner-signed: disable the agent key at once
```

On the server set `KEYPER_MODE=agent`, `KEYPER_ADDRESS=0x…`, `KEYPER_AGENT_KEY` and `RELAYER_MNEMONIC` instead of
`KEYPER_MNEMONIC`. Re-link before the expiry (the chain caps a link at about 30 days). An agent release costs about
0.058 test QOR (the relayer's hybrid-signed native transaction), against about 0.007 for a release on a shared
100-transaction window, so a keyper that releases every few minutes may prefer window mode. A stolen agent key can
only post seeds; the seed chain on the server is still the thing to protect.

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
