# ZeroHour consoles

A static site that reads QoreChain testnet straight from the browser. There is no ZeroHour
server. Every verdict on the page comes from a check your browser runs itself.

| Page | What it shows | What your browser verifies |
|---|---|---|
| `/` Landing | A 3D glass hourglass whose sand is the current 5-minute keyper round on chain time, with keyper orbs that turn solid when their seed is public. Below it: the problem, the two locks, the bell, Leak Hunter, live proof and an FAQ | Round progress from block time; keyper and release counts; the answer keys of two real centre variants, recomputed from the revealed seeds |
| `/how/` | The life of one exam, the cryptography, who can do what | n/a (reference) |
| `/security/` | Threat model with live/next status, a cost-of-corruption calculator, and what is real today | n/a (reference) |
| `/keypers/` | Bonded keypers, the rules, and how to run one | Each keyper's bond, `nextRound` and release history |
| `/live/` Bell | Countdown to the next exam bell, one OMR bubble per keyper (filled when its seed is public), every exam and keyper on chain | `isUnlocked` and each keyper's `nextRound`, read live |
| `/exam/?id=…` Board view | Centres, opening receipts, leak reports, the exam timeline from events, the fairness proof | Each published ciphertext against its on-chain `ctHash`; each leak envelope against `sealedEvidenceRef`; the canonical paper against `paperCommit`; permutation seeds against `permCommit`; and that each centre's variant reorders the same questions and answers |
| `/open/?id=…&centre=…` Centre console | The two locks, then the decrypted paper | The ciphertext hash; every seed hashed down to its keyper's anchor; ML-KEM-1024 decapsulation, Shamir combination and QoreSeal opening, all in the page |
| `/ledger/` Release ledger | Every `SeedReleased` on HourglassRegistry | Each seed against its anchor, and its block time against its round's unlock time (an early seed is slashable) |

```bash
cd apps/web && npm install
npm run dev        # http://localhost:3000
npm run build      # static export in out/; host it anywhere
```

`npm run sync` copies the committed public record (`deployments/`) into `public/` so the site
serves the exact files whose hashes are on chain. It never reads `secrets/`. It also snapshots
every contract event into `public/deployments/logs.json`, so the browser scans only blocks newer
than the snapshot (first data in about 2 s instead of about 10 s). All contract state is still read live.

Stack: Next.js 16 static export, Tailwind v4 with shadcn/ui (re-themed to the answer-sheet
inks), and three.js through react-three-fiber for the hero. The 3D scene uses procedural
lighting, so nothing is fetched at runtime, and it renders still when the viewer prefers reduced motion.

The centre console takes the centre's recovery phrase in a text box to derive its QoreSeal keys.
The phrase never leaves the page. A production centre would hold that key on a hardware device.
The RPC caps `eth_getLogs` at 10,000 blocks, so `src/lib/chain.ts` scans in parallel chunks.
