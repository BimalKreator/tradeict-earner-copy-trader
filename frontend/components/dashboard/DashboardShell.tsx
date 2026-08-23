"use client";

import { BottomTabBar } from "@/components/dashboard/BottomTabBar";
import { DashboardHeader } from "@/components/dashboard/DashboardHeader";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";

export function DashboardShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen bg-background">
      <DashboardSidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DashboardHeader />
        <main className="flex-1 overflow-auto p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:pl-[max(1rem,env(safe-area-inset-left))] max-md:pr-[max(1rem,env(safe-area-inset-right))] md:p-8 md:pb-8 lg:p-10">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
        <BottomTabBar />
      </div>
    </div>
  );
}
