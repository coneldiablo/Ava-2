import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Building2,
  Check,
  Clock3,
  Copy,
  Database,
  FileText,
  History,
  Loader2,
  Plug,
  RefreshCcw,
  MessageCircle,
  Phone,
  PlayCircle,
  Plus,
  Save,
  Search,
  Settings,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { Link } from "react-router";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";
import { getCoffeeCrmUrl } from "@/lib/config";
import { AvaMark } from "@/components/ui/AvaMark";
import { moduleDisplayText } from "@/lib/module-branding.mjs";

const DAYS = [
  ["mon", "Пн"],
  ["tue", "Вт"],
  ["wed", "Ср"],
  ["thu", "Чт"],
  ["fri", "Пт"],
  ["sat", "Сб"],
  ["sun", "Вс"],
];

const DEFAULT_HOURS = Object.fromEntries(
  DAYS.map(([key], index) => [
    key,
    { enabled: index < 5, start: "09:00", end: "18:00" },
  ]),
);

const DEFAULT_VALUES = {
  name: "",
  isActive: true,
  hotelTone: "",
  hotelTimezone: "Europe/Moscow",
  hotelWorkingHours: DEFAULT_HOURS,
  sipTrunkNumber: "",
  sipCallerId: "",
  sipAliasesInput: "",
  knowledgeBaseInstanceId: "",
  aiProvider: "openai_realtime",
  voiceName: "",
  voiceContextName: "unified_sales_agent",
  voiceGreetingTemplate: "",
  outboundOpenerTemplate: "",
};

function normalizePositiveInt(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function getBusinessId(profile) {
  return normalizePositiveInt(
    profile?.business_id ?? profile?.businessId ?? profile?.instance_id ?? profile?.instanceId,
  );
}

function displayBusinessId(profile) {
  return getBusinessId(profile) || "-";
}

function getWhatsAppStatus(profile) {
  const direct =
    profile?.whatsappStatus ||
    profile?.greenApiStatus ||
    profile?.whatsapp_status ||
    profile?.green_api_status;
  if (direct) return direct;

  const instance = profile?.greenApiInstance;
  if (instance && typeof instance === "object") {
    return (
      instance.status ||
      instance.state ||
      instance.instanceStatus ||
      instance.greenApiStatus ||
      "unknown"
    );
  }
  if (instance) return String(instance);
  return "unknown";
}

function getAiProvider(profile) {
  return profile?.aiProvider || profile?.ai_provider || profile?.providerName || "";
}

function getVoiceName(profile) {
  return profile?.voiceName || profile?.voice || "";
}

function getLeadCount(campaigns) {
  return campaigns.reduce(
    (sum, campaign) =>
      sum + Number(campaign.lead_count ?? campaign.total_leads ?? campaign.leads_count ?? 0),
    0,
  );
}

function scopedPath(path, businessId) {
  if (!businessId) return path;
  const params = new URLSearchParams({ business_id: String(businessId) });
  return `${path}?${params.toString()}`;
}

const TEXT_UPLOAD_DEFAULTS = {
  title: "",
  text: "",
};

const PMS_DEFAULTS = {
  enabled: false,
  account_id: "",
  api_password: "",
  currency: "RUB",
  enabled_room_type_ids: "",
  enabled_tariff_ids: "",
};

const TWENTY_DEFAULTS = {
  enabled: false,
  mode: "shadow",
  base_url: "",
  workspace_id: "",
  api_key: "",
  webhook_secret: "",
  public_base_url: "",
};

const ONYX_DEFAULTS = {
  base_url: "",
  credential_ref: "",
  cc_pair_id: "",
  onyx_version: "v4.7.0",
};

function textUploadDefaults(profile) {
  const hotelName = String(profile?.name || "hotel").trim();
  return { title: `${hotelName || "hotel"}-knowledge-base.md`, text: "" };
}

function knowledgeDraftKey(hotelId) {
  return `ava:hotel-kb-draft:${hotelId}`;
}

const SEARCH_DEFAULTS = {
  query: "",
};

function toFormValues(profile) {
  if (!profile) return DEFAULT_VALUES;
  return {
    ...DEFAULT_VALUES,
    name: profile.name || "",
    isActive: profile.isActive !== false,
    hotelTone: profile.hotelTone || "",
    hotelTimezone: profile.hotelTimezone || "Europe/Moscow",
    hotelWorkingHours: { ...DEFAULT_HOURS, ...(profile.hotelWorkingHours || {}) },
    sipTrunkNumber: profile.sipTrunkNumber || "",
    sipCallerId: profile.sipCallerId || "",
    sipAliasesInput: (profile.sipAliases || []).join(", "),
    knowledgeBaseInstanceId: profile.knowledgeBaseInstanceId || profile.instanceId || "",
    aiProvider: getAiProvider(profile),
    voiceName: getVoiceName(profile),
    voiceContextName: profile.voiceContextName || "unified_sales_agent",
    voiceGreetingTemplate: profile.voiceGreetingTemplate || "",
    outboundOpenerTemplate: profile.outboundOpenerTemplate || "",
  };
}

function toPayload(values) {
  return {
    name: values.name?.trim(),
    isActive: Boolean(values.isActive),
    hotelTone: values.hotelTone?.trim(),
    hotelTimezone: values.hotelTimezone?.trim() || "UTC",
    hotelWorkingHours: values.hotelWorkingHours || DEFAULT_HOURS,
    sipTrunkNumber: values.sipTrunkNumber?.trim(),
    sipCallerId: values.sipCallerId?.trim(),
    sipAliases: String(values.sipAliasesInput || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    knowledgeBaseInstanceId: values.knowledgeBaseInstanceId
      ? Number(values.knowledgeBaseInstanceId)
      : undefined,
    aiProvider: values.aiProvider?.trim() || "openai_realtime",
    voiceName: values.voiceName?.trim(),
    voiceContextName: values.voiceContextName?.trim() || "unified_sales_agent",
    voiceGreetingTemplate: values.voiceGreetingTemplate?.trim(),
    outboundOpenerTemplate: values.outboundOpenerTemplate?.trim(),
  };
}

async function fetchHotels() {
  const response = await api.get("/api/hotels");
  return response.data?.profiles || [];
}

async function fetchHotelKnowledgeBase(hotelId) {
  const response = await api.get(`/api/hotels/${hotelId}/knowledge-base`);
  return response.data;
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export default function HotelsPage() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [searchResult, setSearchResult] = useState(null);
  const [searchError, setSearchError] = useState("");
  const searchController = useRef(null);
  const [twentyWebhookReveal, setTwentyWebhookReveal] = useState(null);

  const hotelsQuery = useQuery({
    queryKey: ["hotels"],
    queryFn: fetchHotels,
  });

  const hotels = hotelsQuery.data || [];
  const selectedProfile = useMemo(
    () => hotels.find((hotel) => hotel.id === editing?.id) || null,
    [hotels, editing],
  );
  const selectedBusinessId = useMemo(() => getBusinessId(selectedProfile), [selectedProfile]);

  const campaignsQuery = useQuery({
    queryKey: ["hotel-campaigns", selectedBusinessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: async () => {
      const params = new URLSearchParams({
        include_archived: "true",
        business_id: String(selectedBusinessId),
      });
      const response = await api.get(`/api/outbound/campaigns?${params.toString()}`);
      return response.data || [];
    },
  });

  const callStatsQuery = useQuery({
    queryKey: ["hotel-call-stats", selectedBusinessId],
    enabled: Boolean(selectedBusinessId),
    queryFn: async () => {
      const response = await api.get(`/api/calls/stats?business_id=${selectedBusinessId}`);
      return response.data;
    },
  });

  const selectedHotelId = editing?.id || null;
  const selectedHotelIdRef = useRef(selectedHotelId);
  selectedHotelIdRef.current = selectedHotelId;

  const pmsQuery = useQuery({
    queryKey: ["hotel-pms", selectedHotelId],
    enabled: Boolean(selectedHotelId),
    queryFn: async () => {
      const response = await api.get(`/api/hotels/${selectedHotelId}/pms`);
      return response.data?.pms || null;
    },
  });

  const pmsBookingsQuery = useQuery({
    queryKey: ["hotel-pms-bookings", selectedHotelId],
    enabled: Boolean(selectedHotelId && pmsQuery.data?.credentials_configured),
    queryFn: async () => {
      const response = await api.get(`/api/hotels/${selectedHotelId}/pms/bookings?limit=100`);
      return response.data?.bookings || [];
    },
  });

  const pmsRequestsQuery = useQuery({
    queryKey: ["hotel-pms-requests", selectedHotelId],
    enabled: Boolean(selectedHotelId && pmsQuery.data?.credentials_configured),
    queryFn: async () => {
      const response = await api.get(`/api/hotels/${selectedHotelId}/pms/booking-requests?limit=100`);
      return response.data?.booking_requests || [];
    },
  });

  const twentyQuery = useQuery({
    queryKey: ["hotel-twenty", selectedHotelId],
    enabled: Boolean(selectedHotelId),
    queryFn: async () => {
      const response = await api.get(`/api/hotels/${selectedHotelId}/twenty`);
      return response.data?.twenty || null;
    },
  });

  const onyxQuery = useQuery({
    queryKey: ["hotel-onyx", selectedHotelId],
    enabled: Boolean(selectedHotelId),
    queryFn: async () => {
      const response = await api.get(`/api/onyx/tenants/${selectedHotelId}`);
      return response.data?.onyx || null;
    },
  });
  const onyxCriteriaQuery = useQuery({
    queryKey: ["hotel-onyx-criteria", selectedHotelId],
    enabled: Boolean(selectedHotelId && onyxQuery.data?.configured),
    queryFn: async () => {
      const response = await api.get(`/api/onyx/cutover/criteria?business_id=${selectedHotelId}`);
      return response.data;
    },
  });

  const kbQuery = useQuery({
    queryKey: ["hotel-kb", selectedHotelId],
    enabled: Boolean(selectedHotelId),
    queryFn: () => fetchHotelKnowledgeBase(selectedHotelId),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm({
    defaultValues: DEFAULT_VALUES,
  });
  const textForm = useForm({
    defaultValues: TEXT_UPLOAD_DEFAULTS,
  });
  const pmsForm = useForm({ defaultValues: PMS_DEFAULTS });
  const twentyForm = useForm({ defaultValues: TWENTY_DEFAULTS });
  const onyxForm = useForm({ defaultValues: ONYX_DEFAULTS });
  const searchForm = useForm({
    defaultValues: SEARCH_DEFAULTS,
  });

  useEffect(() => {
    reset(toFormValues(selectedProfile));
  }, [reset, selectedProfile]);

  useEffect(() => {
    if (!editing && hotels.length) {
      const firstHotel = hotels[0];
      setEditing({ id: firstHotel.id, businessId: getBusinessId(firstHotel) });
    }
  }, [editing, hotels]);

  useEffect(() => {
    searchController.current?.abort();
    searchController.current = null;
    setSearchResult(null);
    setSearchError("");
    setSelectedFiles([]);
    if (selectedHotelId) {
      let draft = null;
      try { draft = JSON.parse(localStorage.getItem(knowledgeDraftKey(selectedHotelId)) || "null"); } catch { draft = null; }
      textForm.reset(draft?.text ? draft : textUploadDefaults(selectedProfile));
    } else {
      textForm.reset(TEXT_UPLOAD_DEFAULTS);
    }
    searchForm.reset(SEARCH_DEFAULTS);
  }, [selectedHotelId, selectedProfile?.name]);

  useEffect(() => {
    if (!selectedHotelId) return undefined;
    const subscription = textForm.watch((value) => {
      localStorage.setItem(knowledgeDraftKey(selectedHotelId), JSON.stringify({ title: value.title || "", text: value.text || "" }));
    });
    return () => subscription.unsubscribe();
  }, [selectedHotelId, textForm]);

  useEffect(() => {
    const pms = pmsQuery.data;
    pmsForm.reset(pms ? {
      enabled: Boolean(pms.enabled),
      account_id: pms.masked_account || "",
      api_password: "",
      currency: pms.currency || "RUB",
      enabled_room_type_ids: (pms.mappings?.enabled_room_type_ids || []).join(", "),
      enabled_tariff_ids: (pms.mappings?.enabled_tariff_ids || []).join(", "),
    } : PMS_DEFAULTS);
  }, [pmsForm, pmsQuery.data, selectedHotelId]);

  useEffect(() => {
    const twenty = twentyQuery.data;
    setTwentyWebhookReveal(null);
    twentyForm.reset(twenty ? {
      enabled: Boolean(twenty.enabled),
      mode: twenty.mode || "shadow",
      base_url: twenty.base_url || "",
      workspace_id: twenty.workspace_id || "",
      api_key: "",
      webhook_secret: "",
      public_base_url: "",
    } : TWENTY_DEFAULTS);
  }, [twentyForm, twentyQuery.data, selectedHotelId]);

  useEffect(() => {
    const onyx = onyxQuery.data;
    onyxForm.reset(onyx?.configured ? {
      base_url: onyx.base_url || "",
      credential_ref: "",
      cc_pair_id: onyx.cc_pair_id || "",
      onyx_version: onyx.onyx_version || "v4.7.0",
    } : ONYX_DEFAULTS);
  }, [onyxForm, onyxQuery.data, selectedHotelId]);

  const createMutation = useMutation({
    mutationFn: async (payload) => {
      const response = await api.post("/api/hotels", payload);
      return response.data?.profile;
    },
    onSuccess: async (profile) => {
      await queryClient.invalidateQueries({ queryKey: ["hotels"] });
      setEditing({ id: profile?.id, businessId: getBusinessId(profile) });
      toast.success("Профиль бизнеса создан и доступен в AVA и CRM.");
    },
    onError: (error) => {
      toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось создать профиль бизнеса."));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, payload }) => {
      const response = await api.put(`/api/hotels/${id}`, payload);
      return response.data?.profile;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["hotels"] });
      toast.success("Профиль бизнеса сохранён.");
    },
    onError: (error) => {
      toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось сохранить профиль бизнеса."));
    },
  });

  async function invalidateKnowledgeBase(hotelId = selectedHotelId) {
    if (!hotelId) return;
    await queryClient.invalidateQueries({ queryKey: ["hotel-kb", hotelId] });
  }

  const uploadFilesMutation = useMutation({
    mutationFn: async ({ hotelId, files }) => {
      const formData = new FormData();
      Array.from(files || []).forEach((file) => formData.append("files", file));
      const response = await api.post(`/api/hotels/${hotelId}/knowledge-base/upload`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return response.data;
    },
    onSuccess: async (_data, variables) => {
      setSelectedFiles([]);
      await invalidateKnowledgeBase(variables.hotelId);
      toast.success("Файлы добавлены в базу знаний.");
    },
    onError: (error) => {
      toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось загрузить файлы базы знаний."));
    },
  });

  const uploadTextMutation = useMutation({
    mutationFn: async ({ hotelId, payload }) => {
      const response = await api.post(`/api/hotels/${hotelId}/knowledge-base/text`, payload);
      return response.data;
    },
    onSuccess: async (_data, variables) => {
      localStorage.removeItem(knowledgeDraftKey(variables.hotelId));
      textForm.reset(textUploadDefaults(selectedProfile));
      await invalidateKnowledgeBase(variables.hotelId);
      toast.success("Текст добавлен в базу знаний.");
    },
    onError: (error) => {
      toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось загрузить текст базы знаний."));
    },
  });

  const deleteDocumentMutation = useMutation({
    mutationFn: async ({ hotelId, fileId }) => {
      const response = await api.delete(`/api/hotels/${hotelId}/knowledge-base/${fileId}`);
      return response.data;
    },
    onSuccess: async (_data, variables) => {
      await invalidateKnowledgeBase(variables.hotelId);
      toast.success("Документ удалён из базы знаний.");
    },
    onError: (error) => {
      toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось удалить документ базы знаний."));
    },
  });

  const searchKnowledgeMutation = useMutation({
    mutationFn: async ({ hotelId, payload, controller }) => {
      const response = await api.post(`/api/hotels/${hotelId}/knowledge-base/search`, payload, { signal: controller.signal });
      return response.data;
    },
    onSuccess: (data, variables) => {
      if (variables.controller.signal.aborted || variables.hotelId !== selectedHotelIdRef.current) return;
      if (!Array.isArray(data?.results)) {
        setSearchError("Не удалось выполнить поиск. Повторите запрос.");
        return;
      }
      setSearchResult({ hotelId: variables.hotelId, data });
    },
    onError: (error, variables) => {
      if (variables.controller.signal.aborted || variables.hotelId !== selectedHotelIdRef.current) return;
      setSearchError(moduleDisplayText(error?.response?.data?.detail || "Поиск по базе знаний не выполнен."));
    },
    onSettled: (_data, _error, variables) => {
      if (searchController.current === variables.controller) searchController.current = null;
    },
  });

  const smokeTestMutation = useMutation({
    mutationFn: async ({ hotelId }) => {
      const response = await api.post(`/api/hotels/${hotelId}/knowledge-base/smoke-test`, {});
      return response.data;
    },
    onError: (error) => {
      toast.error(moduleDisplayText(error?.response?.data?.detail || "Проверка базы знаний не выполнена."));
    },
  });

  async function refreshPms() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["hotel-pms", selectedHotelId] }),
      queryClient.invalidateQueries({ queryKey: ["hotel-pms-bookings", selectedHotelId] }),
      queryClient.invalidateQueries({ queryKey: ["hotel-pms-requests", selectedHotelId] }),
      queryClient.invalidateQueries({ queryKey: ["hotels"] }),
    ]);
  }

  const savePmsMutation = useMutation({
    mutationFn: async (values) => {
      const list = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
      const payload = {
        provider: "bnovo",
        enabled: Boolean(values.enabled),
        account_id: values.account_id,
        api_password: values.api_password || undefined,
        currency: values.currency || "RUB",
        mappings: {
          enabled_room_type_ids: list(values.enabled_room_type_ids),
          enabled_tariff_ids: list(values.enabled_tariff_ids),
        },
      };
      const response = await api.put(`/api/hotels/${selectedHotelId}/pms`, payload);
      return response.data;
    },
    onSuccess: async () => { await refreshPms(); toast.success("Настройки Bnovo сохранены. Сначала проверьте подключение, затем включайте инструменты."); },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось сохранить Bnovo.")),
  });

  function usePmsActionMutation(path, successMessage, method = "post") {
    return useMutation({
      mutationFn: async () => api[method](`/api/hotels/${selectedHotelId}/pms${path}`, {}),
      onSuccess: async () => { await refreshPms(); toast.success(successMessage); },
      onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Операция Bnovo не выполнена.")),
    });
  }

  const testPmsMutation = usePmsActionMutation("/test", "Подключение Bnovo подтверждено.");
  const syncPmsMutation = usePmsActionMutation("/sync", "Начальная синхронизация Bnovo поставлена в очередь.");
  const webhookPmsMutation = usePmsActionMutation("/webhooks", "Webhooks Bnovo подключаются; активация может занять до 24 часов.");
  const disconnectPmsMutation = useMutation({
    mutationFn: async () => api.delete(`/api/hotels/${selectedHotelId}/pms`),
    onSuccess: async () => { await refreshPms(); toast.success("Интеграция Bnovo отключена и учётные данные удалены."); },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось отключить Bnovo.")),
  });

  async function refreshTwenty() {
    await queryClient.invalidateQueries({ queryKey: ["hotel-twenty", selectedHotelId] });
  }

  const saveTwentyMutation = useMutation({
    mutationFn: async (values) => {
      const response = await api.put(`/api/hotels/${selectedHotelId}/twenty`, {
        enabled: Boolean(values.enabled),
        mode: values.mode || "shadow",
        base_url: values.base_url?.trim(),
        workspace_id: values.workspace_id?.trim() || undefined,
        api_key: values.api_key?.trim() || undefined,
        webhook_secret: values.webhook_secret?.trim() || undefined,
      });
      return response.data?.twenty;
    },
    onSuccess: async () => {
      setTwentyWebhookReveal(null);
      await refreshTwenty();
      toast.success("Настройки AVA CRM сохранены.");
    },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось сохранить AVA CRM.")),
  });

  function useTwentyActionMutation(path, successMessage) {
    return useMutation({
      mutationFn: async (payload = {}) => api.post(`/api/hotels/${selectedHotelId}/twenty${path}`, payload),
      onSuccess: async () => { await refreshTwenty(); toast.success(successMessage); },
      onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Операция AVA CRM не выполнена.")),
    });
  }

  const testTwentyMutation = useTwentyActionMutation("/test", "Подключение AVA CRM подтверждено.");
  const syncTwentyMutation = useTwentyActionMutation("/sync", "Синхронизация с AVA CRM поставлена в очередь.");
  const webhookTwentyMutation = useMutation({
    mutationFn: async (publicBaseUrl) => {
      const response = await api.post(`/api/hotels/${selectedHotelId}/twenty/webhook`, {
        public_base_url: publicBaseUrl?.trim() || undefined,
      });
      return response.data?.twenty;
    },
    onSuccess: async (twenty) => {
      setTwentyWebhookReveal({
        url: twenty?.webhook_url || "",
        secret: twenty?.webhook_secret_once || "",
      });
      await refreshTwenty();
      toast.success("Данные webhook подготовлены. Добавьте их в настройках AVA CRM.");
    },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось подготовить webhook AVA CRM.")),
  });
  const disconnectTwentyMutation = useMutation({
    mutationFn: async () => api.delete(`/api/hotels/${selectedHotelId}/twenty`),
    onSuccess: async () => {
      setTwentyWebhookReveal(null);
      await refreshTwenty();
      toast.success("AVA CRM отключён, ключи и очередь этого бизнеса удалены.");
    },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail || "Не удалось отключить AVA CRM.")),
  });

  async function refreshOnyx() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["hotel-onyx", selectedHotelId] }),
      queryClient.invalidateQueries({ queryKey: ["hotel-onyx-criteria", selectedHotelId] }),
    ]);
  }

  const saveOnyxMutation = useMutation({
    mutationFn: async (values) => {
      const response = await api.put(`/api/onyx/tenants/${selectedHotelId}`, {
        base_url: values.base_url?.trim(),
        credential_ref: values.credential_ref?.trim() || undefined,
        cc_pair_id: Number(values.cc_pair_id),
        onyx_version: values.onyx_version?.trim() || "v4.7.0",
      });
      return response.data?.onyx;
    },
    onSuccess: async () => { await refreshOnyx(); toast.success("Связь AVA Знания сохранена. Теперь проверьте подключение."); },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Не удалось сохранить AVA Знания.")),
  });
  function useOnyxActionMutation(path, successMessage) {
    return useMutation({
      mutationFn: async () => api.post(`/api/onyx/tenants/${selectedHotelId}${path}`, {}),
      onSuccess: async () => { await refreshOnyx(); toast.success(successMessage); },
      onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Операция AVA Знания не выполнена.")),
    });
  }
  const testOnyxMutation = useOnyxActionMutation("/test", "AVA Знания и выделенный контур отеля доступны.");
  const syncOnyxMutation = useOnyxActionMutation("/sync", "Документы отеля поставлены в очередь AVA Знания.");
  const disableOnyxMutation = useMutation({
    mutationFn: async () => api.delete(`/api/onyx/tenants/${selectedHotelId}`),
    onSuccess: async () => { await refreshOnyx(); toast.success("AVA Знания отключён для этого бизнеса; AVA продолжает работать локально."); },
    onError: (error) => toast.error(moduleDisplayText(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Не удалось отключить AVA Знания.")),
  });

  const saving = createMutation.isPending || updateMutation.isPending;
  const kbBusy =
    uploadFilesMutation.isPending ||
    uploadTextMutation.isPending ||
    deleteDocumentMutation.isPending ||
    searchKnowledgeMutation.isPending ||
    smokeTestMutation.isPending;
  const pmsBusy = savePmsMutation.isPending || testPmsMutation.isPending || syncPmsMutation.isPending
    || webhookPmsMutation.isPending || disconnectPmsMutation.isPending;
  const twentyBusy = saveTwentyMutation.isPending || testTwentyMutation.isPending
    || syncTwentyMutation.isPending || webhookTwentyMutation.isPending
    || disconnectTwentyMutation.isPending;
  const onyxBusy = saveOnyxMutation.isPending || testOnyxMutation.isPending
    || syncOnyxMutation.isPending || disableOnyxMutation.isPending;

  function startCreate() {
    setEditing({ id: null });
    reset(DEFAULT_VALUES);
  }

  function submit(values) {
    const payload = toPayload(values);
    if (editing?.id) {
      const current = hotels.find((hotel) => hotel.id === editing.id);
      const currentBusinessId = getBusinessId(current);
      if (!current || currentBusinessId !== editing.businessId) {
        toast.error(moduleDisplayText("Выбранный бизнес изменился. Выберите его заново перед сохранением."));
        return;
      }
      updateMutation.mutate({ id: currentBusinessId || editing.id, payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  function submitFileUpload() {
    if (!selectedHotelId || selectedFiles.length === 0) return;
    uploadFilesMutation.mutate({ hotelId: selectedHotelId, files: selectedFiles });
  }

  function submitTextUpload(values) {
    if (!selectedHotelId) return;
    uploadTextMutation.mutate({
      hotelId: selectedHotelId,
      payload: {
        title: values.title?.trim() || textUploadDefaults(selectedProfile).title,
        text: values.text?.trim(),
      },
    });
  }

  function submitKnowledgeSearch(values) {
    if (!selectedHotelId || !values.query?.trim()) return;
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    setSearchResult(null);
    setSearchError("");
    searchKnowledgeMutation.mutate({
      hotelId: selectedHotelId,
      payload: { query: values.query?.trim(), searchType: "hybrid", k: 5 },
      controller,
    });
  }

  function clearKnowledgeSearch() {
    searchController.current?.abort();
    searchController.current = null;
    setSearchResult(null);
    setSearchError("");
  }

  if (hotelsQuery.isPending) {
    return (
      <AppShell>
        <LoadingBlock label="Загрузка бизнесов" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Единый справочник AVA + CRM"
          title="Бизнесы и отели"
          description="Создайте бизнес один раз: тот же ID используется для WhatsApp, звонков, кампаний, клиентской памяти, SIP и базы знаний."
          actions={
            <>
              <PillButton variant="solid" onClick={startCreate}>
                <span className="flex items-center gap-2">
                  <Plus size={14} />
                  Добавить бизнес
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

        <Card className="rounded-[24px] border-emerald-200 bg-emerald-50 p-5">
          <div className="flex items-start gap-3">
            <Check className="mt-0.5 shrink-0 text-emerald-700" size={18} />
            <div>
              <p className="font-bold text-emerald-950">Бизнесы синхронизируются автоматически</p>
              <p className="mt-1 text-sm leading-6 text-emerald-900/75">
                Это один справочник, а не две независимые системы. Бизнес из WhatsApp CRM
                виден здесь с тем же ID; изменения профиля не создают копию и не смешивают данные других отелей.
              </p>
            </div>
          </div>
        </Card>

        {!hotels.length && !editing ? (
          <EmptyState
            title="Бизнесов пока нет"
            description="Создайте первый бизнес — он одновременно появится в AVA и WhatsApp CRM."
            actionLabel="Добавить бизнес"
            onAction={startCreate}
          />
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]">
          <div className="grid gap-4 md:grid-cols-2">
            {hotels.map((hotel) => (
              <Card
                key={hotel.id}
                className={`rounded-[28px] p-6 ${
                  hotel.id === editing?.id ? "border-[#111111] bg-white" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#111111] text-white">
                    <Building2 size={18} />
                  </div>
                  <span className="rounded-full border border-[#111111]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#555555]">
                    #{displayBusinessId(hotel)}
                  </span>
                </div>
                <h3 className="mt-5 font-clash-display text-3xl font-bold uppercase">
                  {hotel.name}
                </h3>
                <div className="mt-4 grid gap-2 text-sm text-[#555555]">
                  <span>Часовой пояс: {hotel.hotelTimezone || "UTC"}</span>
                  <span>WhatsApp {getWhatsAppStatus(hotel)}</span>
                  <span>SIP: {hotel.sipTrunkNumber || "не настроен"}</span>
                  <span>Caller ID: {hotel.sipCallerId || "не настроен"}</span>
                  <span>AI {getAiProvider(hotel)} / {getVoiceName(hotel)}</span>
                  <span>SIP-алиасы: {(hotel.sipAliases || []).join(", ") || "нет"}</span>
                  <span>База знаний: #{hotel.knowledgeBaseInstanceId || hotel.instanceId}</span>
                </div>
                <div className="mt-5 flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-[#555555]">
                    <Check size={14} />
                    {hotel.isActive ? "Активен" : "Отключён"}
                  </span>
                  <PillButton onClick={() => setEditing({ id: hotel.id, businessId: getBusinessId(hotel) })}>
                    <span className="flex items-center gap-2">
                      <Settings size={14} />
                      Настроить
                    </span>
                  </PillButton>
                </div>
              </Card>
            ))}
          </div>

          {editing ? (
            <div className="space-y-4">
              <Card className="rounded-[28px] p-6">
              <form className="space-y-5" onSubmit={handleSubmit(submit)}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#838282]">
                      {editing.id ? "Настройка бизнеса" : "Новый бизнес"}
                    </p>
                    <h2 className="mt-2 font-clash-display text-3xl font-bold uppercase">
                      Профиль
                    </h2>
                  </div>
                  <button
                    type="button"
                    className="rounded-full border border-[#111111]/10 p-2 hover:bg-[#111111] hover:text-white"
                    onClick={() => setEditing(null)}
                    aria-label="Закрыть форму"
                  >
                    <X size={16} />
                  </button>
                </div>

                {selectedProfile ? (
                  <div className="grid gap-3 border border-[#111111]/10 bg-white p-4 md:grid-cols-2">
                    <ProfileMetric icon={Building2} label="Бизнес" value={`#${displayBusinessId(selectedProfile)}`} />
                    <ProfileMetric icon={MessageCircle} label="WhatsApp" value={getWhatsAppStatus(selectedProfile)} />
                    <ProfileMetric icon={Phone} label="SIP" value={selectedProfile.sipTrunkNumber || "не настроен"} />
                    <ProfileMetric icon={Phone} label="Caller ID" value={selectedProfile.sipCallerId || "не настроен"} />
                    <ProfileMetric icon={Bot} label="AI-провайдер" value={getAiProvider(selectedProfile)} />
                    <ProfileMetric icon={Bot} label="Голос" value={getVoiceName(selectedProfile)} />
                    <ProfileMetric icon={Users} label="Кампании" value={String(campaignsQuery.data?.length || 0)} />
                    <ProfileMetric icon={History} label="Звонки" value={String(callStatsQuery.data?.total_calls || 0)} />
                    <ProfileMetric icon={Users} label="Клиенты" value={String(getLeadCount(campaignsQuery.data || []))} />
                    <div className="flex flex-wrap gap-2 md:col-span-2">
                      <Link to={scopedPath("/scheduling", selectedBusinessId)}>
                        <PillButton type="button">Кампании</PillButton>
                      </Link>
                      <Link to={scopedPath("/history", selectedBusinessId)}>
                        <PillButton type="button">История звонков</PillButton>
                      </Link>
                    </div>
                  </div>
                ) : null}

                <Field label="Название бизнеса" error={errors.name?.message}>
                  <input
                    className="input"
                    {...register("name", { required: "Укажите название бизнеса." })}
                  />
                </Field>

                <Field label="Тон общения">
                  <textarea className="input min-h-24" {...register("hotelTone")} />
                </Field>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Часовой пояс">
                    <input className="input" {...register("hotelTimezone", { required: true })} />
                  </Field>
                  <Field label="ID WhatsApp / базы знаний">
                    <input className="input" type="number" min="1" {...register("knowledgeBaseInstanceId")} />
                  </Field>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="SIP-транк">
                    <input className="input" {...register("sipTrunkNumber")} />
                  </Field>
                  <Field label="Caller ID">
                    <input className="input" {...register("sipCallerId")} />
                  </Field>
                </div>

                <Field label="SIP-алиасы входящих номеров">
                  <input className="input" placeholder="74951234567, 1001" {...register("sipAliasesInput")} />
                </Field>

                <Field label="Контекст голосового ассистента">
                  <input className="input" {...register("voiceContextName", { required: true })} />
                </Field>

                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="AI-провайдер">
                    <input className="input" list="hotel-ai-providers" {...register("aiProvider")} />
                    <datalist id="hotel-ai-providers">
                      <option value="google_live" />
                      <option value="openai_realtime" />
                      <option value="deepgram" />
                    </datalist>
                  </Field>
                  <Field label="Голос">
                    <input className="input" list="hotel-voices" placeholder="По умолчанию провайдера" {...register("voiceName")} />
                    <datalist id="hotel-voices"><option value="Aoede" /><option value="alloy" /></datalist>
                  </Field>
                </div>

                <Field label="Приветствие при входящем звонке">
                  <textarea
                    className="input min-h-20"
                    placeholder="Здравствуйте, это {hotel_name}. Чем могу помочь?"
                    {...register("voiceGreetingTemplate")}
                  />
                </Field>

                <Field label="Первая фраза исходящего звонка">
                  <textarea
                    className="input min-h-20"
                    placeholder="Здравствуйте, это Анастасия из {hotel_name}."
                    {...register("outboundOpenerTemplate")}
                  />
                </Field>

                <div>
                  <p className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.26em] text-[#777777]">
                    <Clock3 size={14} />
                    Часы работы
                  </p>
                  <div className="grid gap-2">
                    {DAYS.map(([key, label]) => (
                      <div key={key} className="grid grid-cols-[70px_1fr_1fr_auto] items-center gap-2">
                        <span className="text-xs font-bold uppercase text-[#555555]">{label}</span>
                        <input className="input" type="time" {...register(`hotelWorkingHours.${key}.start`)} />
                        <input className="input" type="time" {...register(`hotelWorkingHours.${key}.end`)} />
                        <input type="checkbox" className="h-5 w-5" {...register(`hotelWorkingHours.${key}.enabled`)} />
                      </div>
                    ))}
                  </div>
                </div>

                <label className="flex items-center gap-3 text-sm font-semibold text-[#333333]">
                  <input type="checkbox" className="h-5 w-5" {...register("isActive")} />
                  Бизнес активен
                </label>

                <PillButton
                  type="submit"
                  variant="solid"
                  disabled={saving || (!isDirty && Boolean(editing.id))}
                  className="w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex items-center justify-center gap-2">
                    <Save size={14} />
                    {saving ? "Сохранение" : "Сохранить"}
                  </span>
                </PillButton>
              </form>
              </Card>

              {editing.id ? (
                <PmsPanel
                  pms={pmsQuery.data}
                  loading={pmsQuery.isPending}
                  form={pmsForm}
                  busy={pmsBusy}
                  bookings={pmsBookingsQuery.data || []}
                  requests={pmsRequestsQuery.data || []}
                  onSave={(values) => savePmsMutation.mutate(values)}
                  onTest={() => testPmsMutation.mutate()}
                  onSync={() => syncPmsMutation.mutate()}
                  onWebhooks={() => webhookPmsMutation.mutate()}
                  onDisconnect={() => {
                    if (window.confirm("Удалить учётные данные Bnovo для этого бизнеса?")) disconnectPmsMutation.mutate();
                  }}
                />
              ) : null}

              {editing.id ? (
                <TwentyPanel
                  twenty={twentyQuery.data}
                  loading={twentyQuery.isPending}
                  form={twentyForm}
                  busy={twentyBusy}
                  webhookReveal={twentyWebhookReveal}
                  onSave={(values) => saveTwentyMutation.mutate(values)}
                  onTest={() => testTwentyMutation.mutate({})}
                  onSync={() => syncTwentyMutation.mutate({})}
                  onWebhook={(publicBaseUrl) => webhookTwentyMutation.mutate(publicBaseUrl)}
                  onDisconnect={() => {
                    if (window.confirm("Отключить AVA CRM и удалить ключи синхронизации этого бизнеса?")) disconnectTwentyMutation.mutate();
                  }}
                />
              ) : null}

              {editing.id ? (
                <OnyxPanel
                  onyx={onyxQuery.data}
                  criteria={onyxCriteriaQuery.data}
                  loading={onyxQuery.isPending}
                  form={onyxForm}
                  busy={onyxBusy}
                  onSave={(values) => saveOnyxMutation.mutate(values)}
                  onTest={() => testOnyxMutation.mutate()}
                  onSync={() => syncOnyxMutation.mutate()}
                  onDisable={() => {
                    if (window.confirm("Отключить AVA Знания для этого бизнеса? Локальная AVA продолжит работу.")) disableOnyxMutation.mutate();
                  }}
                />
              ) : null}

              {editing.id ? (
                <KnowledgeBasePanel
                  hotel={selectedProfile}
                  kbData={kbQuery.data}
                  loading={kbQuery.isPending}
                  busy={kbBusy}
                  selectedFiles={selectedFiles}
                  onFilesChange={setSelectedFiles}
                  onFileUpload={submitFileUpload}
                  textForm={textForm}
                  onTextUpload={submitTextUpload}
                  searchForm={searchForm}
                  onSearch={submitKnowledgeSearch}
                  searchResult={searchResult?.hotelId === selectedHotelId ? searchResult.data : null}
                  searchError={searchError}
                  onSearchChange={clearKnowledgeSearch}
                  searching={searchKnowledgeMutation.isPending}
                  smokeResult={smokeTestMutation.data}
                  onSmoke={() => smokeTestMutation.mutate({ hotelId: selectedHotelId })}
                  onDelete={(fileId) =>
                    deleteDocumentMutation.mutate({ hotelId: selectedHotelId, fileId })
                  }
                />
              ) : (
                <Card className="rounded-[28px] p-6">
                  <div className="flex items-center gap-3 text-sm font-semibold text-[#555555]">
                    <Database size={18} />
                    Сначала сохраните профиль бизнеса, затем загрузите его базу знаний.
                  </div>
                </Card>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}

function PmsPanel({ pms, loading, form, busy, bookings, requests, onSave, onTest, onSync, onWebhooks, onDisconnect }) {
  const statusLabels = {
    not_tested: "Не проверено",
    connected: "Подключено",
    error: "Ошибка",
    idle: "Ожидает",
    queued: "В очереди",
    healthy: "Работает",
    retrying: "Повторная попытка",
    not_configured: "Не настроены",
    activation_pending: "Активация до 24 часов",
    receiving: "События поступают",
  };
  const enabled = form.watch("enabled");

  return (
    <Card className="rounded-[28px] p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#838282]">PMS</p>
          <h2 className="mt-2 font-clash-display text-3xl font-bold uppercase">Bnovo Professional v2</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${pms?.enabled ? "border-emerald-300 text-emerald-700" : "border-[#111111]/15 text-[#666666]"}`}>
          {pms?.enabled ? "Инструменты включены" : "Инструменты выключены"}
        </span>
      </div>

      <p className="mt-3 text-sm leading-6 text-[#555555]">
        Bnovo — источник бронирований, наличия и тарифов. AVA работает только на чтение;
        новая бронь создаётся как заявка менеджеру, без изменения Bnovo.
      </p>

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} />Загрузка PMS</div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Metric label="Подключение" value={statusLabels[pms?.connection_status] || pms?.connection_status || "Не настроено"} />
            <Metric label="Bnovo hotel ID" value={pms?.external_hotel_id || "—"} />
            <Metric label="Синхронизация" value={statusLabels[pms?.polling_status] || pms?.polling_status || "—"} />
            <Metric label="Webhooks" value={statusLabels[pms?.webhook_status] || pms?.webhook_status || "—"} />
            <Metric label="Очередь PMS" value={String(Object.values(pms?.diagnostics?.queue_depth || {}).reduce((sum, value) => sum + Number(value || 0), 0))} />
            <Metric label="Запросы / ошибки 24ч" value={`${pms?.diagnostics?.requests_24h || 0} / ${pms?.diagnostics?.errors_24h || 0}`} />
          </div>
          <div className="mt-3 text-xs leading-5 text-[#666666]">
            Последняя синхронизация: {pms?.last_sync_at || "—"} · webhook: {pms?.last_webhook_at || "—"} ·
            проверка наличия: {pms?.last_successful_availability_at || "—"}
          </div>

          {pms?.last_error ? (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <strong>{pms.last_error.code}</strong>: {pms.last_error.message}
            </div>
          ) : null}

          <form className="mt-5 space-y-4" onSubmit={form.handleSubmit(onSave)}>
            <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
              <input type="checkbox" className="h-5 w-5" {...form.register("enabled")} />
              Разрешить PMS tools для звонков и WhatsApp этого отеля
            </label>
            {enabled && pms?.connection_status !== "connected" ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Сначала сохраните данные и нажмите «Проверить подключение». До успешной проверки инструменты лучше оставить выключенными.
              </div>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="ID аккаунта Bnovo">
                <input className="input" autoComplete="off" placeholder="ID из Bnovo Octopus" {...form.register("account_id", { required: true })} />
              </Field>
              <Field label="API-пароль">
                <input className="input" type="password" autoComplete="new-password" placeholder={pms?.credentials_configured ? "Оставьте пустым, чтобы не менять" : "API-пароль"} {...form.register("api_password")} />
              </Field>
            </div>
            <Field label="Валюта">
              <input className="input" maxLength={3} {...form.register("currency", { required: true })} />
            </Field>
            <Field label="Категории, которые может предлагать AVA">
              <input className="input" placeholder="71, 73, 76 — пусто означает все" {...form.register("enabled_room_type_ids")} />
              {pms?.mappings?.available_room_types?.length ? (
                <p className="mt-2 text-xs leading-5 text-[#666666]">
                  Найдены в Bnovo: {pms.mappings.available_room_types.map((item) => `${item.id} — ${item.name}`).join("; ")}
                </p>
              ) : null}
            </Field>
            <Field label="Тарифы, которые может предлагать AVA">
              <input className="input" placeholder="29, 31 — пусто означает все" {...form.register("enabled_tariff_ids")} />
              {pms?.mappings?.available_tariffs?.length ? (
                <p className="mt-2 text-xs leading-5 text-[#666666]">
                  Найдены в Bnovo: {pms.mappings.available_tariffs.map((item) => `${item.id} — ${item.name}`).join("; ")}
                </p>
              ) : null}
            </Field>
            <div className="grid gap-2 sm:grid-cols-2">
              <PillButton type="submit" variant="solid" disabled={busy} className="min-h-11 justify-center">
                <Save size={14} /> Сохранить PMS
              </PillButton>
              <PillButton type="button" disabled={busy || !pms?.credentials_configured} onClick={onTest} className="min-h-11 justify-center">
                <Plug size={14} /> Проверить подключение
              </PillButton>
              <PillButton type="button" disabled={busy || pms?.connection_status !== "connected"} onClick={onSync} className="min-h-11 justify-center">
                <RefreshCcw size={14} /> Синхронизировать
              </PillButton>
              <PillButton type="button" disabled={busy || pms?.connection_status !== "connected"} onClick={onWebhooks} className="min-h-11 justify-center">
                <PlayCircle size={14} /> Подключить webhooks
              </PillButton>
            </div>
            {pms?.credentials_configured ? (
              <button type="button" className="min-h-11 w-full rounded-full border border-red-200 px-4 text-sm font-bold text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onDisconnect} disabled={busy}>
                Отключить и удалить учётные данные
              </button>
            ) : null}
          </form>

          <div className="mt-6 space-y-5">
            <PmsTable title="Бронирования Bnovo" empty="Синхронизированных бронирований пока нет." rows={bookings.slice(0, 20).map((item) => ({
              id: item.booking_id,
              primary: `${item.booking_number || "Без номера"} · ${item.customer?.name || "Гость"} ${item.customer?.surname || ""}`,
              secondary: `${item.arrival || "—"} — ${item.departure || "—"} · ${item.category || "Категория не указана"}`,
              status: item.status || "—",
            }))} />
            <PmsTable title="Заявки на бронирование" empty="Заявок пока нет." rows={requests.slice(0, 20).map((item) => ({
              id: item.id,
              primary: `${item.customerName || "Гость"} · ${item.arrivalDate || "—"} — ${item.departureDate || "—"}`,
              secondary: `Задача ${item.managerTaskId || "создаётся"} · ${item.channel || "—"}`,
              status: item.status || "new",
            }))} />
          </div>
        </>
      )}
    </Card>
  );
}

function PmsTable({ title, empty, rows }) {
  return (
    <div className="rounded-2xl border border-[#111111]/10">
      <div className="border-b border-[#111111]/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#777777]">{title}</div>
      {rows.length ? rows.map((row) => (
        <div key={row.id} className="flex items-start justify-between gap-3 border-b border-[#111111]/5 px-4 py-3 text-sm last:border-0">
          <div className="min-w-0"><div className="font-bold text-[#222222]">{row.primary}</div><div className="mt-1 text-xs text-[#666666]">{row.secondary}</div></div>
          <span className="shrink-0 rounded-full border border-[#111111]/10 px-2 py-1 text-[10px] font-bold">{row.status}</span>
        </div>
      )) : <div className="px-4 py-4 text-sm text-[#777777]">{empty}</div>}
    </div>
  );
}

function TwentyPanel({ twenty, loading, form, busy, webhookReveal, onSave, onTest, onSync, onWebhook, onDisconnect }) {
  const enabled = form.watch("enabled");
  const mode = form.watch("mode");
  const outbox = twenty?.diagnostics?.outbox || {};
  const inbox = twenty?.diagnostics?.inbox || {};
  const pending = Number(outbox.PENDING || 0) + Number(outbox.LEASED || 0);
  const failed = Number(outbox.DEAD || 0) + Number(inbox.DEAD || 0);

  async function copyValue(value, label) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} скопирован.`);
    } catch {
      toast.error(moduleDisplayText(`Не удалось скопировать ${label.toLowerCase()}.`));
    }
  }

  return (
    <Card className="rounded-[28px] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#838282]">CRM</p>
          <h2 className="mt-2 font-clash-display text-3xl font-bold uppercase"><AvaMark module="crm" size={28} className="mr-2 inline-block align-middle" />AVA CRM</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${twenty?.enabled ? "border-emerald-300 text-emerald-700" : "border-[#111111]/15 text-[#666666]"}`}>
          {twenty?.enabled ? (twenty.mode === "live" ? "Синхронизация включена" : "Теневой режим") : "Выключено"}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-[#555555]">
        Для каждого бизнеса используется отдельная рабочая область AVA CRM. AVA передаёт карточки, задачи,
        звонки и заявки без аудио, полных расшифровок и секретов. Сначала включите теневой режим и проверьте подключение.
      </p>

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} />Загрузка AVA CRM</div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Подключение" value={{ connected: "Подключено", not_tested: "Не проверено", error: "Ошибка", not_configured: "Не настроено" }[twenty?.connection_status] || twenty?.connection_status || "Не настроено"} />
            <Metric label="Связано записей" value={twenty?.diagnostics?.links || 0} />
            <Metric label="В очереди" value={pending} />
            <Metric label="Ошибки" value={failed || twenty?.diagnostics?.errors_24h || 0} />
          </div>
          <div className="mt-3 text-xs leading-5 text-[#666666]">
            Последняя постановка синхронизации: {twenty?.last_sync_at || "—"} · успешная операция: {twenty?.last_success_at || "—"} · webhook: {twenty?.last_webhook_at || "—"}
          </div>

          {twenty?.last_error ? (
            <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <strong>{twenty.last_error.code}</strong>: {moduleDisplayText(twenty.last_error.message)}
            </div>
          ) : null}

          <form className="mt-5 space-y-4" onSubmit={form.handleSubmit(onSave)}>
            <label className="flex min-h-11 items-center gap-3 text-sm font-semibold">
              <input type="checkbox" className="h-5 w-5" {...form.register("enabled")} />
              Включить синхронизацию для этого бизнеса
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Адрес AVA CRM">
                <input className="input" type="url" placeholder="https://crm.example.ru" {...form.register("base_url", { required: true })} />
              </Field>
              <Field label="ID рабочей области">
                <input className="input" autoComplete="off" placeholder="Workspace ID" {...form.register("workspace_id")} />
              </Field>
              <Field label="API-ключ">
                <input className="input" type="password" autoComplete="new-password" placeholder={twenty?.credentials_configured ? "Оставьте пустым, чтобы не менять" : "Ключ AVA CRM"} {...form.register("api_key")} />
              </Field>
              <Field label="Общий секрет webhook">
                <input className="input" type="password" autoComplete="new-password" placeholder={twenty?.webhook_configured ? "Оставьте пустым, чтобы не менять" : "Можно создать автоматически"} {...form.register("webhook_secret")} />
              </Field>
              <Field label="Режим работы">
                <select className="input" {...form.register("mode")}>
                  <option value="shadow">Теневой — только проверка, без записи</option>
                  <option value="live">Рабочий — создавать и обновлять записи</option>
                </select>
              </Field>
              <Field label="Публичный HTTPS-адрес AVA для webhook">
                <input className="input" type="url" placeholder="https://ava.example.ru" {...form.register("public_base_url")} />
              </Field>
            </div>
            {enabled && mode === "live" && twenty?.connection_status !== "connected" ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Рабочий режим включится только после успешной проверки API-ключа. Сохраните теневой режим, проверьте подключение, затем переключите на рабочий.
              </div>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <PillButton type="submit" variant="solid" disabled={busy} className="min-h-11 justify-center">
                <Save size={14} /> Сохранить AVA CRM
              </PillButton>
              <PillButton type="button" disabled={busy || !twenty?.credentials_configured} onClick={onTest} className="min-h-11 justify-center">
                <Plug size={14} /> Проверить подключение
              </PillButton>
              <PillButton type="button" disabled={busy || twenty?.connection_status !== "connected"} onClick={onSync} className="min-h-11 justify-center">
                <RefreshCcw size={14} /> Синхронизировать
              </PillButton>
              <PillButton type="button" disabled={busy || twenty?.connection_status !== "connected"} onClick={() => onWebhook(form.getValues("public_base_url"))} className="min-h-11 justify-center">
                <PlayCircle size={14} /> Подготовить webhook
              </PillButton>
            </div>
          </form>

          {webhookReveal?.url ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <p className="font-bold">Добавьте webhook вручную в AVA CRM</p>
              <p className="mt-1 text-xs leading-5">Настройки → API и Webhooks → Webhooks. Секрет показывается только при первом создании.</p>
              <div className="mt-3 space-y-2">
                <button type="button" onClick={() => copyValue(webhookReveal.url, "Webhook URL")} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-amber-300 bg-white px-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                  <span className="min-w-0 break-all font-mono text-xs">{webhookReveal.url}</span><Copy size={16} className="shrink-0" />
                </button>
                {webhookReveal.secret ? (
                  <button type="button" onClick={() => copyValue(webhookReveal.secret, "Секрет webhook")} className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl border border-amber-300 bg-white px-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                    <span className="min-w-0 break-all font-mono text-xs">{webhookReveal.secret}</span><Copy size={16} className="shrink-0" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {twenty?.credentials_configured ? (
            <button type="button" className="mt-5 min-h-11 w-full rounded-full border border-red-200 px-4 text-sm font-bold text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onDisconnect} disabled={busy}>
              Отключить AVA CRM и удалить ключи
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function OnyxPanel({ onyx, criteria, loading, form, busy, onSave, onTest, onSync, onDisable }) {
  const checklist = criteria?.checklist || {};
  const checks = Object.entries(checklist);
  const labels = {
    version_pinned: "Версия закреплена",
    data_audit_passed: "Аудит данных",
    backup_tested: "Backup и restore",
    connector_verified: "API и доступ к контенту",
    outbox_worker_active: "Очередь синхронизации",
    knowledge_base_ingested: "База знаний загружена",
    grounding_verified: "Ответы проверены по источникам",
    prompts_separated: "Промпты разделены",
    policy_gateway_enabled: "Policy Gateway",
    audit_logging_active: "Журнал действий",
    rate_limits_active: "Лимиты и мониторинг",
    shadow_mode_completed: "Теневой прогон",
    rollback_verified: "Проверка отката",
    monitoring_active: "Мониторинг",
    tenant_link_ready: "Изоляция бизнеса",
  };

  return (
    <Card className="rounded-[28px] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#838282]">База знаний</p>
          <h2 className="mt-2 font-clash-display text-3xl font-bold uppercase"><AvaMark module="knowledge" size={28} className="mr-2 inline-block align-middle" />AVA Знания</h2>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-bold ${onyx?.status === "ACTIVE_LIVE" ? "border-emerald-300 text-emerald-700" : "border-[#111111]/15 text-[#666666]"}`}>
          {onyx?.status || "UNLINKED"}
        </span>
      </div>
      <p className="mt-3 text-sm leading-6 text-[#555555]">
        Модуль AVA Знания хранит поисковый индекс и знания ассистента. Для каждого бизнеса обязательны отдельный
        контур доступа и connector pair. Телефония, WhatsApp и операционная CRM остаются в AVA.
      </p>

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} />Загрузка AVA Знания</div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Статус" value={onyx?.status || "Не настроено"} />
            <Metric label="Версия" value={onyx?.onyx_version || onyx?.required_version || "v4.7.0"} />
            <Metric label="Connector pair" value={onyx?.cc_pair_id || "—"} />
            <Metric label="Go / No-Go" value={criteria?.decision || "NO-GO"} />
          </div>
          <form className="mt-5 space-y-4" onSubmit={form.handleSubmit(onSave)}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Адрес AVA Знания API">
                <input className="input" type="url" placeholder="https://knowledge.example.ru/api" {...form.register("base_url", { required: true })} />
              </Field>
              <Field label="Версия AVA Знания">
                <input className="input" readOnly {...form.register("onyx_version", { required: true })} />
              </Field>
              <Field label="ID отдельного connector pair">
                <input className="input" type="number" min="1" {...form.register("cc_pair_id", { required: true, min: 1 })} />
              </Field>
              <Field label="Имя переменной с API-ключом на сервере">
                <input className="input" autoComplete="off" placeholder={onyx?.credential_configured ? "Оставьте пустым, чтобы не менять" : "Имя переменной окружения"} {...form.register("credential_ref")} />
              </Field>
            </div>
            <p className="text-xs leading-5 text-[#666666]">
              Сам ключ через браузер не передаётся и в базе AVA не хранится. Укажите только имя защищённой переменной окружения на сервере.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <PillButton type="submit" variant="solid" disabled={busy} className="min-h-11 justify-center"><Save size={14} /> Сохранить</PillButton>
              <PillButton type="button" disabled={busy || !onyx?.configured} onClick={onTest} className="min-h-11 justify-center"><Plug size={14} /> Проверить</PillButton>
              <PillButton type="button" disabled={busy || !["STAGING", "ACTIVE", "ACTIVE_LIVE"].includes(onyx?.status)} onClick={onSync} className="min-h-11 justify-center"><RefreshCcw size={14} /> Синхронизировать</PillButton>
            </div>
          </form>

          {checks.length ? (
            <div className="mt-5 rounded-2xl border border-[#111111]/10 p-4">
              <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.18em] text-[#777777]">Готовность к рабочему режиму</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {checks.map(([key, passed]) => (
                  <div key={key} className="flex min-h-11 items-center gap-2 text-sm">
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full border ${passed ? "border-emerald-300 bg-emerald-50 text-emerald-700" : "border-amber-300 bg-amber-50 text-amber-800"}`}>
                      {passed ? <Check size={14} /> : <Clock3 size={14} />}
                    </span>
                    {labels[key] || key}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {onyx?.configured ? (
            <button type="button" className="mt-5 min-h-11 w-full rounded-full border border-red-200 px-4 text-sm font-bold text-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" onClick={onDisable} disabled={busy}>
              Отключить AVA Знания и оставить локальную AVA
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function KnowledgeBasePanel({
  hotel,
  kbData,
  loading,
  busy,
  selectedFiles,
  onFilesChange,
  onFileUpload,
  textForm,
  onTextUpload,
  searchForm,
  onSearch,
  onSearchChange,
  searchResult,
  searchError,
  searching,
  smokeResult,
  onSmoke,
  onDelete,
}) {
  const files = kbData?.files || [];
  const stats = kbData?.stats || {};
  const smoke = smokeResult?.smoke;
  const searchField = searchForm.register("query", { required: true });

  return (
    <Card className="rounded-[28px] p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-[#838282]">
            База знаний
          </p>
          <h2 className="mt-2 font-clash-display text-3xl font-bold uppercase">
            {hotel?.name || "Бизнес"}
          </h2>
        </div>
        <span className="rounded-full border border-[#111111]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#555555]">
          KB #{kbData?.knowledgeBaseInstanceId || hotel?.knowledgeBaseInstanceId || hotel?.instanceId}
        </span>
      </div>

      {loading ? (
        <div className="mt-5 flex items-center gap-2 text-sm font-semibold text-[#555555]">
          <Loader2 size={16} className="animate-spin" />
          Загрузка базы знаний
        </div>
      ) : (
        <div className="mt-5 space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Документы" value={stats.totalDocuments || files.length || 0} />
            <Metric label="Фрагменты" value={stats.totalChunks || 0} />
            <Metric label="Индексация" value={`${stats.embeddingsCoverage || 0}%`} />
          </div>

          <div className="rounded-2xl border border-[#111111]/10">
            <div className="grid grid-cols-[1fr_88px_88px_44px] gap-2 border-b border-[#111111]/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-[#777777]">
              <span>Документ</span>
              <span>Фрагменты</span>
              <span>Размер</span>
              <span />
            </div>
            {files.length ? (
              files.map((file) => (
                <div
                  key={file.id}
                  className="grid grid-cols-[1fr_88px_88px_44px] items-center gap-2 border-b border-[#111111]/5 px-3 py-3 text-sm last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-semibold text-[#222222]">
                      <FileText size={15} />
                      <span className="truncate">{file.originalName}</span>
                    </div>
                    <div className="mt-1 text-xs text-[#777777]">
                      версия {file.version || 1} · {file.mimeType || "документ"}
                    </div>
                  </div>
                  <span className="text-[#555555]">{file.chunkCount || 0}</span>
                  <span className="text-[#555555]">{formatFileSize(file.fileSize)}</span>
                  <button
                    type="button"
                    className="flex h-9 w-9 items-center justify-center rounded-full border border-red-200 text-red-600 hover:bg-red-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy}
                    aria-label={`Удалить ${file.originalName}`}
                    onClick={() => onDelete(file.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))
            ) : (
              <div className="px-3 py-5 text-sm font-semibold text-[#777777]">
                В базе знаний пока нет документов.
              </div>
            )}
          </div>

          <div className="grid gap-4">
            <div className="rounded-2xl border border-[#111111]/10 p-4">
              <label className="block">
                <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">
                  Загрузить файлы
                </span>
                <input
                  className="input"
                  type="file"
                  multiple
                  accept=".pdf,.txt,.csv,.md,.docx,image/png,image/jpeg"
                  onChange={(event) => onFilesChange(Array.from(event.target.files || []))}
                />
              </label>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-semibold text-[#777777]">
                  {selectedFiles.length
                    ? `Выбрано файлов: ${selectedFiles.length}`
                    : "PDF, DOCX, TXT, MD, CSV, PNG, JPG"}
                </span>
                <PillButton
                  type="button"
                  variant="solid"
                  disabled={busy || selectedFiles.length === 0}
                  onClick={onFileUpload}
                >
                  <span className="flex items-center gap-2">
                    <Upload size={14} />
                    Загрузить
                  </span>
                </PillButton>
              </div>
            </div>

            <form className="rounded-2xl border border-[#111111]/10 p-4" onSubmit={textForm.handleSubmit(onTextUpload)}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">
                  Новый текст для базы
                </span>
                <button
                  type="button"
                  className="text-xs font-bold uppercase tracking-[0.16em] text-[#2563eb]"
                  onClick={() => {
                    localStorage.removeItem(knowledgeDraftKey(getBusinessId(hotel) || hotel?.id));
                    textForm.reset(textUploadDefaults(hotel));
                  }}
                >
                  Очистить черновик
                </button>
              </div>
              <p className="mt-2 text-xs leading-5 text-[#666666]">
                Загруженные документы перечислены слева. Незагруженный черновик сохраняется только для текущего отеля.
              </p>
              <input className="input mt-3" {...textForm.register("title", { required: true })} />
              <textarea
                className="input mt-3 min-h-64 font-mono text-xs leading-5"
                placeholder="Вставьте фактические данные отеля или загрузите файл слева"
                {...textForm.register("text", { required: true })}
              />
              <PillButton type="submit" variant="solid" disabled={busy} className="mt-3 w-full justify-center">
                <span className="flex items-center justify-center gap-2">
                  <Save size={14} />
                  Добавить текст в базу
                </span>
              </PillButton>
            </form>

            <form className="rounded-2xl border border-[#111111]/10 p-4" onSubmit={searchForm.handleSubmit(onSearch)}>
              <Field label="Проверочный вопрос">
                <input
                  className="input"
                  placeholder="Во сколько начинается завтрак?"
                  {...searchField}
                  onChange={(event) => { searchField.onChange(event); onSearchChange(); }}
                />
              </Field>
              <PillButton type="submit" disabled={busy} className="mt-3 w-full justify-center">
                <span className="flex items-center justify-center gap-2">
                  {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
                  {searching ? "Ищем фрагменты…" : "Найти фрагменты"}
                </span>
              </PillButton>
              {searchError ? <p className="mt-3 text-sm text-red-700" role="alert">{searchError}</p> : null}
              {searchResult ? (
                <div className="mt-3 rounded-2xl bg-[#f5f5f5] p-3 text-sm text-[#333333]">
                  <div className="mb-2 text-xs font-bold uppercase tracking-[0.16em] text-[#777777]">
                    Найдено результатов: {searchResult.resultsCount || 0}
                  </div>
                  {!searchResult.results.length ? <p role="status">Подходящих фрагментов нет. Уточните вопрос или добавьте документ.</p> : null}
                  {(searchResult.results || []).slice(0, 3).map((result) => (
                    <div key={result.id} className="mb-3 last:mb-0">
                      <div className="font-semibold">{result.originalName}</div>
                      <div className="mt-1 text-xs leading-5 text-[#555555]">
                        {String(result.text || "").slice(0, 260)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </form>

            <div className="rounded-2xl border border-[#111111]/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">
                    Проверка качества
                  </div>
                  <div className="mt-1 text-sm font-semibold text-[#333333]">
                    20 вопросов об отеле с проверкой на выдуманные ответы
                  </div>
                </div>
                <PillButton type="button" variant="solid" disabled={busy} onClick={onSmoke}>
                  <span className="flex items-center gap-2">
                    <PlayCircle size={14} />
                    Запустить
                  </span>
                </PillButton>
              </div>
              {smoke ? (
                <div className="mt-4 space-y-2">
                  <div className="text-sm font-bold text-[#333333]">
                    Пройдено {smoke.passed} из {smoke.total}
                  </div>
                  {(smoke.results || []).slice(0, 6).map((item) => (
                    <div key={item.question} className="rounded-xl bg-[#f5f5f5] p-3 text-xs">
                      <div className="font-semibold text-[#333333]">{item.question}</div>
                      <div className="mt-1 text-[#666666]">
                        {item.status} · уверенность {Number(item.confidence || 0).toFixed(2)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-2xl border border-[#111111]/10 p-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#777777]">{label}</div>
      <div className="mt-1 text-xl font-bold text-[#222222]">{value}</div>
    </div>
  );
}

function Field({ label, error, children }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[10px] font-bold uppercase tracking-[0.2em] text-[#777777]">
        {label}
      </span>
      {children}
      {error ? <span className="mt-2 block text-xs font-semibold text-red-600">{error}</span> : null}
    </label>
  );
}

function ProfileMetric({ icon: Icon, label, value }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border border-[#111111]/10 bg-[#f7f7f7] px-3 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#111111]">
        <Icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block text-[9px] font-bold uppercase tracking-[0.2em] text-[#838282]">
          {label}
        </span>
        <span className="mt-1 block truncate text-sm font-bold text-[#222222]">
          {value || "-"}
        </span>
      </span>
    </div>
  );
}
