"use client";
import Link from "next/link";
import { formatEther } from "viem";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hash, ago, useAsync, useChainNow } from "@/components/zh";
import { registryState } from "@/lib/overview";
import { eq } from "@/lib/exam";

const RULES = [
  ["Never early", "A round's seed never leaves your machine before chain time passes its unlock time. Not in a transaction, not in an eth_call, not in a gas estimate."],
  ["Always on time", "Your daemon watches for exams that list you and posts each round the moment it is due. Missing the bell does not lose your bond, but it weakens the exam."],
  ["Keep one secret", "Your whole duty is a single 32-byte value, the top of your seed chain. Every round's seed and ML-KEM key is derived from it."],
];

export default function Keypers() {
  const reg = useAsync(() => registryState());
  const now = useChainNow();
  return (
    <>
      <div className="page-head">
        <h1>Keypers</h1>
        <p className="lead">Keypers hold the time. Each one bonds QOR, commits a hash chain of seeds, and posts one seed per round when the round opens. Any threshold of them opens a paper. Fewer than that opens nothing.</p>
        <div className="hero-cta" style={{ marginTop: 24 }}>
          <Button asChild size="xl"><a href="#run">Run a keyper</a></Button>
          <Button asChild size="xl" variant="outline"><Link href="/ledger/">See every release</Link></Button>
        </div>
      </div>

      <section>
        <h2>Bonded now</h2>
        <div className="scroll">
          <table className="sheet">
            <thead><tr><th>Keyper</th><th>Bond</th><th>Seeds public up to</th><th>Releases</th><th>Last release</th><th>Status</th></tr></thead>
            <tbody>
              {(reg.data?.keypers ?? []).map((k) => {
                const mine = reg.data!.releases.filter((r) => eq(r.keyper, k.address) && eq(r.registry, k.registry));
                return (
                  <tr key={k.registry + k.address}>
                    <td><Hash v={k.address} kind="addr" /></td>
                    <td>{formatEther(k.bond)} QOR</td>
                    <td>{k.nextRound ? `round ${k.nextRound - 1}` : "none yet"}<br /><span className="muted small">of {k.maxRound}, {k.roundSeconds} s rounds</span></td>
                    <td>{mine.length}</td>
                    <td>{mine[0] ? `${ago(now - mine[0].time)} ago` : "never"}</td>
                    <td>{k.slashed ? <Badge variant="destructive">Slashed</Badge> : !k.registered ? <Badge variant="secondary">Withdrawn</Badge> : k.exitAt ? <Badge variant="secondary">Exiting</Badge> : <Badge className="bg-[var(--pen-tint)] text-[var(--pen)]">Bonded</Badge>} <span className="muted small">v{k.v}</span></td>
                  </tr>
                );
              })}
              {reg.loading && <tr><td colSpan={6} className="pending">Reading HourglassRegistry…</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="small mt-4"><Link href="/ledger/">Every release, with timing checks</Link></p>
      </section>

      <section>
        <h2>The rules</h2>
        <div className="grid gap-8 md:grid-cols-3 mt-4">
          {RULES.map(([t, d]) => (
            <div key={t} className="border-t-2 border-[var(--omr)] pt-4">
              <h3 className="mb-2">{t}</h3>
              <p className="muted">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 id="run">Become an outside keyper</h2>
        <p className="muted">About ten minutes. Node 20+ and about 2 test QOR from the faucet. You never see a paper and we never see your secrets: you send the board only public keys, and it checks each one against your record on chain before sealing to it.</p>
        <pre className="cmd mt-4">{`git clone https://github.com/Nixon-CSE/zerohour && cd zerohour/apps/keyper
npm ci --prefix ../../packages/hourglass && npm ci
npx tsx src/cli.ts new        # fresh account; fund the printed qor1… address
npx tsx src/cli.ts setup      # ML-DSA-87 key, 60-day seed chain on the shared clock, 1 QOR bond
npx tsx src/cli.ts export-pk --hours 48 --out my-round-keys.json   # public keys + proofs
npx tsx src/cli.ts run        # release every exam round the moment it is due`}</pre>
        <p className="mt-4">Then send <code>my-round-keys.json</code> and your address to the board by <a href="https://github.com/Nixon-CSE/zerohour/issues/new?title=Outside%20keyper" target="_blank" rel="noreferrer">opening an issue</a>. Your keyper joins the next exam.</p>
        <p className="small muted mt-4">
          Faucet: <a href="https://dashboard.qorechain.io/faucet" target="_blank" rel="noreferrer">dashboard.qorechain.io/faucet</a>.
          The daemon opens EVM windows scoped to the registry only, checks its local chain against the on-chain record before it starts, and stops if it is ever slashed.
        </p>
      </section>
    </>
  );
}
