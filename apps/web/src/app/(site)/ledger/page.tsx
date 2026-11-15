"use client";
import { useMemo, useState } from "react";
import { Hash, ago, useAsync, useChainNow, utc } from "@/components/zh";
import { registryState } from "@/lib/overview";

export default function Ledger() {
  const reg = useAsync(() => registryState());
  const now = useChainNow();
  const [who, setWho] = useState("all");
  const rows = useMemo(() => (reg.data?.releases ?? []).filter((r) => who === "all" || r.keyper === who), [reg.data, who]);
  const all = reg.data?.releases ?? [];
  const early = all.filter((r) => r.time < r.unlockAt);
  const bad = all.filter((r) => !r.verified);
  const lag = all.map((r) => r.time - r.unlockAt).filter((d) => d >= 0 && d < 600);
  const median = lag.length ? [...lag].sort((a, b) => a - b)[Math.floor(lag.length / 2)] : null;

  return (
    <>
      <h1>Release ledger</h1>
      <p className="muted" style={{ marginTop: 14 }}>
        Every seed a keyper has posted to HourglassRegistry. This page re-hashes each seed down to the keyper&apos;s anchor
        and compares the block time with the round&apos;s unlock time. A seed seen before its time would let anyone claim the keyper&apos;s bond.
      </p>
      {reg.error && <p className="err">Could not read the registry: {reg.error}</p>}
      {reg.data && (
        <div className="stat-row" aria-label="Summary">
          <div><b>{all.length}</b><span>seeds posted</span></div>
          <div><b className={early.length ? "no" : "ok"}>{early.length}</b><span>posted before their time</span></div>
          <div><b className={bad.length ? "no" : "ok"}>{all.length - bad.length}/{all.length}</b><span>hash to their anchor</span></div>
          <div><b>{median === null ? "n/a" : `${median} s`}</b><span>median delay after the round opens</span></div>
          <div><b className={reg.data.slashes.length ? "no" : ""}>{reg.data.slashes.length}</b><span>keypers slashed</span></div>
        </div>
      )}

      <section style={{ marginTop: 32 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
          <label htmlFor="who" style={{ margin: 0 }}>Keyper</label>
          <select id="who" value={who} onChange={(e) => setWho(e.target.value)} style={{ font: "inherit", padding: "6px 8px" }}>
            <option value="all">All keypers</option>
            {(reg.data?.keypers ?? []).map((k, i) => <option key={k.address} value={k.address}>K{i + 1} {k.address.slice(0, 10)}…</option>)}
          </select>
        </div>
        <div className="scroll">
          <table className="sheet">
            <thead><tr><th>Posted</th><th>Keyper</th><th>Round</th><th>Round opened</th><th>Delay</th><th>Seed</th><th>Check</th><th>Tx</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tx}>
                  <td>{utc(r.time)}<br /><span className="muted small">{ago(now - r.time)} ago</span></td>
                  <td><Hash v={r.keyper} kind="addr" n={4} /></td>
                  <td>{r.round}</td>
                  <td>{utc(r.unlockAt)}</td>
                  <td className={r.time < r.unlockAt ? "no" : ""}>{r.time < r.unlockAt ? `${r.unlockAt - r.time} s early` : `+${ago(r.time - r.unlockAt)}`}</td>
                  <td><Hash v={r.seed} n={5} /></td>
                  <td>{r.verified ? <span className="ok tick">anchor</span> : <span className="no cross">mismatch</span>}</td>
                  <td><Hash v={r.tx} kind="tx" n={4} /></td>
                </tr>
              ))}
              {reg.loading && <tr><td colSpan={8} className="pending">Scanning HourglassRegistry from block 10,136,128…</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
