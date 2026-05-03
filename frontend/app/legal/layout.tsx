import Link from "next/link";

export default function LegalLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="min-h-full px-4 py-10 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <nav className="mb-10 border-b border-white/10 pb-6">
          <Link
            href="/"
            className="text-sm font-medium text-primary transition hover:text-primary/80 hover:underline"
          >
            ← Back to home
          </Link>
        </nav>
        {children}
      </div>
    </div>
  );
}
