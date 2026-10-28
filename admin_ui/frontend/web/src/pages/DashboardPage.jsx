import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  BookOpen,
  Building2,
  CheckCircle2,
  FolderCheck,
  HardDrive,
  MessageCircle,
  Phone,
  PhoneOutgoing,
  RefreshCw,
  Server,
  ShieldAlert,
  Wrench,
} from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, LoadingBlock, PageHeader, RefreshButton } from "@/components/ui/shell";
import { api } from "@/lib/api";
import { getCoffeeCrmUrl } from "@/lib/config";
import {
  formatBytes,
  formatNumber,
  formatPercent,
} from "@/lib/formatters";

const AAVA_CONTAINER_NAMES = [
  "admin_ui",
  "ai_engine",
  "local_ai_server",
  "updater-runner",
];

function isAavaContainer(container) {
  const name = container?.name || "";
  const image = container?.image || "";
  return AAVA_CONTAINER_NAMES.some((serviceName) => name.includes(serviceName))
    || image.includes("asterisk-ai-voice-agent");
}

export default function DashboardPage() {
  const navigate = useNavigate();

  const dashboardQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const [
        containers,
        metrics,
        directories,
        platform,
        asterisk,
        businesses,
      ] = await Promise.allSettled([
        api.get("/api/system/containers"),
        api.get("/api/system/metrics"),
        api.get("/api/system/directories"),
        api.get("/api/system/platform"),
        api.get("/api/system/asterisk-status"),
        api.get("/api/hotels"),
      ]);

      return {
        containers: containers.status === "fulfilled" ? containers.value.data : null,
        metrics: metrics.status === "fulfilled" ? metrics.value.data : null,
        directories:
          directories.status === "fulfilled" ? directories.value.data : null,
        platform: platform.status === "fulfilled" ? platform.value.data : null,
        asterisk: asterisk.status === "fulfilled" ? asterisk.value.data : null,
        businesses:
          businesses.status === "fulfilled"
            ? businesses.value.data?.profiles || businesses.value.data || []
            : [],
        errors: [containers, metrics]
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason?.response?.data?.detail || result.reason?.message || "Не удалось выполнить запрос"),
      };
    },
    refetchInterval: 10000,
  });

  const reloadMutation = async () => {
    try {
      const response = await api.post("/api/system/containers/ai_engine/reload");
      toast.success(response.data?.message || "Перезагрузка AI Engine запущена.");
      dashboardQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось перезагрузить AI Engine.");
    }
  };

  const reconnectAriMutation = async () => {
    try {
      const response = await api.post(
        "/api/system/containers/ai_engine/restart?force=false&recreate=true",
      );
      toast.success(response.data?.message || "Перезапуск AI Engine запущен.");
      dashboardQuery.refetch();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось перезапустить AI Engine.");
    }
  };

  const fixDirectoriesMutation = async () => {
    try {
      const response = await api.post("/api/system/directories/fix");
      if (response.data?.success) {
        toast.success("Каталоги исправлены.");
        dashboardQuery.refetch();
        return;
      }
      toast.error(response.data?.errors?.join(", ") || "Не удалось автоматически исправить каталоги.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Не удалось исправить каталоги.");
    }
  };

  const metrics = dashboardQuery.data?.metrics;
  const platform = dashboardQuery.data?.platform;
  const directories = dashboardQuery.data?.directories;
  const asterisk = dashboardQuery.data?.asterisk;
  const containers = dashboardQuery.data?.containers ?? [];

  const activeCalls = useMemo(() => {
    const projectContainers = Array.isArray(containers)
      ? containers.filter(isAavaContainer)
      : [];
    const aiEngine = projectContainers.find((container) => container.name?.includes("ai_engine"));
    return {
      aiEngine,
      projectContainers,
      runningContainers: projectContainers.filter((container) => container.status === "running").length,
    };
  }, [containers]);

  if (dashboardQuery.isLoading) {
    return <LoadingBlock label="Загрузка главной страницы" />;
  }

  const metricCards = [
    {
      label: "CPU",
      value: formatPercent(metrics?.cpu?.percent),
      subValue: `${metrics?.cpu?.count || 0} ядер`,
      icon: Activity,
    },
    {
      label: "Память",
      value: formatPercent(metrics?.memory?.percent),
      subValue: `${formatBytes(metrics?.memory?.used)} / ${formatBytes(metrics?.memory?.total)}`,
      icon: Server,
    },
    {
      label: "Диск",
      value: formatPercent(metrics?.disk?.percent),
      subValue: `${formatBytes(metrics?.disk?.free)} свободно`,
      icon: HardDrive,
    },
    {
      label: "Asterisk",
      value: asterisk?.live?.ari_reachable ? "Подключён" : "Нужна проверка",
      subValue: asterisk?.live?.ari_version || "Нет соединения",
      icon: Phone,
      onClick: () => navigate("/asterisk"),
    },
    {
      label: "Аудиокаталоги",
      value: directories?.overall === "healthy" ? "В порядке" : "Нужно исправить",
      subValue: directories?.checks?.host_directory?.message || "Проверьте подключение каталогов",
      icon: FolderCheck,
      action:
        directories?.overall !== "healthy" ? (
          <button
            type="button"
            className="rounded-full border border-[#111111]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em]"
            onClick={(event) => {
              event.stopPropagation();
              fixDirectoriesMutation();
            }}
          >
            Исправить
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Центр управления"
        title="Главная"
        description="Запустите бизнес в AVA по шагам и контролируйте звонки, WhatsApp, задачи менеджеров и исходящие кампании в одном месте."
        actions={
          <>
            <RefreshButton
              loading={dashboardQuery.isFetching}
              onClick={() => dashboardQuery.refetch()}
            />
            <PillButton variant="solid" onClick={reloadMutation}>
              <span className="flex items-center gap-2">
                <RefreshCw size={14} />
                Перезагрузить AI
              </span>
            </PillButton>
            <PillButton onClick={() => window.open(getCoffeeCrmUrl(), "_blank", "noopener,noreferrer")}>
              <span className="flex items-center gap-2">
                <MessageCircle size={14} />
                Открыть WhatsApp CRM
              </span>
            </PillButton>
          </>
        }
      />

      {dashboardQuery.data?.errors?.length ? (
        <Banner
          tone="warning"
          action={
            <PillButton onClick={() => dashboardQuery.refetch()}>Повторить</PillButton>
          }
        >
          <div>
            <p className="font-bold uppercase tracking-[0.12em]">
              Часть системных данных недоступна.
            </p>
            <p className="mt-1 text-sm">
              Проверьте запуск сервисов и соединение Admin UI с Docker. Клиентские
              данные при этом не изменяются.
            </p>
          </div>
        </Banner>
      ) : null}

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Card className="rounded-[32px] p-8 xl:col-span-7">
          <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
            Запуск первого отеля
          </p>
          <h2 className="mt-3 font-clash-display text-3xl font-bold uppercase">
            Один бизнес — один ID во всей системе
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#666666]">
            Профиль создаётся один раз и используется AVA и WhatsApp CRM. Клиенты,
            звонки, кампании, база знаний и настройки SIP остаются внутри выбранного бизнеса.
          </p>
          <div className="mt-7 space-y-2">
            <SetupStep
              number="01"
              title="Создать или выбрать бизнес"
              description="Название, часовой пояс, тон общения и единый business ID."
              done={(dashboardQuery.data?.businesses || []).length > 0}
              onClick={() => navigate("/hotels")}
            />
            <SetupStep
              number="02"
              title="Подключить WhatsApp и SIP"
              description="Номер WhatsApp, телефонный транк и Caller ID конкретного отеля."
              done={(dashboardQuery.data?.businesses || []).some((item) => item.greenApiInstance && item.sipTrunkNumber)}
              onClick={() => navigate("/hotels")}
            />
            <SetupStep
              number="03"
              title="Загрузить базу знаний"
              description="Номера, услуги, цены, правила, трансфер и ответы на вопросы гостей."
              onClick={() => navigate("/hotels")}
            />
            <SetupStep
              number="04"
              title="Проверить разговор"
              description="Тестовый входящий или исходящий звонок до запуска на гостях."
              onClick={() => navigate("/sandbox")}
            />
            <SetupStep
              number="05"
              title="Запустить кампанию"
              description="Один тестовый номер или полноценная очередь с безопасными повторами."
              onClick={() => navigate("/scheduling")}
            />
          </div>
        </Card>

        <Card className="rounded-[32px] bg-[#111111] p-8 text-white xl:col-span-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-white/50">
            Что уже работает
          </p>
          <h2 className="mt-3 font-clash-display text-3xl font-bold uppercase">
            Функции пилота
          </h2>
          <div className="mt-7 space-y-5">
            <FeatureItem icon={Building2} title="Разделение бизнесов" text="AVA не смешивает гостей, звонки и знания разных отелей." />
            <FeatureItem icon={Phone} title="Телефония каждого отеля" text="Свой SIP-транк, Caller ID, приветствие и история звонков." />
            <FeatureItem icon={BookOpen} title="Память и база знаний" text="Контекст WhatsApp и звонков перед разговором без выдуманных ответов." />
            <FeatureItem icon={PhoneOutgoing} title="Стабильный обзвон" text="Диагностика ошибок, автоматические повторы и тест одного номера." />
            <FeatureItem icon={MessageCircle} title="Работа менеджера" text="Задачи, черновики WhatsApp после звонка и аналитика пилота." />
          </div>
        </Card>
      </section>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
        {metricCards.map((item) => (
          <button
            type="button"
            key={item.label}
            onClick={item.onClick}
            className="text-left"
          >
            <Card className="h-full rounded-[28px] p-6">
              <div className="mb-8 flex items-start justify-between">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111111] text-white">
                  <item.icon size={20} />
                </div>
                {item.action}
              </div>
              <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
                {item.label}
              </p>
              <h3 className="mt-2 font-clash-display text-4xl font-bold uppercase leading-none">
                {item.value}
              </h3>
              <p className="mt-3 text-sm text-[#666666]">{item.subValue}</p>
            </Card>
          </button>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <Card className="xl:col-span-8 rounded-[32px] p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                Готовность платформы
              </p>
              <h2 className="mt-3 font-clash-display text-4xl font-bold uppercase">
                {platform?.summary?.ready ? "Система готова" : "Нужна проверка"}
              </h2>
            </div>
            {!asterisk?.live?.ari_reachable ? (
              <PillButton variant="solid" onClick={reconnectAriMutation}>
                <span className="flex items-center gap-2">
                  <ShieldAlert size={14} />
                  Переподключить ARI
                </span>
              </PillButton>
            ) : null}
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <InfoItem
              label="Проверки пройдены"
              value={`${platform?.summary?.passed || 0}`}
              hint="Системные проверки"
            />
            <InfoItem
              label="OS"
              value={platform?.platform?.os?.id || "Неизвестно"}
              hint={platform?.platform?.os?.version}
            />
            <InfoItem
              label="AAVA"
              value={platform?.platform?.project?.version || "Неизвестно"}
              hint="Версия проекта"
            />
            <InfoItem
              label="Docker"
              value={platform?.platform?.docker?.version || "Неизвестно"}
              hint={platform?.platform?.compose?.version || "Compose недоступен"}
            />
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            <TopologyNode
              label="Asterisk"
              value={asterisk?.live?.ari_reachable ? "Подключён" : "Отключён"}
              detail={asterisk?.live?.ari_version || "Нет соединения ARI"}
            />
            <TopologyNode
              label="AI Engine"
              value={activeCalls.aiEngine?.status === "running" ? "Работает" : "Остановлен"}
              detail={activeCalls.aiEngine?.status === "running" ? "Сервис активен" : "Ожидает запуска"}
            />
            <TopologyNode
              label="Контейнеры"
              value={formatNumber(activeCalls.runningContainers)}
              detail={`${formatNumber(activeCalls.projectContainers.length)} контейнеров AVA`}
            />
          </div>
        </Card>

        <div className="space-y-6 xl:col-span-4">
          <Card className="rounded-[32px] bg-[#111111] p-8 text-white">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-white/50">
              Быстрые действия
            </p>
            <div className="mt-6 space-y-2">
              <QuickAction
                label="Запустить предварительную проверку"
                onClick={async () => {
                  try {
                    await api.post("/api/system/preflight");
                    toast.success("Предварительная проверка запущена.");
                  } catch (err) {
                    toast.error(err?.response?.data?.detail || "Предварительная проверка не выполнена.");
                  }
                }}
              />
              <QuickAction label="Проверить Asterisk" onClick={() => navigate("/asterisk")} />
              <QuickAction label="Открыть сервисы Docker" onClick={() => navigate("/docker")} />
              <QuickAction label="Посмотреть журнал" onClick={() => navigate("/logs")} />
            </div>
          </Card>

          <Card className="rounded-[32px] p-8">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Состояние сейчас
            </p>
            <div className="mt-6 space-y-4">
              <SnapshotRow
                label="Активные звонки"
                value={String(asterisk?.live?.active_channels || 0)}
              />
              <SnapshotRow
                label="Локальный AI"
                value={activeCalls.projectContainers.some((item) => item.name?.includes("local_ai_server") && item.status === "running") ? "Работает" : "Остановлен"}
              />
              <SnapshotRow
                label="AI-провайдер"
                value={asterisk?.config?.default_provider || "См. настройки"}
              />
              <SnapshotRow
                label="Режим проверки"
                value={asterisk?.mode || "Неизвестно"}
              />
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}

function InfoItem({ label, value, hint }) {
  return (
    <div className="rounded-[24px] border border-[#111111]/10 bg-white px-5 py-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold uppercase">{value}</p>
      <p className="mt-1 text-xs text-[#666666]">{hint || "—"}</p>
    </div>
  );
}

function TopologyNode({ label, value, detail }) {
  return (
    <div className="rounded-[28px] border border-[#111111]/10 p-5">
      <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#838282]">
        {label}
      </p>
      <h3 className="mt-2 font-clash-display text-3xl font-bold uppercase">
        {value}
      </h3>
      <p className="mt-2 text-sm text-[#666666]">{detail}</p>
    </div>
  );
}

function QuickAction({ label, onClick }) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between border-b border-white/10 py-3 text-left text-sm font-bold uppercase tracking-[0.15em] transition-colors hover:text-white/70"
      onClick={onClick}
    >
      <span>{label}</span>
      <Wrench size={14} />
    </button>
  );
}

function SnapshotRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs font-bold uppercase tracking-[0.2em] text-[#838282]">
        {label}
      </span>
      <span className="text-xs font-bold uppercase tracking-[0.15em]">
        {value}
      </span>
    </div>
  );
}

function SetupStep({ number, title, description, done = false, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-16 w-full items-center gap-4 rounded-[22px] border border-[#111111]/10 px-4 py-3 text-left transition-colors hover:border-[#111111]/30 hover:bg-[#111111]/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111]"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#111111] text-xs font-bold text-white">
        {done ? <CheckCircle2 size={18} aria-label="Готово" /> : number}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold uppercase tracking-[0.08em]">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-[#666666]">{description}</span>
      </span>
      <span className="text-xl" aria-hidden="true">→</span>
    </button>
  );
}

function FeatureItem({ icon: Icon, title, text }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/10">
        <Icon size={18} />
      </div>
      <div>
        <p className="text-sm font-bold uppercase tracking-[0.08em]">{title}</p>
        <p className="mt-1 text-xs leading-5 text-white/60">{text}</p>
      </div>
    </div>
  );
}
