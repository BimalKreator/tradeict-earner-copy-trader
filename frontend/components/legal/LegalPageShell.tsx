import Link from "next/link";
import { COMPANY } from "@/lib/company";

export const legalDocClass =
  "space-y-6 text-[15px] leading-relaxed text-white/85 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-white [&_h3]:text-lg [&_h3]:font-medium [&_h3]:text-white/95 [&_li]:text-white/80 [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_p]:text-white/80 [&_strong]:font-semibold [&_strong]:text-white [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6";

export function LegalPageShell({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="border-b border-white/10 bg-slate-950/80">
        <nav className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <Link href="/" className="text-sm font-semibold text-cyan-400 hover:text-cyan-300">
            ← {COMPANY.productName}
          </Link>
          <Link href="/contact" className="text-sm text-white/60 hover:text-white">
            Contact
          </Link>
        </nav>
      </header>
      <main className="flex-1 px-4 py-10 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">{children}</div>
      </main>
    </div>
  );
}
