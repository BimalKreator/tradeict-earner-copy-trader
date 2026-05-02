export default function DashboardSettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
        Settings
      </h1>
      <p className="mt-2 text-sm text-white/55">
        Profile and notification preferences will appear here.
      </p>
      <div className="mt-10">
        <div className="glass-card border border-glassBorder p-6 md:p-8">
          <p className="text-sm text-white/50">
            This section is a placeholder until settings are wired to the API.
          </p>
        </div>
      </div>
    </div>
  );
}
