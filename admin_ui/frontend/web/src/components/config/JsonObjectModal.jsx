import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { PillButton } from "@/components/ui/core";

export function JsonObjectModal({
  isOpen,
  onClose,
  title,
  nameLabel = "Name",
  initialName = "",
  initialValue = {},
  onSave,
  lockName = false,
  subtitle,
}) {
  const [name, setName] = useState(initialName);
  const [jsonValue, setJsonValue] = useState("{}");

  useEffect(() => {
    if (isOpen) {
      setName(initialName || "");
      setJsonValue(JSON.stringify(initialValue ?? {}, null, 2));
    }
  }, [initialName, initialValue, isOpen]);

  function handleSave() {
    try {
      const parsed = JSON.parse(jsonValue);
      onSave?.(name.trim(), parsed);
    } catch (err) {
      toast.error(`Invalid JSON: ${err.message}`);
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      size="xl"
    >
      <div className="space-y-5">
        <label className="block space-y-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
            {nameLabel}
          </span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={lockName}
            className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none transition-all focus:border-[#111111] disabled:bg-[#f5f5f5]"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
            JSON Payload
          </span>
          <textarea
            value={jsonValue}
            onChange={(event) => setJsonValue(event.target.value)}
            rows={24}
            className="min-h-[420px] w-full border border-[#111111]/10 bg-white px-4 py-3 font-mono text-xs outline-none transition-all focus:border-[#111111]"
          />
        </label>

        <div className="flex justify-end gap-3">
          <PillButton onClick={onClose}>Cancel</PillButton>
          <PillButton variant="solid" onClick={handleSave}>
            Save
          </PillButton>
        </div>
      </div>
    </Modal>
  );
}
