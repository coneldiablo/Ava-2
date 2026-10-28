import { X } from "lucide-react";
import { Card } from "@/components/ui/core";

export function Modal({ isOpen, title, subtitle, children, onClose, size = "lg" }) {
  if (!isOpen) {
    return null;
  }

  const widths = {
    md: "max-w-2xl",
    lg: "max-w-4xl",
    xl: "max-w-6xl",
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[#111111]/55 p-4 backdrop-blur-sm">
      <Card className={`w-full ${widths[size]} max-h-[90vh] overflow-hidden border-[#111111] bg-[#f2f2f2] p-0`}>
        <div className="flex items-start justify-between gap-4 border-b border-[#111111]/10 px-6 py-5">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              Editor
            </p>
            <h2 className="font-clash-display text-3xl font-bold uppercase">{title}</h2>
            {subtitle ? <p className="mt-2 text-sm text-[#666666]">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-[#838282] transition-colors hover:bg-[#111111]/5 hover:text-[#111111]"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[calc(90vh-96px)] overflow-auto p-6">{children}</div>
      </Card>
    </div>
  );
}
