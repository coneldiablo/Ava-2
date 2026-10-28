import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardList,
  Phone,
  RefreshCcw,
  User,
  XCircle,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

const STATUS_FILTERS = [
  ["", "Все"],
  ["new", "Новые"],
  ["in_progress", "В работе"],
  ["done", "Выполнены"],
  ["cancelled", "Отменены"],
];

// Mirrors MANAGER_TASK_TRANSITIONS in the CRM. The server is still the guard:
// this only decides which buttons are worth showing.
const NEXT_STATUSES = {
  new: ["in_progress", "done", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: ["new"],
  cancelled: ["new"],
};

const STATUS_LABELS = {
  new: "Новая",
  in_progress: "В работе",
  done: "Выполнена",
  cancelled: "Отменена",
};

const REASON_LABELS = {
  guest_request: "Гость попросил менеджера",
  missing_fact: "Нет ответа в базе знаний",
  booking_change: "Изменение бронирования",
  booking_request: "Новая заявка на бронирование",
  complaint: "Жалоба",
  payment: "Оплата",
  sensitive_data: "Конфиденциальные данные",
  repeated_misunderstanding: "AVA несколько раз не поняла гостя",
  transfer_failed: "Не удалось перевести на менеджера",
  manual: "Создана вручную",
  other: "Другая причина",
};

const PRIORITY_LABELS = {
  urgent: "Срочно",
  high: "Высокий приоритет",
  normal: "Обычный приоритет",
  low: "Низкий приоритет",
};

const PRIORITY_STYLES = {
  urgent: "border-red-500 text-red-600",
  high: "border-orange-500 text-orange-600",
  normal: "border-[#111111]/30 text-[#666666]",
  low: "border-[#111111]/15 text-[#838282]",
};

function normalizePositiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function formatTimestamp(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function StatusBadge({ status }) {
  const icons = {
    new: AlertTriangle,
    in_progress: RefreshCcw,
    done: CheckCircle2,
    cancelled: XCircle,
  };
  const Icon = icons[status] || ClipboardList;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#111111] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.25em]">
      <Icon size={12} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function TaskCard({ task, onStatusChange, isUpdating }) {
  const nextStatuses = NEXT_STATUSES[task.status] || [];
  return (
    <Card className="rounded-[24px] space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={task.status} />
            <span
              className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.25em] ${
                PRIORITY_STYLES[task.priority] || PRIORITY_STYLES.normal
              }`}
            >
              {PRIORITY_LABELS[task.priority] || task.priority}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
              {REASON_LABELS[task.reason] || task.reason}
            </span>
          </div>
          <p className="max-w-3xl text-sm leading-6 text-[#111111]">{task.summary}</p>
        </div>
        <div className="text-right text-[11px] uppercase tracking-[0.2em] text-[#838282]">
          <div>{formatTimestamp(task.created_at)}</div>
          {task.source === "auto_post_call" ? <div className="mt-1">создано AVA</div> : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-[#666666]">
        {task.phone ? (
          <span className="inline-flex items-center gap-2">
            <Phone size={12} />
            {task.phone}
          </span>
        ) : null}
        {task.customer_name ? (
          <span className="inline-flex items-center gap-2">
            <User size={12} />
            {task.customer_name}
          </span>
        ) : null}
        {task.assignee ? (
          <span className="inline-flex items-center gap-2">
            <ClipboardList size={12} />
            {task.assignee}
          </span>
        ) : null}
        {task.call_link ? (
          <Link
            to={task.call_link}
            className="underline underline-offset-4 hover:text-[#111111]"
          >
            Открыть звонок
          </Link>
        ) : null}
      </div>

      {nextStatuses.length ? (
        <div className="flex flex-wrap gap-2 border-t border-[#111111]/10 pt-4">
          {nextStatuses.map((status) => (
            <PillButton
              key={status}
              variant={status === "done" ? "solid" : "outline"}
              disabled={isUpdating}
              onClick={() => onStatusChange(task, status)}
              className="text-xs"
            >
              {STATUS_LABELS[status] || status}
            </PillButton>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

export default function TasksPage() {
  const queryClient = useQueryClient();
  const [businessIdInput, setBusinessIdInput] = useState("1");
  const [statusFilter, setStatusFilter] = useState("");

  const businessId = normalizePositiveInt(businessIdInput);

  const hotelsQuery = useQuery({
    queryKey: ["hotels"],
    queryFn: async () => (await api.get("/api/hotels")).data,
  });

  const tasksQuery = useQuery({
    queryKey: ["manager-tasks", businessId, statusFilter],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const params = { business_id: businessId };
      if (statusFilter) params.status = statusFilter;
      return (await api.get("/api/tasks", { params })).data;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ taskId, status }) =>
      (
        await api.patch(
          `/api/tasks/${encodeURIComponent(taskId)}`,
          { status },
          { params: { business_id: businessId } },
        )
      ).data,
    onSuccess: () => {
      toast.success("Статус задачи обновлён");
      queryClient.invalidateQueries({ queryKey: ["manager-tasks"] });
    },
    onError: (error) => {
      toast.error(error?.response?.data?.detail || "Не удалось обновить задачу");
    },
  });

  const counts = tasksQuery.data?.counts || {};
  const tasks = useMemo(() => tasksQuery.data?.tasks || [], [tasksQuery.data]);
  const profiles = hotelsQuery.data?.profiles || [];

  return (
    <AppShell>
      <PageHeader
        eyebrow="Передача менеджеру"
        title="Задачи менеджера"
        description="Сюда попадают обращения, которые AVA не должна завершать сама. Каждая задача относится только к одному бизнесу и связана с исходным звонком."
        actions={
          <PillButton
            variant="outline"
            onClick={() => tasksQuery.refetch()}
            disabled={tasksQuery.isFetching}
          >
            <span className="flex items-center gap-2">
              <RefreshCcw size={14} />
              Обновить
            </span>
          </PillButton>
        }
      />

      <Card className="mt-8 rounded-[24px] space-y-4">
        <div className="flex flex-wrap items-end gap-6">
          <label className="space-y-2">
            <span className="block text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Бизнес
            </span>
            <select
              value={businessIdInput}
              onChange={(event) => setBusinessIdInput(event.target.value)}
              className="rounded-full border border-[#111111] bg-transparent px-4 py-2 text-sm"
            >
              {profiles.length ? (
                profiles.map((profile) => {
                  const id = normalizePositiveInt(
                    profile?.business_id ?? profile?.businessId ?? profile?.id,
                  );
                  return (
                    <option key={id} value={String(id)}>
                      {profile.name} (#{id})
                    </option>
                  );
                })
              ) : (
                <option value="1">Бизнес #1</option>
              )}
            </select>
          </label>

          <div className="space-y-2">
            <span className="block text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Статус
            </span>
            <div className="flex flex-wrap gap-2">
              {STATUS_FILTERS.map(([value, label]) => (
                <PillButton
                  key={value || "all"}
                  variant={statusFilter === value ? "solid" : "outline"}
                  onClick={() => setStatusFilter(value)}
                  className="text-xs"
                >
                  {label}
                  {value && counts[value] ? ` (${counts[value]})` : ""}
                </PillButton>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <div className="mt-8 space-y-4 pb-16">
        {tasksQuery.isLoading ? (
          <LoadingBlock label="Загрузка задач" />
        ) : tasksQuery.isError ? (
          <EmptyState
            title="Не удалось загрузить задачи"
            description={
              tasksQuery.error?.response?.data?.detail ||
              "WhatsApp CRM недоступна. Проверьте соединение между сервисами."
            }
          />
        ) : tasks.length === 0 ? (
          <EmptyState
            title="Нет задач для менеджера"
            description="В этом бизнесе ничего не ожидает человека. Задачи появляются, когда гость просит менеджера или AVA не может безопасно продолжить разговор."
          />
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.task_id}
              task={task}
              isUpdating={updateMutation.isPending}
              onStatusChange={(target, status) =>
                updateMutation.mutate({ taskId: target.task_id, status })
              }
            />
          ))
        )}
      </div>
    </AppShell>
  );
}
