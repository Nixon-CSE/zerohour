import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import { Footer, Nav } from "@/components/Nav";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import { cn } from "@/lib/utils";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--zh-sans" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--zh-serif" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--zh-mono" });

const SITE = process.env.NEXT_PUBLIC_SITE_URL; // set at deploy so link previews get absolute image URLs
const DESC = "Exam papers that nobody can open before the bell. A post-quantum time lock on QoreChain, with every claim checked in your browser.";

export const metadata: Metadata = {
  ...(SITE ? { metadataBase: new URL(SITE) } : {}),
  title: { default: "ZeroHour: exam papers nobody can open before the bell", template: "%s" },
  description: DESC,
  openGraph: { title: "ZeroHour", description: DESC, type: "website", images: [{ url: "/og.png", width: 1920, height: 1080, alt: "ZeroHour" }] },
  twitter: { card: "summary_large_image", title: "ZeroHour", description: DESC, images: ["/og.png"] },
};

// Runs before paint: apply the remembered theme, or the system one, so there is no flash.
const THEME = `try{var t=localStorage.getItem("zh-theme");document.documentElement.dataset.theme=t||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(archivo.variable, serif.variable, mono.variable)} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME }} /></head>
      <body>
        <a href="#content" className="skip">Skip to content</a>
        <TooltipProvider>
          <Nav />
          {children}
          <Footer />
        </TooltipProvider>
      </body>
    </html>
  );
}
