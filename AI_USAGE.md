# AI usage

ZeroHour was built in two days by one developer working with an AI coding agent, and it ships
an AI agent of its own. This file documents both: the workflow, the work the AI generated, and
what the human did. Every claim below points at a commit, a transaction or a test you can check.

| | |
|---|---|
| Agent | Claude Code (CLI), running Claude Opus 5.5, with Claude Fable 5.2 for part of the session |
| Agent tools | Shell, file editing, a headless browser (Playwright MCP) for visual and live-data checks, the Vercel MCP, the shadcn CLI, web research |
| Span | From 15 Nov 18:13 UTC, one commit per logical change (`git log`) |
| Code | about 5,900 lines: contracts 1,050 · hourglass 446 · keyper 698 · demo 893 · web 2,557 (excluding generated shadcn components) |
| Tests | 31 Foundry (incl. 7 audit regressions) · 10 hourglass · 9 keyper · 8 Leak Hunter, all passing |
| In the product | The Leak Hunter: Claude Opus 5.5 reads a phone photo of a leaked paper (see [AI inside ZeroHour](#ai-inside-zerohour-the-leak-hunter)) |

## The split, in one table

| | The AI did | The human did |
|---|---|---|
| Direction | Researched the hackathon rules, prizes and chain facts; proposed and red-teamed ideas over three rounds | Chose the hackathon as top priority, chose ZeroHour over the other candidates, set the bar ("must win") |
| Code | Wrote the contracts, the crypto library, the keyper daemon, the demo driver, the website and the Leak Hunter, with their tests | Read every diff before committing it |
| Git | Never ran `git commit` or `git push`; proposed one commit per logical change | Made every commit and every push |
| Chain | Deployed contracts and ran the demo exam from a throwaway testnet account | Funded that account from their own wallet, registered for the Q-Day Drill, chose the drill contracts |
| Secrets | Kept them in a gitignored `secrets/` folder; scanned the pushed repo for leaked secrets | Entered API keys in an editor, never in chat |
| Deploy | Rehearsed the build on a fresh clone, wrote the Vercel config, verified the live site | Imported the project into Vercel and set the domain |
| Real world | Rendered a test page for each centre | Took the phone photo the Leak Hunter traced |

## Workflow

The same loop ran for every part of the build:

1. **The human sets the goal and the constraints.** Constraints set early and kept to the end: only the
   human commits and pushes; testnet only; the drill account is a fresh throwaway, never the human's
   wallet; secrets stay in `secrets/`.
2. **The agent checks facts before it designs.** It read QoreChain's docs, precompile behaviour and the
   prize rules instead of assuming them. Examples: it measured that `eth_getLogs` is capped at 10,000
   blocks before writing the event scanner, and it probed the block explorer's real URL patterns
   rather than guessing them.
3. **It builds in small, testable pieces**, each ending in a passing test or a live check.
4. **It verifies against reality, not just the compiler.** Contracts were exercised on testnet, the
   website was checked in a real browser at desktop and phone width in light and dark mode, and the
   deploy was rehearsed on a fresh clone.
5. **The human reviews and commits** with messages the agent drafts, one per logical change.

## The generated work, phase by phase

| Phase | What the agent generated | Evidence |
|---|---|---|
| Contracts | `HourglassRegistry` (bonded keypers, hash-chain seeds, commit-reveal slashing) and `ZeroHourExam` (threshold unlock, per-centre ciphertexts, backup switch, signed receipts, leak reports, fairness reveal); keyper registration and every board, centre and Leak Hunter action is authorised by ML-DSA-87 via the `pqcVerify` precompile | `7ec0470`, `374c12a`, 24 Foundry tests including fuzzing and front-running |
| Crypto library | Seed chains, ML-KEM-1024 round keys with Merkle commitments, two-lock sealing (Shamir 2-of-3 + QoreSeal), per-centre variants, leak tracing | `9eb9979`–`210356f`, 10 tests |
| Keyper daemon | A release scheduler that gates on block time (never the local clock), registry-scoped EVM windows, a CLI | `28d319d`–`02d377e`, 8 tests |
| End-to-end run | Board, Leak Hunter, two centres and three keypers on testnet; exam `0xe54bb5d0` sealed, opened at the bell, traced and revealed | `863d72e`, `deployments/demo/0xe54bb5d0/run.json` |
| Website | Static site that verifies every claim in the browser; 3D hourglass hero driven by chain time; board view, centre console, release ledger | `52bbd46`–`ff7ac3a`, live at https://zerohour-exam.vercel.app |
| Leak Hunter | Vision reader, deterministic matcher, tracer and filing rule; offline tests; a real run from a phone photo | `3a18de0`–`c99ccb6`, 6 tests |
| Bribery and slashing | A fourth bonded keyper sells its seed before the bell; a whistleblower commit-reveals it and the contract slashes the bond; the exam still opens on time | `e02adbd`–`de4cff1`, `deployments/demo/0x2db24058/run.json` |
| Backup switch | The Leak Hunter recognises a leak in the setters' master-copy order (no centre accused); the board retires paper A in one signed transaction and backup B opens at its own bell | `deployments/demo/0x4c518322/run.json`, 2 more Leak Hunter tests |

## Mistakes the agent caught in its own work

Strong AI use is not "the AI wrote it". It is "the AI wrote it, then proved it wrong and fixed it
before it shipped". These were all found by the agent's own checks:

| What was wrong | How it was caught | Fix |
|---|---|---|
| `ZeroHourExam.isUnlocked` only looked at the seed stored for the exam's round. A keyper who released a later round first (which also reveals the earlier one) would leave the exam locked forever | Reasoning about how the keyper daemon skips rounds | `45ab1fc`: count a round as revealed once `nextRound` passes it, plus a regression test; contract redeployed as v1 |
| The demo's `--decoys` option parsed to 0, so leak tracing ran against no simulated centres | Checking the end-to-end run's output | Fixed option parsing; the trace then ran over 1,000 centres |
| The centre console could report "locked: 0/2" while all seeds were public | A browser test clicked before the seeds had loaded | The button now stays disabled until the time lock is actually open |
| The shared crypto code used Node's `Buffer`, which breaks in browsers | Planning the in-browser console | `ee1199c`: browser-safe byte helpers, all tests rerun |
| The first website build on Vercel would have failed: a fresh clone does not install the crypto package's dependencies | Rehearsing the build on a fresh clone before the first deploy | `ff7ac3a`: a Vercel install command |
| Live pages took about 10 seconds to show data | Timing the page in the browser | A build-time event snapshot; first data in 1.7 s |
| shadcn's generated components imported `cn` from a non-existent path | Typechecking after install | Fixed the imports in every generated component |
| Whole-word matching failed on OCR-style typos | A Leak Hunter test written to break it | Switched to character-trigram similarity; 6/6 tests pass |
| A keyper whose last release was far back ran out of gas on testnet: 1,296 hash steps against a limit from a 120 gas/step guess. The daemon then resent the same transaction 17 times | Reading the keyper logs after the backup exam's bell, then comparing gas used with the gas limit on the receipts | Gas formula fitted to real receipts (about 175 gas/step, plus 30%), out-of-gas retries get 1.5x gas, 3 reverts on one round stop the daemon, plus a regression test built from the receipts. The same release then succeeded using 306,997 gas, 1,477 over the old limit |
| The project page's tagline claimed the exam board cannot read the paper. It can, because it writes the paper | Comparing the tagline with the site's own threat model | The agent asked the human to correct it rather than overclaim |

## The self-audit (20 Nov)

Before the last stretch the human asked the agent to audit everything it had built. It read the
contracts, the crypto library, the daemon, the website and the full git history, then **wrote a
failing-by-design test for every suspected flaw before claiming it**:

| Finding | Severity | Proof | Fix |
|---|---|---|---|
| A keyper that exited and re-registered kept a stale `exitAt`, and old public withdraw signatures could be replayed to pull its new bond at once | Contract bug (never triggered: no keyper had re-registered) | Proof-of-concept test passed against v1 | v2 retires a keyper on withdrawal; regression tests |
| A duplicated keyper made a "2 of 2" exam open with one seed | Contract bug | Proof-of-concept test | v2 checks keyper sets on chain |
| Exam ids could be squatted by anyone who guessed the label | Contract bug | Proof-of-concept test | v2 derives the id from (board, label) |
| The fairness check rebuilt each copy from the revealed seed and then checked that copy, so it could never fail | Overclaim | Reading `verifyFairness` | v2 receipts sign the decrypted paper's hash; the page compares them with the reveal |
| Slashing catches a leaked *seed*, not a keyper handing over its decrypted piece of one paper | Overclaim in the site's threat table | Reasoning about what the contract can check | The site now says so, and why the second lock (a centre's key) is the real defence |
| A page said "nobody can open it, the exam board included" | Overclaim | Grepping every strong claim | Rewritten |
| The centre console asked for the centre's whole recovery phrase, which also controls its account | Key-handling flaw | Reading the console | It now takes only the decryption key and refuses phrases |
| Judges could not open a paper themselves | Gap | Looking for any public centre key | A judges' centre whose decryption key is public on purpose |

The same pass confirmed what holds: 0 of 25 real secrets anywhere in git history (checked by
deriving every key and searching the full history), no vulnerable production dependencies, all
15 commits cited here exist, and the landing page's real-run timeline matches block times to the
second. v2 was deployed on 20 Nov; v1 stays readable with the first three real runs.

## Guardrails that held

- **The agent never committed or pushed.** That was the human's rule from the start; every
  commit was made by the human after reading the change.
- **The agent did not get around a safety check.** When the permission system blocked it from copying a
  centre's recovery phrase out of `secrets/` for a test, it left the phrase alone, tested with a
  throwaway phrase, and asked the human to run the real one.
- **No secrets in git.** The agent scanned the pushed repository for mnemonics, private keys and
  `PRIVATE_KEY=`; none have been committed.
- **The API key stayed out of the chat.** It lives in a gitignored file, and the agent had the human
  type it in an editor rather than paste it into the conversation. The one key that did pass through
  the chat is the drill account's ECDSA key, a throwaway that the drill hands to an attacker bot and
  publishes anyway.
- **The agent says what is real.** The website's Security page marks every protection "Live" or
  "Next", and the leak-tracing claim says plainly that 998 of the 1,000 centres are simulated.

## AI inside ZeroHour: the Leak Hunter

A leaked exam paper usually surfaces as a phone photo. Every centre's paper has its own question and
option order, so a few questions from a photo can name the centre it came from. The Leak Hunter
does that, with the model on a short leash:

| Step | Done by | Trusted with |
|---|---|---|
| Read | Claude Opus 5.5, vision with a strict JSON schema | Transcribing what is printed. It never sees the list of centres or their variants, and never names a suspect |
| Match | Code | Mapping the transcription to the canonical paper; weak or ambiguous matches are dropped, not guessed |
| Trace | Code | A noisy-channel posterior over every centre's permutation |
| Decide | Code, plus a human flag | Filing only if the top match is a real centre at ≥ 99% **and** the operator passed `--file` |

The model reads; it does not judge. The decision depends only on deterministic code and the
transcription, which is saved in the sealed evidence so anyone with the photo can rerun it. The
reader runs through the Claude API or through headless Claude Code (`claude -p --json-schema`), with
the same instructions and schema either way.

### The real run

The human photographed Pune-17's page on a laptop screen with an iPhone: tilted, with screen moiré.

| | |
|---|---|
| Read | Questions 8–12 transcribed exactly; the model noted that no other questions were on the page |
| Match | 5/5 questions at similarity 1.00, plus the first printed option of each |
| Trace | Pune-17 at posterior 1.000000 out of 1,000 centres, 10/10 observations agreeing; the best simulated centre matched 4/10 |
| Filed | `reportLeak` [`0xf9ffec97…d95f`](https://explore.qore.network/tx/0xf9ffec970b797e001be19f2a34cefec4cde4b373c07576f575cc2ae09af2d95f), signed with the Leak Hunter's ML-DSA-87 key, confidence 99.99% on chain |
| Evidence | Photo hash, model, session id, raw transcription and ranking, sealed with QoreSeal to the exam board: `deployments/demo/0xe54bb5d0/leak-0x3739702e.sealed.json`. Only its hash is on chain |

Both leak reports and their evidence checks are visible on the
[board view](https://zerohour-exam.vercel.app/exam/?id=0xe54bb5d08c756ff06bdeb69145566653781d71644beecc8c0c47e3abd6b2b1ed).

### The second real run: a leak before the bell

On 20 Nov a page of paper A in the setters' own question order leaked 14 minutes before its bell.
Claude read Q8–12 exactly; the code matched them to the master copy at posterior 1.000000 (10/10),
while the closest of 1,000 centre copies matched 4/10. No centre ever holds that order, so the Leak
Hunter accused nobody and wrote switch evidence instead. The board, not the model, made the call:
`switchToBackup` [`0x2c4e1503…8d40`](https://explore.qore.network/tx/0x2c4e1503476777c6d55d11d431e7dc851380a7b72449f5818e519eaca2318d40),
whose on-chain reason is the keccak256 of the published evidence file. Backup paper B opened at its
own bell and both centres decrypted it. The
[exam page](https://zerohour-exam.vercel.app/exam/?id=0x4c518322756d385729bea2e801f332b1b2aba2a7e100d7bc65f71585faae889a)
re-hashes the evidence in your browser.

## Check it yourself

```bash
git log --format='%h %ad %an %s' --date=iso             # every commit, all by the human
cd contracts && forge test                               # 31 tests
cd packages/hourglass && npm test                        # 10 tests
cd apps/keyper && npm test                               # 9 tests
cd apps/demo && npm test                                 # 8 Leak Hunter tests, no API key needed
cd apps/demo && npm run demo -- hunt <photo> --reader claude-code   # the Leak Hunter on your own photo
```

## What the human did not do

So the record is accurate in both directions: the human did not write most of the code by hand. The
human's work was choosing the problem, setting the rules the agent worked under, holding the keys and
the wallet, taking the real-world actions (funding, drill registration, deployment, the photo),
reviewing each change, and committing it.
