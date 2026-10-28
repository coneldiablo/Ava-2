import { useState } from "react";
import useAuth from "@/utils/useAuth";
import { EchoStack, PillButton } from "@/components/ui/core";
import { Mail, Lock } from "lucide-react";

export default function SignInPage() {
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const { signInWithCredentials } = useAuth();

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await signInWithCredentials({
        email,
        password,
        callbackUrl: "/",
        redirect: true,
      });
    } catch (err) {
      setError("Invalid email or password");
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#f2f2f2] flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-12">
        <div className="text-center space-y-4">
          <EchoStack text="WELCOME BACK" className="text-5xl" />
          <p className="text-[10px] uppercase tracking-widest text-[#838282] font-bold">
            Access the AI Terminal
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#838282]">
                Email
              </label>
              <div className="relative">
                <Mail
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-[#bfbfbf]"
                  size={16}
                />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-white border border-[#111111]/10 p-4 pl-12 text-sm focus:outline-none focus:ring-1 focus:ring-[#111111]"
                  placeholder="admin@node.local"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-[10px] font-bold uppercase tracking-widest text-[#838282]">
                Password
              </label>
              <div className="relative">
                <Lock
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-[#bfbfbf]"
                  size={16}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-white border border-[#111111]/10 p-4 pl-12 text-sm focus:outline-none focus:ring-1 focus:ring-[#111111]"
                  placeholder="••••••••"
                />
              </div>
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-500 font-bold uppercase">{error}</p>
          )}

          <PillButton
            variant="solid"
            className="w-full py-4 text-xs font-bold"
            type="submit"
            disabled={loading}
          >
            {loading ? "Authorizing..." : "Enter Node"}
          </PillButton>

          <p className="text-center text-[10px] font-bold uppercase tracking-widest text-[#838282]">
            New to AVA?{" "}
            <a
              href="/account/signup"
              className="text-[#111111] hover:underline"
            >
              Create Account
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
