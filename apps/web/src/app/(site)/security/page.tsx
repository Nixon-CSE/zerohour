import type { Metadata } from "next";
import { CorruptionMeter } from "@/components/CorruptionMeter";

export const metadata: Metadata = { title: "Security · ZeroHour" };

const THREATS: [string, string, "live" | "next"][] = [
  ["Someone at the press, in transport or in a strongroom copies the paper", "They only ever hold ciphertext. The readable paper does not exist until the bell.", "live"],
  ["A centre tries to open early", "Its key opens only its own envelope, and the time half is missing until 2 keypers post. recordOpening reverts with NotUnlocked.", "live"],
  ["One keyper leaks its seed early", "One seed opens nothing. Whoever holds the early seed can commit-reveal it and take half that keyper's bond. This happened on testnet: a bribed keyper was slashed 14 minutes before its exam opened (see the release ledger).", "live"],
  ["Keypers collude", "They need the threshold of seeds before the bell, and each accomplice can betray the rest for half a bond. Cost grows with threshold and bond (calculator below).", "live"],
  ["A keyper is offline at the bell", "Any threshold of keypers opens it. If the paper itself is compromised, the board switches every centre to a backup paper sealed to a later round.", "live"],
  ["A centre leaks after opening", "Every centre's paper is a different permutation. A few questions from a photo name the centre; the Leak Hunter files a signed report.", "live"],
  ["Someone swaps a ciphertext file", "Each centre's ciphertext hash is on chain before the exam. The console refuses a file that does not match.", "live"],
  ["The board seals to an attacker's key", "Centre keys are read only from QoreChain's KEM registry and bound to the account by a hybrid-signed recipient card.", "live"],
  ["A quantum attacker records everything today", "Every lock and signature is post-quantum: ML-KEM-1024, QoreSeal hybrid, ML-DSA-87.", "live"],
  ["The RPC operator sees a seed in an eth_call", "Keyper daemons never let a seed leave the machine before chain time passes the round, not even for gas estimation.", "live"],
  ["A keyper's ECDSA key is stolen", "Its EVM window is scoped to the Hourglass registry and needs an ML-DSA-87 signature to open. We hand our drill key to the attacker bot on purpose.", "live"],
  ["The exam board itself leaks the paper", "The board writes the paper, so ZeroHour cannot hide it from the board. The fairness reveal proves no centre got a different paper. Splitting authorship across setters is next.", "next"],
];

const REAL: [string, "live" | "next"][] = [
  ["HourglassRegistry and ZeroHourExam on QoreChain testnet", "live"],
  ["Three bonded keypers with ML-KEM-1024 round keys and daemons", "live"],
  ["Two centres with on-chain KEM keys and signed recipient cards", "live"],
  ["In-browser opening with ciphertext, seed and anchor checks", "live"],
  ["Leak tracing against 1,000 variants (2 real centres, 998 simulated) and signed on-chain reports", "live"],
  ["Public fairness reveal, recomputed in the browser", "live"],
  ["Leak Hunter reading a real phone photo with Claude vision", "next"],
  ["Outside keypers from other institutions", "next"],
  ["Multi-setter sealing so no single person holds the paper", "next"],
  ["Least-privilege hot key for keypers", "next"],
];

export default function Security() {
  return (
    <>
      <div className="page-head">
        <h1>Security</h1>
        <p className="lead">Who could leak a paper, and what stops them. Each row says whether the protection runs on testnet today or is next on the roadmap.</p>
      </div>
      <section>
        <h2>Threat model</h2>
        <div className="scroll">
          <table className="matrix">
            <thead><tr><th>If…</th><th>What happens</th><th>Status</th></tr></thead>
            <tbody>
              {THREATS.map(([a, b, s]) => (
                <tr key={a}><td>{a}</td><td className="muted">{b}</td><td><span className={`pill ${s}`}>{s === "live" ? "Live" : "Next"}</span></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2>Cost of corruption</h2>
        <p className="muted">Opening a paper early means getting a threshold of keypers to break their one rule, while each of them can be paid to betray the others.</p>
        <CorruptionMeter />
      </section>
      <section>
        <h2>What is real today</h2>
        <div className="scroll">
          <table className="matrix">
            <thead><tr><th>Piece</th><th>Status</th></tr></thead>
            <tbody>{REAL.map(([a, s]) => <tr key={a}><td style={{ fontWeight: 500 }}>{a}</td><td><span className={`pill ${s}`}>{s === "live" ? "Live on testnet" : "Next"}</span></td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </>
  );
}
