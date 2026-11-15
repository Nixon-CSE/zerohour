import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="wrap" style={{ minHeight: "60vh" }}>
      <div className="clock" aria-hidden>404</div>
      <h1>This page is still sealed.</h1>
      <p className="lead" style={{ marginTop: 14 }}>Nothing lives at this address. The exam, the keypers and the ledger are all one click away.</p>
      <div className="hero-cta" style={{ marginTop: 28 }}>
        <Button asChild size="xl"><Link href="/">Go to the home page</Link></Button>
        <Button asChild size="xl" variant="outline"><Link href="/live/">Watch the live bell</Link></Button>
      </div>
    </main>
  );
}
