import React from "react";
import SetupWizard from "@/pages/SetupWizard";
import { ProtectedPage } from "@/components/auth/Protected";

export default function Page() {
  return (
    <ProtectedPage>
      <SetupWizard />
    </ProtectedPage>
  );
}
