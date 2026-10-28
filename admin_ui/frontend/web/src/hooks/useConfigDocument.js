import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { cloneConfig, fetchYamlConfig, saveYamlConfig } from "@/lib/config";

export function useConfigDocument() {
  const [config, setConfig] = useState(null);

  const query = useQuery({
    queryKey: ["config-yaml"],
    queryFn: fetchYamlConfig,
  });

  useEffect(() => {
    if (query.data?.parsed) {
      setConfig(cloneConfig(query.data.parsed));
    }
  }, [query.data]);

  async function save(nextConfig = config, successMessage = "Configuration saved.") {
    try {
      await saveYamlConfig(nextConfig);
      setConfig(cloneConfig(nextConfig));
      toast.success(successMessage);
      await query.refetch();
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save configuration.");
      return false;
    }
  }

  return {
    ...query,
    config,
    setConfig,
    save,
  };
}
