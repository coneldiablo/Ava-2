import { api } from "../api";
export type CampaignCommand = {
  id: string;
  action: string;
  state: "dispatching" | "succeeded" | "unknown";
  errorCode?: string;
};
export type Campaign = {
  campaignId: string;
  businessId: number;
  name: string;
  status: string;
  timezone: string;
  callWindow: { start?: string; end?: string };
  maxAttempts: number;
  retryIntervalMinutes?: number;
  retryBackoffMultiplier?: number;
  sourceNumberId: string | null;
  counts: Record<string, number>;
  audienceSize: number;
  audienceSource?: "import" | "crm";
  command: CampaignCommand | null;
};
export type CampaignPreview = {
  success: boolean;
  importId: string;
  expiresAt: number;
  counts: {
    total: number;
    accepted: number;
    invalid: number;
    duplicates: number;
  };
  rows: { phone: string; name?: string }[];
  errors: { row: number; code: string }[];
  duplicates: { row: number; phone: string }[];
};
export type CampaignCreate = {
  name: string;
  importId: string;
  sourceNumberId: string | null;
  timezone: string;
  callWindow: { start: string; end: string };
  maxAttempts: number;
  retryIntervalMinutes?: number;
};
export type CommandInput = {
  action: "prepare" | "start" | "pause" | "resume" | "stop";
  confirmAudience?: number;
  sourceNumberId?: string | null;
};
const base = (id: number) => `/businesses/${id}/outbound`;
const config = (signal?: AbortSignal) => ({ signal, timeout: 20000 });
export const listCampaigns = (id: number, signal?: AbortSignal) =>
  api
    .get(base(id) + "/campaigns", config(signal))
    .then((r) => r.data as { success: boolean; campaigns: Campaign[] });
export const previewCampaign = (
  id: number,
  input:
    | { csv: string; phoneColumn: string; nameColumn?: string }
    | {
        sourceFilter: {
          statuses?: string[];
          tags?: string[];
          exclude_tags?: string[];
          silentDays?: number;
        };
      },
  signal?: AbortSignal,
) =>
  api
    .post(base(id) + "/imports/preview", input, config(signal))
    .then((r) => r.data as CampaignPreview);
export const createCampaign = (
  id: number,
  input: CampaignCreate,
  key: string,
  signal?: AbortSignal,
) =>
  api
    .post(base(id) + "/campaigns", input, {
      ...config(signal),
      headers: { "Idempotency-Key": key },
    })
    .then((r) => r.data as { success: boolean; campaign: Campaign });
export const commandCampaign = (
  id: number,
  campaignId: string,
  input: CommandInput,
  key: string,
  signal?: AbortSignal,
) =>
  api
    .post(
      base(id) + "/campaigns/" + encodeURIComponent(campaignId) + "/commands",
      input,
      { ...config(signal), headers: { "Idempotency-Key": key } },
    )
    .then((r) => r.data as { success: boolean; campaign: Campaign });
export const reconcileCampaign = (
  id: number,
  campaignId: string,
  signal?: AbortSignal,
) =>
  api
    .post(
      base(id) + "/campaigns/" + encodeURIComponent(campaignId) + "/reconcile",
      {},
      config(signal),
    )
    .then((r) => r.data as { success: boolean; campaign: Campaign; runtimeStateConfirmed?: boolean });

export const syncCrmCampaign=(campaignId:string,signal?:AbortSignal)=>api.post(`/sales-brain/outbound/campaigns/${encodeURIComponent(campaignId)}/sync-leads`,{},{signal,timeout:20000}).then(r=>r.data as {success:boolean;accepted:number;blocked:number});

export const updateCampaignRetrySettings = (id:number,campaignId:string,input:{maxAttempts?:number;retryIntervalMinutes?:number},signal?:AbortSignal) => api.patch(base(id)+"/campaigns/"+encodeURIComponent(campaignId)+"/retry-settings",input,config(signal)).then(r=>r.data as {success:boolean;campaign:Campaign});
