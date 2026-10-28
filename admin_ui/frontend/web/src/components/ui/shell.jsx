import { AlertCircle, Loader2, Plus, RefreshCw } from "lucide-react";
import { Card, EchoStack, PillButton } from "@/components/ui/core";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}) {
  return (
    <section className="space-y-6 pt-4">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div className="space-y-3">
          {eyebrow ? (
            <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-[#838282]">
              {eyebrow}
            </p>
          ) : null}
          <EchoStack text={title} className="text-5xl md:text-7xl" />
          {description ? (
            <p className="max-w-3xl text-sm leading-6 text-[#666666]">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
      </div>
    </section>
  );
}

export function Banner({ children, tone = "default", action }) {
  const tones = {
    default: "border-[#111111]/10 bg-white",
    warning: "border-amber-400/30 bg-amber-100/70 text-amber-900",
    danger: "border-red-400/30 bg-red-100/70 text-red-900",
    success: "border-emerald-400/30 bg-emerald-100/70 text-emerald-900",
  };

  return (
    <Card className={cn("border p-5", tones[tone])}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <AlertCircle size={18} className="mt-0.5 shrink-0" />
          <div className="text-sm leading-6">{children}</div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </Card>
  );
}

export function LoadingBlock({ label = "Loading" }) {
  return (
    <div className="flex min-h-[280px] items-center justify-center">
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#111111]" />
        <p className="mt-4 text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
          {label}
        </p>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}) {
  return (
    <Card className="rounded-[28px] border-dashed p-10 text-center">
      <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
        Empty State
      </p>
      <h3 className="mt-3 font-clash-display text-3xl font-bold uppercase">
        {title}
      </h3>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-[#666666]">
        {description}
      </p>
      {actionLabel ? (
        <div className="mt-6">
          <PillButton variant="solid" onClick={onAction}>
            <span className="flex items-center gap-2">
              <Plus size={14} />
              {actionLabel}
            </span>
          </PillButton>
        </div>
      ) : null}
    </Card>
  );
}

export function RefreshButton({ onClick, loading, label = "Refresh" }) {
  return (
    <PillButton onClick={onClick} disabled={loading}>
      <span className="flex items-center gap-2">
        <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        {label}
      </span>
    </PillButton>
  );
}
