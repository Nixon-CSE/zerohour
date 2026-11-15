"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef } from "react";
import { ArrowUpRight, Lock, KeyRound, Timer } from "lucide-react";
import { hexToBytes, makeVariant } from "@zerohour/hourglass";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { OmrField } from "@/components/OmrField";
import { span, useAsync, useChainNow, useHead, useMounted } from "@/components/zh";
import { allExams, registryState, revealOf } from "@/lib/overview";
import { publicFile, type Reveal } from "@/lib/exam";
import { centreLabel } from "@/lib/names";

const Scene = dynamic(() => import("@/components/hero/HourglassScene"), { ssr: false, loading: () => <div className="scene-wait" aria-hidden /> });

const DEMO = "0xe54bb5d08c756ff06bdeb69145566653781d71644beecc8c0c47e3abd6b2b1ed";
const CLOCK = { genesis: 1794748800, roundSeconds: 300 }; // keyper #1's clock, from deployments/keyper1.public.json

function Hero() {
  const now = useChainNow();
  const head = useHead();
  const mounted = useMounted();
  const reg = useAsync(() => registryState());
  const exams = useAsync(allExams);
  const k0 = reg.data?.keypers[0] ?? CLOCK;
  const round = Math.floor((now - k0.genesis) / k0.roundSeconds);
  const into = now - (k0.genesis + round * k0.roundSeconds);
  const progress = useRef(0);
  progress.current = into / k0.roundSeconds;

  const latest = exams.data?.[0];
  const released = latest ? latest.keypers.map((k) => latest.round < k.nextRound) : [false, false, false];
  const early = reg.data?.releases.filter((r) => r.time < r.unlockAt).length;
  const still = mounted && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <section className="hero" aria-labelledby="hero-title">
      <OmrField />
      <div className="wrap hero-grid">
        <div className="hero-copy">
          <p className="hero-kicker">Post-quantum time lock for exam papers, running on QoreChain testnet</p>
          <h1 id="hero-title">The paper opens at the bell. Not one second sooner.</h1>
          <p className="hero-sub">
            ZeroHour seals each centre&apos;s question paper to two locks: a time lock held by bonded keypers, and the centre&apos;s own
            ML-KEM-1024 key. Post a seed early and you lose your bond. Leak the paper after the bell and the copy tells us which centre it came from.
          </p>
          <div className="hero-cta">
            <Button asChild size="xl" className="bg-[var(--omr)] text-white hover:bg-[#d84a7a]">
              <Link href="/live/">Watch the live bell</Link>
            </Button>
            <Button asChild size="xl" variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white">
              <Link href="/how/">See how it works</Link>
            </Button>
          </div>
          <dl className="chips" aria-label="Live from QoreChain">
            <div><dt>Block</dt><dd>{head ? head.block.toLocaleString() : "…"}</dd></div>
            <div><dt>Round {mounted ? round : "…"} ends in</dt><dd>{mounted ? span(k0.roundSeconds - into) : "…"}</dd></div>
            <div><dt>Keypers bonded</dt><dd>{reg.data ? reg.data.keypers.filter((k) => !k.slashed).length : "…"}</dd></div>
            <div><dt>Seeds posted early</dt><dd className={early ? "text-[#ff8a8a]" : ""}>{early ?? "…"}</dd></div>
          </dl>
        </div>
        <figure className="hero-scene">
          <Scene progress={progress} released={released} still={still} />
          <figcaption>
            The sand is the current 5-minute keyper round on chain time. The orbs are the keypers of the latest exam, solid once their seed is public.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

const STAGES = [
  { name: "Paper setter", note: "writes the questions" },
  { name: "Printing press", note: "prints thousands of copies" },
  { name: "Transport", note: "trucks, couriers, handovers" },
  { name: "Centre strongroom", note: "days or weeks in storage" },
  { name: "Exam hall", note: "opened at the bell" },
];

function Chain() {
  return (
    <section className="wrap band" aria-labelledby="chain-title">
      <div className="split">
        <div>
          <h2 id="chain-title" className="display">Every hand that holds a printed paper is a place it can leak.</h2>
          <p className="lead">
            A paper travels for days before the exam. ZeroHour replaces the readable copy with a ciphertext that can be
            published openly, so there is nothing worth stealing until the bell.
          </p>
        </div>
        <ol className="track" aria-label="Where a paper sits before the bell">
          {STAGES.map((s, i) => (
            <li key={s.name}>
              <span className="track-dot" aria-hidden>{i + 1}</span>
              <div>
                <b>{s.name}</b>
                <span className="muted small">{s.note}</span>
              </div>
              <span className="track-today">{i === STAGES.length - 1 ? "Readable" : "Readable copy"}</span>
              <span className="track-zh">{i === STAGES.length - 1 ? "Opens at the bell" : "Ciphertext only"}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Locks() {
  return (
    <section className="locks-band" aria-labelledby="locks-title">
      <div className="wrap">
        <h2 id="locks-title" className="display">Two locks. Both must open.</h2>
        <p className="lead">Neither lock alone reveals anything. A thief needs the time and the centre&apos;s key, and the time is enforced by people who lose money if they cheat.</p>
        <Tabs defaultValue="bell" className="mt-8">
          <TabsList className="h-auto flex-wrap gap-1 bg-[var(--paper-2)] p-1">
            <TabsTrigger value="bell" className="px-4 py-2"><Timer /> Lock 1: the bell</TabsTrigger>
            <TabsTrigger value="centre" className="px-4 py-2"><KeyRound /> Lock 2: the centre</TabsTrigger>
            <TabsTrigger value="both" className="px-4 py-2"><Lock /> Together</TabsTrigger>
          </TabsList>
          <TabsContent value="bell" className="lock-panel">
            <div>
              <h3>Keypers hold the time</h3>
              <p>Each keyper commits a hash chain of seeds on chain, one per 5-minute round, and bonds 1 QOR. A round&apos;s ML-KEM-1024 key comes from its seed. The paper&apos;s time key is split 2-of-3 with Shamir and sealed to the keypers&apos; round keys.</p>
              <p>At the bell each keyper posts a 32-byte seed. The contract checks it against the keyper&apos;s anchor. A seed seen before its time lets anyone take half the bond.</p>
            </div>
            <ul className="spec">
              <li><span>Key</span>ML-KEM-1024 per keyper per round</li>
              <li><span>Threshold</span>2 of 3 seeds (Shamir)</li>
              <li><span>Penalty</span>Half the bond to whoever reports an early seed</li>
              <li><span>Clock</span>Block time, never a local clock</li>
            </ul>
          </TabsContent>
          <TabsContent value="centre" className="lock-panel">
            <div>
              <h3>Only the right centre can read its copy</h3>
              <p>Each centre registers an ML-KEM-1024 key in QoreChain&apos;s key registry and signs a recipient card with ECDSA and ML-DSA-87. The board seals only to keys it read from the chain, never to a key someone emailed it.</p>
              <p>Even after the bell, Pune-17&apos;s copy is useless to Patna-05.</p>
            </div>
            <ul className="spec">
              <li><span>Seal</span>QoreSeal: ML-KEM-1024 + X25519</li>
              <li><span>Identity</span>Hybrid-signed recipient card</li>
              <li><span>Receipt</span>ML-DSA-87 signed opening, on chain</li>
              <li><span>Paper</span>AES-256-GCM under both keys</li>
            </ul>
          </TabsContent>
          <TabsContent value="both" className="lock-panel">
            <div>
              <h3>The paper key needs both halves</h3>
              <p>The paper is encrypted under keccak(time key ‖ centre key). The time key opens for everyone at the bell. The centre key never leaves the centre. Ciphertext hashes are committed on chain before the exam, so a swapped file is caught.</p>
            </div>
            <pre className="formula" aria-label="Key derivation">{`dataKey = keccak256("zerohour-v1" ‖ timeKey ‖ recipKey)
timeKey  → Shamir 2-of-3 → ML-KEM-1024 (keyper round keys)
recipKey → QoreSeal      → ML-KEM-1024 + X25519 (centre)`}</pre>
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}

const STEPS = [
  ["The round opens on chain time", "Keyper daemons watch block timestamps, not their own clocks, so nobody can fake the bell."],
  ["Keypers post their seeds", "Each 32-byte seed is checked against the keyper's anchor by the contract and by anyone watching."],
  ["The time lock opens", "Once 2 of 3 seeds are public, the time half of every centre's key can be rebuilt by anyone."],
  ["Each centre opens its own copy", "With its own key, in seconds, then files an ML-DSA-87 signed receipt on chain."],
  ["Fairness is proven in public", "After the exam the board reveals the paper and permutation seeds. Anyone can recheck every variant."],
];

function Bell() {
  return (
    <section className="wrap band" aria-labelledby="bell-title">
      <div className="split">
        <div>
          <h2 id="bell-title" className="display">What happens at the bell</h2>
          <p className="lead">Nobody presses a button. The daemons see the round open and act.</p>
          <div className="real-run">
            <p className="small muted">The real run on 15 November 2026, round 38, bell at 16:30:00 UTC</p>
            <ul>
              <li><b>+10 s</b> keyper 3 posts its seed</li>
              <li><b>+12 s</b> keyper 2 posts, and the time lock opens</li>
              <li><b>+15 s</b> keyper 1 posts</li>
              <li><b>+34 s</b> Pune-17 opens its paper</li>
              <li><b>+42 s</b> Patna-05 opens its paper</li>
            </ul>
            <Link href={`/exam/?id=${DEMO}`} className="inline-flex items-center gap-1 font-semibold">Check it on chain <ArrowUpRight className="size-4" /></Link>
          </div>
        </div>
        <ol className="steps">
          {STEPS.map(([t, d]) => (
            <li key={t}><h3>{t}</h3><p className="muted">{d}</p></li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function LeakHunter() {
  const reveal = useAsync(() => publicFile<Reveal>("demo/0xe54bb5d0", "reveal.json"));
  const rows = useMemo(() => {
    const r = reveal.data;
    if (!r) return [];
    return r.centres.map((c) => ({ name: c.name, key: makeVariant(r.canonicalPaper, c.name, hexToBytes(c.permSeedA)).answerKey.slice(0, 10) }));
  }, [reveal.data]);
  const leak = rows.find((r) => r.name === "centre-patna-05");
  return (
    <section className="lh" aria-labelledby="lh-title">
      <OmrField gap={30} />
      <div className="wrap split">
        <div>
          <h2 id="lh-title" className="display">A leaked copy names its centre.</h2>
          <p className="lead">
            Every centre gets the same questions in its own order, with its own option order. Four questions from a phone photo are
            enough: the Leak Hunter scores the photo against every centre&apos;s variant and files a signed report on chain, with the
            evidence sealed to the board.
          </p>
          <p className="lh-result"><b>1 of 1,000</b> centres matched a four-question photo in the demo. The best decoy matched 3 of 8 observations.</p>
        </div>
        <div className="keys" aria-label="Answer keys of two real centre variants, first ten positions">
          {rows.map((r) => (
            <div key={r.name} className={r.name === leak?.name ? "keyrow leak" : "keyrow"}>
              <span className="keyname">Centre {centreLabel(r.name)}{r.name === leak?.name ? ", matches the leaked photo" : ""}</span>
              <div className="keycells">
                {r.key.map((l, i) => (
                  <Tooltip key={i}>
                    <TooltipTrigger asChild><span className={i < 4 && r.name === leak?.name ? "kc seen" : "kc"} tabIndex={0}>{l}</span></TooltipTrigger>
                    <TooltipContent>Position {i + 1}: answer {l}{i < 4 && r.name === leak?.name ? ", seen in the leaked photo" : ""}</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>
          ))}
          {!rows.length && <p className="text-white/60">Loading the revealed variants…</p>}
          <p className="small text-white/60">Computed in your browser from the seeds the board revealed after the exam.</p>
        </div>
      </div>
    </section>
  );
}

function Proof() {
  const reg = useAsync(() => registryState());
  const all = reg.data?.releases ?? [];
  const early = all.filter((r) => r.time < r.unlockAt).length;
  return (
    <section className="wrap band" aria-labelledby="proof-title">
      <h2 id="proof-title" className="display">Don&apos;t take our word for it.</h2>
      <p className="lead">Every page below reads QoreChain directly and runs the checks in your browser. There is no ZeroHour server.</p>
      <div className="proof">
        <Link href="/ledger/" className="proof-big">
          <span className="proof-num">{reg.data ? `${all.length - early}/${all.length}` : "…"}</span>
          <span className="proof-label">seeds posted on time, each rehashed to its anchor</span>
          <span className="proof-go">Open the release ledger <ArrowUpRight className="size-4" /></span>
        </Link>
        <Link href={`/exam/?id=${DEMO}`} className="proof-item">
          <b>A real exam, end to end</b>
          <span className="muted">Ciphertext hashes, receipts, a leak report and the fairness proof.</span>
          <span className="proof-go">Board view <ArrowUpRight className="size-4" /></span>
        </Link>
        <Link href={`/open/?id=${DEMO}&centre=0x13e39273957F818746Fd38384374F3ff850E2E8f`} className="proof-item">
          <b>Open a paper yourself</b>
          <span className="muted">The centre console decrypts in the page, in milliseconds.</span>
          <span className="proof-go">Centre console <ArrowUpRight className="size-4" /></span>
        </Link>
      </div>
    </section>
  );
}

const FAQ = [
  ["What if a keyper goes offline at the bell?", "Any 2 of the 3 seeds open the time lock. If the paper itself is compromised, the board switches every centre to a backup paper sealed to a later round, in one transaction."],
  ["What stops the keypers from colluding?", "Two of them would have to share seeds before the bell. Anyone who sees an early seed can report it and take half that keyper's bond, so every accomplice is a potential informant. More outside keypers and a higher threshold raise the cost further."],
  ["Can the exam board read the paper early?", "The board writes the paper, so ZeroHour does not hide it from the board. It removes the readable copy from everyone after the board: the press, transport, and every centre. Splitting the paper across several setters is on the roadmap."],
  ["Why post-quantum?", "The ciphertexts are public weeks in advance and question banks are reused for years. ML-KEM-1024 and ML-DSA-87 keep sealed papers, receipts and slashing evidence safe against a future quantum attacker who records everything today."],
  ["What does a centre need on exam day?", "A key registered on QoreChain and a browser. The centre console checks the ciphertext against the chain, rebuilds the time key from public seeds and decrypts locally."],
  ["Is this running for real?", "Yes, on QoreChain testnet. The contracts, keypers, centres and the demo exam on this site are live, and every number is read from the chain as you watch."],
];

function Faq() {
  return (
    <section className="wrap band faq" aria-labelledby="faq-title">
      <h2 id="faq-title" className="display">Questions exam boards ask</h2>
      <Accordion type="single" collapsible className="mt-6">
        {FAQ.map(([q, a]) => (
          <AccordionItem key={q} value={q}>
            <AccordionTrigger className="py-5 text-[17px] font-semibold">{q}</AccordionTrigger>
            <AccordionContent className="pb-5 text-[16px] leading-relaxed text-[var(--graphite-2)]"><p>{a}</p></AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}

function Cta() {
  return (
    <section className="cta" aria-labelledby="cta-title">
      <OmrField gap={30} />
      <div className="wrap cta-inner">
        <h2 id="cta-title">Hold a piece of the bell.</h2>
        <p>Run a keyper on QoreChain testnet in about five minutes. Bond 1 QOR, keep your seeds, post them on time.</p>
        <div className="hero-cta">
          <Button asChild size="xl" className="bg-white text-[var(--navy)] hover:bg-white/90"><Link href="/keypers/">Become a keyper</Link></Button>
          <Button asChild size="xl" variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white">
            <a href="https://github.com/Nixon-CSE/zerohour" target="_blank" rel="noreferrer">Read the code</a>
          </Button>
        </div>
      </div>
    </section>
  );
}

export default function Landing() {
  useEffect(() => {
    document.documentElement.classList.add("is-landing");
    return () => document.documentElement.classList.remove("is-landing");
  }, []);
  return (
    <main id="content">
      <Hero />
      <Chain />
      <Locks />
      <Bell />
      <LeakHunter />
      <Proof />
      <Faq />
      <Cta />
    </main>
  );
}
