"use client";
import { useState } from "react";
import { Slider } from "@/components/ui/slider";

/** Who must be corrupted to read a paper before the bell: t keypers plus one centre (the second lock). */
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
          <div className="meter-out">{tt} + 1</div>
          <p className="muted small mt-2 max-w-[32ch] md:ml-auto">people to corrupt to read one paper early: {tt} keypers and a centre, whose key is the second lock. If seeds change hands, {atRisk.toLocaleString()} QOR of bonds is at risk to anyone who turns them in. Decrypted pieces leave no such evidence, so independent keypers matter more than bond size.</p>
        </div>
      </div>
      <p className="small muted mt-6">Today&apos;s testnet exams run 2 of 3 keypers at 1 QOR each. The contract allows any threshold and bond: a national exam would set both far higher and draw keypers from different institutions.</p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-3"><span className="text-sm font-semibold">{label}</span>{children}</div>;
}
