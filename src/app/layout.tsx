import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "WebTester — AI Autonomous Testing",
  description: "Senior QA agents that log in, explore, and test your app for you.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="pointer-events-none fixed inset-x-0 top-0 z-0 h-64 bg-gradient-to-b from-indigo-500/10 to-transparent" />
        <header className="sticky top-0 z-40 border-b border-line bg-background/80 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="group flex items-center gap-2.5 font-semibold tracking-tight">
              <span className="relative inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-sm text-white shadow-[0_0_16px_rgba(99,102,241,0.45)]">
                W
              </span>
              <span className="flex items-baseline gap-2">
                WebTester
                <span className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-muted">agent fleet</span>
              </span>
            </Link>
            <Link
              href="/projects/new"
              className="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-[0_0_16px_rgba(99,102,241,0.35)] transition-colors hover:bg-indigo-500 active:bg-indigo-700"
            >
              New Project
            </Link>
          </div>
        </header>
        <main className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        <footer className="relative z-10 border-t border-line py-4">
          <div className="mx-auto max-w-6xl px-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted sm:px-6">
            local · read-only agents · credentials encrypted at rest
          </div>
        </footer>
      </body>
    </html>
  );
}
