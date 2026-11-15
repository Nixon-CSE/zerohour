import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import { Footer, Nav } from "@/components/Nav";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";
import { cn } from "@/lib/utils";

const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--zh-sans" });
const serif = Source_Serif_4({ subsets: ["latin"], variable: "--zh-serif" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--zh-mono" });

export const metadata: Metadata = {
  title: "ZeroHour",
  description: "Exam papers that nobody can open before the bell. Post-quantum time-lock on QoreChain.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(archivo.variable, serif.variable, mono.variable)}>
      <body>
        <TooltipProvider>
          <Nav />
          {children}
          <Footer />
        </TooltipProvider>
      </body>
    </html>
  );
}
