import type { Metadata } from "next";
import { CorruptionMeter } from "@/components/CorruptionMeter";

export const metadata: Metadata = { title: "Security · ZeroHour" };

const THREATS: [string, string, "live" | "next"][] = [
  ["Someone at the press, in transport or in a strongroom copies the paper", "They only ever hold ciphertext. The readable paper does not exist until the bell.", "live"],
  ["A centre tries to open early", "Its key opens only its own envelope, and the time half is missing until 2 keypers post. recordOpening reverts with NotUnlocked.", "live"],
  ["One keyper leaks its seed early", "One seed opens nothing. Whoever holds the early seed can commit-reveal it and take half that keyper's bond. This happened on testnet: a bribed keyper was slashed 14 minutes before its exam opened (see the release ledger).", "live"],
  ["Keypers collude by trading seeds", "They need the threshold of seeds before the bell, and anyone holding another keyper's early seed can turn it in for half that bond.", "live"],
  ["Keypers collude by trading decrypted pieces instead", "A keyper can decrypt just its piece of one paper's time key and hand that over. That leaves no evidence the contract can check, so the bond does not deter it. The second lock does: the pieces open nothing without a centre's own key. An early read needs the threshold of keypers and a corrupt centre, and a paper leaked through a centre carries that centre's order, which the Leak Hunter traces. Keypers from independent institutions are the real defence (calculator below).", "live"],
  ["A keyper is offline at the bell", "Any threshold of keypers opens it: 2 of 3 seeds are enough.", "live"],
  ["The paper leaks from the setting room before sealing", "Each centre's copy has its own order; only the setters' master copy has the canonical one. The Leak Hunter traces a leaked page against both, so a master-copy match accuses no centre. The board then moves every centre to backup paper B, sealed to a later round, in one ML-DSA-87 signed transaction. This happened on testnet on 20 Nov: paper A was retired 13 minutes before its bell (see the exam page).", "live"],
  ["A centre leaks after opening", "Every centre's paper is a different permutation. A few questions from a photo name the centre; the Leak Hunter files a signed report.", "live"],
  ["The board seals a centre something other than the committed paper", "Each centre signs, on chain, the hash of the exact paper it decrypted. After the fairness reveal anyone can rebuild that centre's copy from the revealed paper and order and compare the hashes (v2 contracts; the exam page runs the check).", "live"],
  ["Someone swaps a ciphertext file", "Each centre's ciphertext hash is on chain before the exam. The console refuses a file that does not match.", "live"],
  ["The board seals to an attacker's key", "Centre keys are read only from QoreChain's KEM registry and bound to the account by a hybrid-signed recipient card.", "live"],
  ["A quantum attacker records everything today", "Every lock and signature is post-quantum: ML-KEM-1024, QoreSeal hybrid, ML-DSA-87.", "live"],
  ["The RPC operator sees a seed in an eth_call", "Keyper daemons never let a seed leave the machine before chain time passes the round, not even for gas estimation.", "live"],
  ["A keyper's ECDSA key is stolen", "Its EVM window is scoped to the Hourglass registry and needs an ML-DSA-87 signature to open. We hand our drill key to the attacker bot on purpose.", "live"],
  ["The exam board itself leaks the paper", "The board writes the paper, so ZeroHour cannot hide it from the board. A leaked master copy is caught and swapped for the backup (row above), and the fairness reveal proves no centre got a different paper. Splitting authorship across setters, so no one person holds a whole paper, is next.", "next"],
  ["The exam board leaks a centre's copy to frame that centre", "Until the fairness reveal the board holds every centre's question order, so it could produce any centre's copy. A leak in a centre's order therefore points at that centre or the board; the Leak Hunter reports the match, not the motive, and filing is the operator's decision. Multi-setter sealing would remove this.", "next"],
];

const REAL: [string, "live" | "next"][] = [
  ["HourglassRegistry and ZeroHourExam on QoreChain testnet", "live"],
  ["Three bonded keypers with ML-KEM-1024 round keys; #1 and #2 run 24/7 on a cloud VM, #3 on a separate machine (all operated by us)", "live"],
  ["Three centres (two demo centres and the public judges' centre) with on-chain KEM keys and signed recipient cards", "live"],
  ["In-browser opening with ciphertext, seed and anchor checks", "live"],
  ["Leak tracing against 1,000 variants (2 real centres, 998 simulated) and signed on-chain reports", "live"],
  ["Public fairness reveal, recomputed in the browser and checked against each centre's signed receipt", "live"],
  ["A judges' centre with a public decryption key: open a real paper yourself after the bell", "live"],
  ["Centre console takes only a decryption key, never the account's recovery phrase", "live"],
  ["v2 contracts after an internal audit: no keyper re-registration, exam ids bound to the board, keyper sets checked on chain, receipts per paper set", "live"],
  ["Leak Hunter reading a real phone photo with Claude vision", "live"],
  ["Backup-paper switch on a real leak, before the bell", "live"],
  ["Outside-keyper path: an exam sealed to a keyper from its published public keys alone, each checked against its on-chain root (run with a test keyper we operate)", "live"],
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
