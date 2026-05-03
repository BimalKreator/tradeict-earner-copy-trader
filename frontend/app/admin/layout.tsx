import type { Metadata } from "next";
import { AdminAuthGate } from "@/components/admin/AdminAuthGate";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

export const metadata: Metadata = {
  title: "Admin · TradeICT",
  description: "Copy trading admin dashboard",
};

export default function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <AdminAuthGate>
      <div className="flex min-h-screen bg-background">
        <AdminSidebar />
        <main className="min-w-0 flex-1 overflow-auto p-6 md:p-8 lg:p-10">
          {children}
        </main>
      </div>
    </AdminAuthGate>
  );
}
