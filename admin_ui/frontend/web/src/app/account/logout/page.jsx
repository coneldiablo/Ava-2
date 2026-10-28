import useAuth from "@/utils/useAuth";
import { EchoStack, PillButton } from "@/components/ui/core";

export default function LogoutPage() {
  const { signOut } = useAuth();
  const handleSignOut = async () => {
    await signOut({
      callbackUrl: "/",
      redirect: true,
    });
  };

  return (
    <div className="min-h-screen bg-[#f2f2f2] flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-12 text-center">
        <div className="space-y-4">
          <EchoStack text="SIGN OUT" className="text-5xl" />
          <p className="text-[10px] uppercase tracking-widest text-[#838282] font-bold">
            Terminate session and secure node
          </p>
        </div>
        <PillButton
          variant="solid"
          className="w-full py-4 text-xs font-bold"
          onClick={handleSignOut}
        >
          Logout Terminal
        </PillButton>
      </div>
    </div>
  );
}
