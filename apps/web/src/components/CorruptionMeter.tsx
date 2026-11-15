"use client";
import { useState } from "react";
import { Slider } from "@/components/ui/slider";

/** What it costs to open a paper before the bell: t keypers must each risk their bond. */
export function CorruptionMeter() {
  const [n, setN] = useState(3);
  const [t, setT] = useState(2);
  const [bond, setBond] = useState(1);
  const tt = Math.min(t, n);
  const atRisk = tt * bond;
  return (
    <div className="meter">
      <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-6">
          <Row label={`Keypers in the exam: ${n}`}><Slider min={2} max={21} step={1} value={[n]} onValueChange={([v]) => { setN(v); if (t > v) setT(v); }} aria-label="Keypers" /></Row>
          <Row label={`Seeds needed to open (threshold): ${tt}`}><Slider min={2} max={n} step={1} value={[tt]} onValueChange={([v]) => setT(v)} aria-label="Threshold" /></Row>
          <Row label={`Bond per keyper: ${bond.toLocaleString()} QOR`}><Slider min={1} max={1000} step={1} value={[bond]} onValueChange={([v]) => setBond(v)} aria-label="Bond" /></Row>
        </div>
        <div className="md:text-right">
          <div className="meter-out">{atRisk.toLocaleString()} QOR</div>
          <p className="muted small mt-2 max-w-[30ch] md:ml-auto">at risk to open one paper early, across {tt} people who each gain half a bond by turning the others in.</p>
        </div>
      </div>
      <p className="small muted mt-6">Today&apos;s testnet exams run 2 of 3 keypers at 1 QOR each. The contract allows any threshold and bond: a national exam would set both far higher and draw keypers from different institutions.</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-3"><span className="text-sm font-semibold">{label}</span>{children}</div>;
}
