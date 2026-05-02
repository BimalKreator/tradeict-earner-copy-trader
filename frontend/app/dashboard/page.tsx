export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
        Welcome back
      </h1>
      <p className="mt-2 text-sm text-white/55">
        Here’s a snapshot of your copy-trading activity.
      </p>

      <div className="mt-10">
        <div className="glass-card border border-glassBorder p-6 md:p-8">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">
            Portfolio
          </p>
          <h2 className="mt-2 text-xl font-semibold text-white">Your Portfolio</h2>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-white/50">
            Connect funding and follow strategies to see balances, P&amp;L, and
            allocations here. This card is a placeholder until portfolio data is
            wired up.
          </p>
        </div>
      </div>
    </div>
  );
}
