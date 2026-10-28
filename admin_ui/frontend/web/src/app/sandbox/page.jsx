import React from "react";
import SandboxPage from "@/pages/SandboxPage";
import { ProtectedPage } from "@/components/auth/Protected";

export default function Page() {
  return (
    <ProtectedPage>
      <SandboxPage />
    </ProtectedPage>
  );
}
