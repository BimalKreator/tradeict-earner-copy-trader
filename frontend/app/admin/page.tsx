export default function AdminDashboardPage() {
  const stats = [
    {
      label: "Total Users",
      value: "12,847",
      hint: "+4.2% vs last month",
    },
    {
      label: "Active Strategies",
      value: "38",
      hint: "Across all traders",
    },
    {
      label: "Total AUM",
      value: "$48.2M",
      hint: "Assets under management",
    },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
          Dashboard
        </h1>
        <p className="mt-2 text-sm text-white/55">
          Overview of platform activity (placeholder metrics).
        </p>
      </header>

      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map((item) => (
          <div key={item.label} className="glass-card border border-glassBorder p-6">
            <p className="text-xs font-medium uppercase tracking-wider text-primary/90">
              {item.label}
            </p>
            <p className="mt-3 text-3xl font-semibold tabular-nums text-white">
              {item.value}
            </p>
            <p className="mt-2 text-xs text-white/45">{item.hint}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
