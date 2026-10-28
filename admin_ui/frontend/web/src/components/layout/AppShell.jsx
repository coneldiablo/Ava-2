import { useMemo, useState } from "react";
import {
  Activity,
  AudioLines,
  BarChart3,
  Boxes,
  Building2,
  Calendar,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  CloudCog,
  Container,
  Cpu,
  FileCode2,
  GitBranch,
  History,
  Key,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MessageSquare,
  Mic2,
  Network,
  PanelLeftClose,
  Radio,
  Route,
  ScrollText,
  Server,
  Settings2,
  ShieldAlert,
  SquareTerminal,
  Waves,
  Waypoints,
  Wrench,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "@/auth/AuthContext";
import { ChangePasswordModal } from "@/components/auth/ChangePasswordModal";
import { ProtectedPage } from "@/components/auth/Protected";
import { Card, PillButton } from "@/components/ui/core";
import { api } from "@/lib/api";
import { getCoffeeCrmUrl } from "@/lib/config";
import { cn } from "@/lib/utils";
import { AvaMark } from "@/components/ui/AvaMark";

const NAVIGATION = [
  {
    group: "Главное",
    items: [
      { name: "Главная", path: "/", icon: LayoutDashboard },
      { name: "История звонков", path: "/history", icon: History },
      { name: "Аналитика пилота", path: "/pilot-analytics", icon: BarChart3 },
      { name: "Задачи менеджера", path: "/tasks", icon: ClipboardList },
      { name: "Сообщения после звонка", path: "/followups", icon: MessageSquare },
      { name: "Кампании обзвона", path: "/scheduling", icon: Calendar },
      { name: "Мастер запуска", path: "/wizard", icon: Wrench },
      { name: "WhatsApp CRM", path: "/crm", icon: MessageCircle, external: true, externalUrl: getCoffeeCrmUrl },
    ],
  },
  {
    group: "Настройка AVA",
    items: [
      { name: "Бизнесы и отели", path: "/hotels", icon: Building2 },
      { name: "AI-провайдеры", path: "/providers", icon: Server },
      { name: "Сценарии обработки", path: "/pipelines", icon: GitBranch },
      { name: "Контексты диалога", path: "/contexts", icon: Route },
      { name: "Голосовые профили", path: "/profiles", icon: AudioLines },
      { name: "Инструменты", path: "/tools", icon: Wrench },
      { name: "MCP", path: "/mcp", icon: Boxes },
    ],
  },
  {
    group: "Тестирование",
    items: [{ name: "Тестовый звонок", path: "/sandbox", icon: Radio }],
  },
  {
    group: "Расширенные настройки",
    items: [
      { name: "Определение речи", path: "/vad", icon: Mic2 },
      { name: "Потоковая обработка", path: "/streaming", icon: Waves },
      { name: "Настройки LLM", path: "/llm", icon: Cpu },
      { name: "Передача аудио", path: "/transport", icon: Network },
      { name: "Перебивание ассистента", path: "/barge-in", icon: Activity },
    ],
  },
  {
    group: "Система",
    items: [
      { name: "Переменные среды", path: "/env", icon: CloudCog },
      { name: "Сервисы Docker", path: "/docker", icon: Container },
      { name: "Asterisk", path: "/asterisk", icon: Waypoints },
      { name: "Модели", path: "/models", icon: Cpu },
      { name: "Обновления", path: "/updates", icon: GitBranch },
      { name: "Журнал событий", path: "/logs", icon: ScrollText },
      { name: "Терминал", path: "/terminal", icon: SquareTerminal },
    ],
  },
  {
    group: "Опасная зона",
    items: [{ name: "Исходный YAML", path: "/yaml", icon: FileCode2 }],
  },
  {
    group: "Помощь",
    items: [
      { name: "Справка", path: "/help", icon: CircleHelp },
      { name: "Документация API", path: "/docs", icon: Settings2, external: true },
    ],
  },
];

const PATH_LABELS = Object.fromEntries(
  NAVIGATION.flatMap((group) => group.items.map((item) => [item.path.slice(1), item.name])),
);

export function AppShell({ children }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const { data: status } = useQuery({
    queryKey: ["shell-health"],
    queryFn: async () => {
      const response = await api.get("/api/system/health");
      return response.data;
    },
    enabled: Boolean(user),
    retry: false,
    staleTime: 10000,
  });

  const breadcrumbs = useMemo(() => {
    if (pathname === "/") {
      return ["Главная"];
    }
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) =>
        PATH_LABELS[segment] || segment
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
      );
  }, [pathname]);

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <ProtectedPage>
      <div className="flex min-h-screen bg-[#f2f2f2]">
        <ChangePasswordModal
          isOpen={passwordModalOpen}
          onClose={() => setPasswordModalOpen(false)}
        />

        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-[#111111]/10 bg-[#f2f2f2] transition-transform duration-300 lg:static lg:translate-x-0",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
        <div className="flex items-center justify-between border-b border-[#111111]/10 px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-sm bg-[#111111] text-white">
              <AvaMark size={26} />
            </div>
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
                AVA
              </p>
              <h1 className="font-clash-display text-2xl font-bold uppercase">
                AVA
              </h1>
            </div>
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-[#838282] transition-colors hover:bg-[#111111]/5 hover:text-[#111111] lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-label="Закрыть меню"
          >
            <PanelLeftClose size={18} />
          </button>
        </div>

        <nav className="flex-1 space-y-8 overflow-y-auto px-5 py-6">
          {NAVIGATION.map((group) => (
            <div key={group.group}>
              <p className="mb-3 px-2 text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                {group.group}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const active =
                    item.path === "/"
                      ? pathname === "/"
                      : pathname === item.path || pathname.startsWith(`${item.path}/`);

                  const content = (
                    <>
                      <item.icon size={17} />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <ChevronRight
                        size={14}
                        className={cn(
                          "transition-all",
                          active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                        )}
                      />
                    </>
                  );

                  if (item.external) {
                    const href = item.externalUrl ? item.externalUrl() : item.path;
                    return (
                      <a
                        key={item.path}
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                        className={cn(
                          "group flex items-center gap-3 rounded-full px-4 py-3 text-sm font-medium uppercase tracking-[0.12em] transition-all",
                          "text-[#838282] hover:bg-[#111111]/5 hover:text-[#111111]",
                        )}
                      >
                        {content}
                      </a>
                    );
                  }

                  return (
                    <Link
                      key={item.path}
                      to={item.path}
                      className={cn(
                        "group flex items-center gap-3 rounded-full px-4 py-3 text-sm font-medium uppercase tracking-[0.12em] transition-all",
                        active
                          ? "bg-[#111111] text-white shadow-lg"
                          : "text-[#838282] hover:bg-[#111111]/5 hover:text-[#111111]",
                      )}
                    >
                      {content}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-[#111111]/10 p-5">
          <Card className="space-y-4 rounded-[28px] border-[#111111] bg-white p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111111] text-white">
                {String(user?.username || "A").slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold uppercase tracking-[0.15em]">
                  {user?.username || "Admin"}
                </p>
                <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
                  Системный администратор
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <PillButton
                className="flex items-center justify-center gap-2 px-3 text-[10px]"
                onClick={() => setPasswordModalOpen(true)}
              >
                <Key size={12} />
                Пароль
              </PillButton>
              <PillButton
                variant="solid"
                className="flex items-center justify-center gap-2 px-3 text-[10px]"
                onClick={handleLogout}
              >
                <LogOut size={12} />
                Выйти
              </PillButton>
            </div>
          </Card>
        </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-[#111111]/10 bg-[#f2f2f2]/90 backdrop-blur-md">
            <div className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
            <div className="flex items-center gap-4">
              <button
                type="button"
                className="rounded-full border border-[#111111]/10 bg-white p-2 text-[#111111] lg:hidden"
                onClick={() => setSidebarOpen((value) => !value)}
                aria-label="Открыть меню"
              >
                <Menu size={18} />
              </button>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                  Управление AVA
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {breadcrumbs.map((item, index) => (
                    <div key={`${item}-${index}`} className="flex items-center gap-2">
                      {index > 0 ? (
                        <span className="text-[#bfbfbf]">/</span>
                      ) : null}
                      <span className="font-clash-display text-xl font-bold uppercase">
                        {item}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-full border border-[#111111]/10 bg-white px-4 py-2">
                <span
                  className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    status?.status === "healthy" ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                <span className="text-[10px] font-bold uppercase tracking-[0.28em]">
                  {status?.status === "healthy" ? "Система готова" : "Проверка"}
                </span>
              </div>
            </div>
            </div>
          </header>

          <div className="flex-1 p-4 sm:p-8">
            <div className="mx-auto max-w-7xl space-y-10 pb-10">{children}</div>
          </div>
        </main>
      </div>
    </ProtectedPage>
  );
}
