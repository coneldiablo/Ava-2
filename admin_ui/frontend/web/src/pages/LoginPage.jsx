import { useEffect, useState } from "react";
import { Lock, Shield, User } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "@/auth/AuthContext";
import { EchoStack, PillButton } from "@/components/ui/core";
import { AvaMark } from "@/components/ui/AvaMark";

export default function LoginPage() {
  const { isAuthenticated, loading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!loading && isAuthenticated) {
      navigate(location.state?.from || "/", { replace: true });
    }
  }, [isAuthenticated, loading, location.state, navigate]);

  async function handleLogin(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await login(username, password);
      navigate(location.state?.from || "/", { replace: true });
    } catch (err) {
      setError(err?.response?.data?.detail || "Неверный логин или пароль");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f2f2f2] md:flex-row">
      <div className="relative order-2 flex flex-1 flex-col justify-between overflow-hidden bg-[#111111] p-8 text-white md:order-1 md:p-12">
        <div className="relative z-10 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-[#f2f2f2] text-[#111111]">
            <AvaMark size={26} />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#bfbfbf]">
              AVA
            </p>
            <h1 className="font-clash-display text-3xl font-bold uppercase">
              Система AVA
            </h1>
          </div>
        </div>

        <div className="relative z-10 space-y-6">
          <p className="text-[10px] font-bold uppercase tracking-[0.45em] text-[#bfbfbf]">
            Управление голосовым ассистентом
          </p>
          <EchoStack
            text="АВТОРИЗАЦИЯ"
            className="text-4xl text-white sm:text-5xl md:text-8xl"
          />
          <p className="max-w-xl text-lg leading-8 text-[#bfbfbf]">
            Войдите, чтобы управлять бизнесами, звонками, WhatsApp, кампаниями,
            задачами менеджеров и состоянием сервисов AVA.
          </p>
        </div>

        <div className="relative z-10 flex flex-wrap gap-6">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.25em] text-[#bfbfbf]">
            <Shield size={12} />
            Защищённая сессия
          </div>
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.25em] text-[#bfbfbf]">
            <Lock size={12} />
            Доступ администратора
          </div>
        </div>

        <div className="pointer-events-none absolute inset-0 opacity-20">
          <div className="absolute left-[-10%] top-[-10%] h-72 w-72 rounded-full border border-white/20 blur-3xl" />
          <div className="absolute bottom-[-10%] right-[-10%] h-80 w-80 rounded-full border border-white/10 blur-3xl" />
        </div>
      </div>

      <div className="order-1 flex w-full items-center justify-center p-8 md:order-2 md:w-[520px] md:p-16">
        <div className="w-full max-w-md space-y-10">
          <div className="space-y-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Доступ администратора
            </p>
            <h2 className="font-clash-display text-4xl font-bold uppercase">
              Вход
            </h2>
            <p className="text-sm leading-6 text-[#666666]">
              Используйте учётные данные администратора AVA. Пароль не сохраняется в браузере.
            </p>
          </div>

          {error ? (
            <div className="border border-red-400/30 bg-red-100/70 p-4 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <form className="space-y-6" onSubmit={handleLogin}>
            <Field
              label="Логин"
              icon={User}
              value={username}
              onChange={setUsername}
            />
            <Field
              label="Пароль"
              icon={Lock}
              value={password}
              onChange={setPassword}
              type="password"
            />

            <PillButton
              type="submit"
              variant="solid"
              className="w-full py-4 text-xs"
              disabled={submitting}
            >
              {submitting ? "Вход..." : "Войти в AVA"}
            </PillButton>
          </form>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, icon: Icon, type = "text" }) {
  return (
    <label className="block space-y-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </span>
      <div className="relative">
        <Icon className="absolute left-4 top-1/2 -translate-y-1/2 text-[#bfbfbf]" size={16} />
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          autoComplete={type === "password" ? "current-password" : "username"}
          className="w-full border border-[#111111]/10 bg-white py-4 pl-12 pr-4 text-sm outline-none transition-all focus:border-[#111111] focus-visible:ring-2 focus-visible:ring-[#111111]/30"
        />
      </div>
    </label>
  );
}
