# ZeroHour demo video: script and shot list

**Length: 2:50 (hard limit 3:00).** Screen recording at 1920×1080, browser zoom 110%, light theme.
Every shot is the live site, a real testnet transaction or a real terminal run. No mock-ups.
Voice-over is in plain sentences; read at a calm pace (about 140 words per minute; ~320 words, about 2:20 spoken, leaving room for the clicks).

Before recording: close other tabs, clear the browser cache once (so the bell page loads fresh), have the
terminal font at 18 pt, and open every URL below in its own tab in order.

| # | Time | Shot (what is on screen) | Voice-over |
|---|---|---|---|
| 1 | 0:00–0:15 | Landing page hero: the 3D hourglass, sand falling for the current round. Slow scroll to the tagline. | "Every year, exam papers leak somewhere between the printer and the exam hall, and millions of students sit the exam again. ZeroHour makes the paper unreadable to all of them until the bell." |
| 2 | 0:15–0:40 | [How it works](https://zerohour-exam.vercel.app/how/): the two-lock diagram, then the party table. | "Each exam centre gets its own copy, sealed twice. The time lock opens only when keypers post their seeds on QoreChain at the bell. The second lock is the centre's own ML-KEM-1024 key. Everything is post-quantum: ML-KEM for the locks, ML-DSA-87 for every signature." |
| 3 | 0:40–1:15 | [Public exam](https://zerohour-exam.vercel.app/exam/?id=0x53cf9dc20c56b3abec5f0763981dab01f541fdb78cff5bc650c0c9d80e8670b0): the bell clock, K1–K3 bubbles (+12 s, +13 s), centre cards. Click **Open it yourself** on the Judges' centre → **Use the judges' key** → **Open paper**. The paper appears; hover the two green checks. | "This is a real exam on QoreChain testnet. At the bell, three bonded keypers posted their seeds within thirteen seconds. You can open it yourself: this judges' centre's key is public on purpose. The browser rebuilds the time key from public seeds and decrypts in milliseconds. And it proves the copy is the one this centre signed for on chain, and exactly the copy rebuilt from the board's public reveal." |
| 4 | 1:15–1:40 | [Bribery exam](https://zerohour-exam.vercel.app/exam/?id=0x6be0830d95f076da06e0294c2b22d40e86879fe8bbb82c2cccdb1bef970325ae): the red **slashed** bubble, then the [ledger](https://zerohour-exam.vercel.app/ledger/) "Slashed keypers" card. | "What if a keyper is bribed? We tried. A keyper sold its seed sixteen minutes early. One seed opens nothing. A whistleblower proved it on chain, the contract took the keyper's bond, and the exam still opened on time." |
| 5 | 1:40–2:10 | Terminal: `npm run demo -- hunt <photo> --reader claude-code` on the iPhone photo (pre-recorded run, sped up 2×): Claude's transcription, `posterior 1.000000`, the `reportLeak` tx. Cut to the photo itself for one second. | "If a paper still leaks, it usually surfaces as a phone photo. Every centre's copy has its own question order. Claude reads the photo; plain code traces the order. This real photo named Pune-17 out of a thousand centres, and the signed report went on chain. The model reads, it never decides." |
| 6 | 2:10–2:30 | [Backup exam](https://zerohour-exam.vercel.app/exam/?id=0x4da31f8134603dfccaaa4fa59a19c4d7f501a47acfd20f407260e476803ed94f): the red "Paper A retired" card with the green "published evidence hashes to it". | "A leak before the bell can only come from the setting room. The Leak Hunter recognised the setters' own order, accused no centre, and the board moved every centre to a backup paper in one signed transaction, fourteen minutes before the bell." |
| 7 | 2:30–2:50 | [Security page](https://zerohour-exam.vercel.app/security/): scroll the threat table slowly, pause on the "residual risk" rows; end on the GitHub repo README. | "We also audited our own code, proved four contract bugs with tests, and redeployed. The threat model says plainly what ZeroHour does not stop. It is all open source and live on QoreChain. ZeroHour: no one opens the paper before the bell." |

## Shots to capture separately (B-roll)

- The iPhone photo of the leaked page (`secrets/demo/leaks/phone/IMG_4323.jpg`, show full screen for 1 s).
- Terminal Leak Hunter run: re-run the hunt live in a terminal and record it; cut the waiting time.
- Optional: a keyper daemon log scrolling `"event":"released"` at the bell (`secrets/demo/v2-logs/*.log`).

## After recording

- Export at 1080p, under 3:00. Upload unlisted to YouTube and paste the link on the project page and in the README.
- Add captions (YouTube auto-captions, then fix "keyper", "QoreChain", "ML-KEM").
- Shots 4 and 6 use the v2 bribery and backup exams of 21 Nov (re-run on the audited contracts).
