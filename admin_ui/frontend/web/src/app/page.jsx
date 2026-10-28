import React from "react";
import DashboardPage from "@/pages/DashboardPage";
import { AppShell } from "@/components/layout/AppShell";

export default function Page() {
  return (
    <AppShell>
      <DashboardPage />
    </AppShell>
  );
}
