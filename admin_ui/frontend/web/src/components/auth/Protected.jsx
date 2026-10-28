import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/auth/AuthContext";
import { ChangePasswordModal } from "@/components/auth/ChangePasswordModal";

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f2f2f2]">
      <div className="text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[#111111]/20 border-t-[#111111]" />
        <p className="mt-4 text-xs font-bold uppercase tracking-[0.3em] text-[#838282]">
          Подключение
        </p>
      </div>
    </div>
  );
}

export function ProtectedPage({ children }) {
  const { isAuthenticated, loading, mustChangePassword } = useAuth();
  const location = useLocation();

  if (loading) {
    return <LoadingScreen />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return (
    <>
      <ChangePasswordModal isOpen={mustChangePassword} mandatory />
      {children}
    </>
  );
}
