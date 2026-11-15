import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "How it works · ZeroHour" };

const LIFE = [
  ["Keypers join", "Each keyper registers with an ML-DSA-87 signature, bonds 1 QOR and commits two roots: the anchor of a hash chain of seeds, and a Merkle root of its per-round ML-KEM-1024 public keys.", "HourglassRegistry.register"],
  ["The board seals", "For every centre, the board shuffles questions and options with a secret per-centre seed, then seals that variant to two locks. It checks each keyper's round key against its on-chain Merkle root, and each centre's key against QoreChain's KEM registry.", "sealPaper"],
  ["The exam goes on chain", "createExam records the rounds, the keypers and the threshold. addCentre records each centre's ciphertext hash and a commitment to its permutation seed. All of it is signed with ML-DSA-87 by the board.", "ZeroHourExam.createExam / addCentre"],
  ["Ciphertexts are published", "The sealed papers are public files. Anyone can mirror them weeks in advance. Nobody can read them.", "deployments/…/sealed"],
  ["The bell", "When chain time passes the round, keyper daemons post their seeds. The contract hashes each one down to the keyper's anchor. With 2 of 3 seeds public, the time lock is open for everyone.", "HourglassRegistry.release"],
  ["Centres open", "Each centre checks its file against the on-chain hash, rebuilds the time key from public seeds, opens the QoreSeal envelope with its own key and decrypts. It files an ML-DSA-87 signed receipt.", "ZeroHourExam.recordOpening"],
  ["Leaks are traced", "If a copy surfaces, the Leak Hunter scores it against every centre's variant and files a signed report. The evidence is sealed to the board and only its hash goes on chain.", "ZeroHourExam.reportLeak"],
  ["Fairness is proven", "The board reveals the canonical paper and every permutation seed. Anyone can recompute each centre's variant and check it against the commitments made before the exam.", "ZeroHourExam.revealFairness"],
];

const CRYPTO = [
  ["Keyper round keys", "ML-KEM-1024", "Derived from SHAKE256(seed[r]); public keys committed as a Merkle root"],
  ["Seed chain", "keccak256 hash chain", "seed[r-1] = keccak(seed[r]); posting round r reveals every earlier round, never a later one"],
  ["Time key split", "Shamir 2-of-3", "Each share wrapped with AES-256-GCM under an ML-KEM shared secret"],
  ["Centre envelope", "QoreSeal (ML-KEM-1024 + X25519)", "Recipient key read from QoreChain's KEM registry, bound by a hybrid-signed card"],
  ["Paper", "AES-256-GCM", "Key = keccak256(\"zerohour-v1\" ‖ timeKey ‖ recipKey), header bound as AAD"],
  ["Signatures", "ML-DSA-87 (+ ECDSA)", "Board actions, centre receipts, Leak Hunter reports, keyper registration"],
  ["Variants", "SHAKE256-driven Fisher-Yates", "Per-centre question and option order, committed before the exam"],
];

const WHO = [
  ["Exam board", "Writes and seals the paper, switches to the backup, reveals for fairness", "Open a centre's copy after sealing without that centre's key"],
  ["Keyper", "Post its own seed at or after the round", "Open any paper alone, or post early without losing its bond"],
  ["Centre", "Open its own copy after the bell", "Open before the bell, or open another centre's copy"],
  ["Press, courier, strongroom", "Hold and move ciphertext", "Read anything"],
  ["Anyone watching", "Verify every seed, hash, receipt and the fairness proof", "Learn the paper before the bell"],
];

export default function How() {
  return (
    <>
      <div className="page-head">
        <h1>How ZeroHour works</h1>
        <p className="lead">From the day keypers join to the fairness proof after the exam. Each step names the contract call or function that does it, so you can find it in the code.</p>
      </div>

      <section>
        <h2>The life of one exam</h2>
        <ol className="steps mt-6">
          {LIFE.map(([t, d, code]) => (
            <li key={t}>
              <h3>{t}</h3>
              <p className="muted">{d}</p>
              <code className="hash muted">{code}</code>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2>The cryptography</h2>
        <div className="scroll">
          <table className="matrix">
            <thead><tr><th>Piece</th><th>Primitive</th><th>How it is used</th></tr></thead>
            <tbody>{CRYPTO.map(([a, b, c]) => <tr key={a}><td>{a}</td><td>{b}</td><td className="muted">{c}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Who can do what</h2>
        <div className="scroll">
          <table className="matrix">
            <thead><tr><th>Party</th><th>Can</th><th>Cannot</th></tr></thead>
            <tbody>{WHO.map(([a, b, c]) => <tr key={a}><td>{a}</td><td>{b}</td><td className="muted">{c}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="small muted mt-6">See it happen on a real exam: <Link href="/exam/?id=0xe54bb5d08c756ff06bdeb69145566653781d71644beecc8c0c47e3abd6b2b1ed">board view of the demo exam</Link>.</p>
      </section>
    </>
  );
}
