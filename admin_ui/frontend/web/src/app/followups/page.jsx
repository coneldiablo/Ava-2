import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  MessageSquare,
  Pencil,
  Phone,
  RefreshCcw,
  Send,
  ShieldCheck,
  X,
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
  ["draft", "На проверке"],
  ["approved", "Одобрены"],
  ["sent", "Отправлены"],
  ["failed", "Ошибка"],
  ["rejected", "Отклонены"],
];

const STATUS_LABELS = {
  draft: "На проверке",
  approved: "Одобрено",
  sent: "Отправлено",
  rejected: "Отклонено",
  failed: "Ошибка отправки",
};

const STATUS_ICONS = {
  draft: AlertTriangle,
  approved: ShieldCheck,
  sent: CheckCircle2,
  rejected: X,
  failed: AlertTriangle,
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
  const Icon = STATUS_ICONS[status] || MessageSquare;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#111111] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.25em]">
      <Icon size={12} />
      {STATUS_LABELS[status] || status}
    </span>
  );
}

function DraftCard({ draft, onAction, isBusy }) {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState(draft.text);

  // A refetch must not silently discard what the manager is typing.
  useEffect(() => {
    if (!isEditing) setText(draft.text);
  }, [draft.text, isEditing]);

  const isSent = draft.status === "sent";
  const canApprove = draft.status === "draft" || draft.status === "failed";
  const canReject = draft.status !== "sent" && draft.status !== "rejected";

  return (
    <Card className="rounded-[24px] space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={draft.status} />
          {draft.edited ? (
            <span className="rounded-full border border-[#111111]/30 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.25em] text-[#666666]">
              изменено
            </span>
          ) : null}
          {draft.source === "post_call" ? (
            <span className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
              после звонка
            </span>
          ) : null}
        </div>
        <div className="text-right text-[11px] uppercase tracking-[0.2em] text-[#838282]">
          {formatTimestamp(draft.created_at)}
        </div>
      </div>

      {isEditing ? (
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={4}
          maxLength={500}
          className="w-full rounded-[16px] border border-[#111111] bg-transparent p-4 text-sm leading-6"
        />
      ) : (
        <p className="whitespace-pre-wrap rounded-[16px] border border-[#111111]/10 bg-white/40 p-4 text-sm leading-6 text-[#111111]">
          {draft.text}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4 text-xs text-[#666666]">
        {draft.phone ? (
          <span className="inline-flex items-center gap-2">
            <Phone size={12} />
            {draft.phone}
          </span>
        ) : null}
        {draft.call_link ? (
          <Link to={draft.call_link} className="underline underline-offset-4 hover:text-[#111111]">
            Открыть звонок
          </Link>
        ) : null}
        {draft.manager_task_id ? (
          <Link to="/tasks" className="underline underline-offset-4 hover:text-[#111111]">
            Связанная задача
          </Link>
        ) : null}
        {draft.approved_by ? (
          <span>
            одобрил: {draft.approved_by} · {formatTimestamp(draft.approved_at)}
          </span>
        ) : null}
        {draft.sent_at ? <span>отправлено {formatTimestamp(draft.sent_at)}</span> : null}
        {draft.failure_reason ? (
          <span className="text-red-600">{draft.failure_reason}</span>
        ) : null}
      </div>

      {isSent ? null : (
        <div className="flex flex-wrap gap-2 border-t border-[#111111]/10 pt-4">
          {isEditing ? (
            <>
              <PillButton
                variant="solid"
                disabled={isBusy || !text.trim()}
                onClick={() => {
                  onAction(draft, { action: "edit", text: text.trim() });
                  setIsEditing(false);
                }}
                className="text-xs"
              >
                <span className="flex items-center gap-2">
                  <Check size={12} />
                  Сохранить
                </span>
              </PillButton>
              <PillButton
                variant="outline"
                disabled={isBusy}
                onClick={() => {
                  setText(draft.text);
                  setIsEditing(false);
                }}
                className="text-xs"
              >
                Отмена
              </PillButton>
            </>
          ) : (
            <>
              <PillButton
                variant="outline"
                disabled={isBusy}
                onClick={() => setIsEditing(true)}
                className="text-xs"
              >
                <span className="flex items-center gap-2">
                  <Pencil size={12} />
                  Изменить
                </span>
              </PillButton>
              {canApprove ? (
                <PillButton
                  variant="solid"
                  disabled={isBusy}
                  onClick={() => onAction(draft, { action: "approve" })}
                  className="text-xs"
                >
                  <span className="flex items-center gap-2">
                    <Send size={12} />
                    {draft.status === "failed" ? "Одобрить и повторить" : "Одобрить и отправить"}
                  </span>
                </PillButton>
              ) : null}
              {draft.status === "approved" ? (
                <PillButton
                  variant="solid"
                  disabled={isBusy}
                  onClick={() => onAction(draft, { action: "approve" })}
                  className="text-xs"
                >
                  <span className="flex items-center gap-2">
                    <Send size={12} />
                    Повторить отправку
                  </span>
                </PillButton>
              ) : null}
              {canReject ? (
                <PillButton
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => onAction(draft, { action: "reject" })}
                  className="text-xs"
                >
                  <span className="flex items-center gap-2">
                    <X size={12} />
                    Отклонить
                  </span>
                </PillButton>
              ) : null}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export default function FollowupsPage() {
  const queryClient = useQueryClient();
  const [businessIdInput, setBusinessIdInput] = useState("1");
  const [statusFilter, setStatusFilter] = useState("");

  const businessId = normalizePositiveInt(businessIdInput);

  const hotelsQuery = useQuery({
    queryKey: ["hotels"],
    queryFn: async () => (await api.get("/api/hotels")).data,
  });

  const draftsQuery = useQuery({
    queryKey: ["followups", businessId, statusFilter],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const params = { business_id: businessId };
      if (statusFilter) params.status = statusFilter;
      return (await api.get("/api/followups", { params })).data;
    },
  });

  const actionMutation = useMutation({
    mutationFn: async ({ draftId, body }) =>
      (
        await api.patch(`/api/followups/${encodeURIComponent(draftId)}`, body, {
          params: { business_id: businessId },
        })
      ).data,
    onSuccess: (data, variables) => {
      if (variables.body.action === "approve") {
        if (data.sent) {
          toast.success("Сообщение отправлено");
        } else if (data.requires_whatsapp_authorization) {
          toast.error("WhatsApp не авторизован — отсканируйте QR-код в настройках CRM");
        } else {
          toast.error(data.error || "Сообщение не отправлено");
        }
      } else {
        toast.success(variables.body.action === "reject" ? "Черновик отклонён" : "Черновик сохранён");
      }
      queryClient.invalidateQueries({ queryKey: ["followups"] });
    },
    onError: (error) => {
      toast.error(error?.response?.data?.detail || "Не удалось выполнить действие");
    },
  });

  const counts = draftsQuery.data?.counts || {};
  const policy = draftsQuery.data?.policy || {};
  const drafts = useMemo(() => draftsQuery.data?.drafts || [], [draftsQuery.data]);
  const profiles = hotelsQuery.data?.profiles || [];

  return (
    <AppShell>
      <PageHeader
        eyebrow="WhatsApp после звонка"
        title="Сообщения после звонка"
        description="AVA готовит сообщение по итогам разговора. Без разрешённой политики ничего не уйдёт гостю, пока менеджер не проверит и не одобрит текст."
        actions={
          <PillButton
            variant="outline"
            onClick={() => draftsQuery.refetch()}
            disabled={draftsQuery.isFetching}
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

        <p className="border-t border-[#111111]/10 pt-4 text-xs text-[#666666]">
          {policy.auto_send_enabled
            ? "Для этого бизнеса разрешена автоотправка: AVA может отправлять сообщения без ручного подтверждения."
            : "Требуется подтверждение менеджера: AVA создаёт черновик, но не отправляет его самостоятельно."}
        </p>
      </Card>

      <div className="mt-8 space-y-4 pb-16">
        {draftsQuery.isLoading ? (
          <LoadingBlock label="Загрузка сообщений" />
        ) : draftsQuery.isError ? (
          <EmptyState
            title="Не удалось загрузить сообщения"
            description={
              draftsQuery.error?.response?.data?.detail ||
              "WhatsApp CRM недоступна. Проверьте соединение между сервисами."
            }
          />
        ) : drafts.length === 0 ? (
          <EmptyState
            title="Нет сообщений на проверку"
            description="В этом бизнесе пока нет черновиков. Они появляются после звонков, когда гостю нужно отправить подтверждение или продолжить диалог в WhatsApp."
          />
        ) : (
          drafts.map((draft) => (
            <DraftCard
              key={draft.draft_id}
              draft={draft}
              isBusy={actionMutation.isPending}
              onAction={(target, body) =>
                actionMutation.mutate({ draftId: target.draft_id, body })
              }
            />
          ))
        )}
      </div>
    </AppShell>
  );
}
