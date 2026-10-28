import { useState } from "react";
import { Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AppShell } from "@/components/layout/AppShell";
import { Modal } from "@/components/ui/modal";
import { Card, PillButton } from "@/components/ui/core";
import { LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

export default function HelpPage() {
  const [search, setSearch] = useState("");
  const [selectedDoc, setSelectedDoc] = useState(null);

  const categoriesQuery = useQuery({
    queryKey: ["docs-categories"],
    queryFn: async () => (await api.get("/api/docs/categories")).data,
  });

  const searchQuery = useQuery({
    queryKey: ["docs-search", search],
    enabled: search.trim().length > 1,
    queryFn: async () => (await api.get(`/api/docs/search?q=${encodeURIComponent(search)}`)).data,
  });

  const docQuery = useQuery({
    queryKey: ["docs-content", selectedDoc?.path],
    enabled: Boolean(selectedDoc?.path),
    queryFn: async () => (await api.get(`/api/docs/content/${selectedDoc.path}`)).data,
  });

  if (categoriesQuery.isLoading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Documentation" />
      </AppShell>
    );
  }

  const searchResults = Array.isArray(searchQuery.data) ? searchQuery.data : searchQuery.data?.results || [];

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Documentation Browser"
          title="Help"
          description="Search bundled project documentation and open any markdown file without leaving the Admin UI."
        />

        <Card className="rounded-[32px] p-6">
          <label className="relative block">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#bfbfbf]" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search docs..."
              className="w-full border border-[#111111]/10 bg-white py-4 pl-11 pr-4 text-sm outline-none transition-all focus:border-[#111111]"
            />
          </label>

          {search.trim().length > 1 ? (
            <div className="mt-6 space-y-3">
              {searchResults.map((result) => (
                <button
                  type="button"
                  key={result.path}
                  onClick={() => setSelectedDoc(result)}
                  className="w-full rounded-[24px] border border-[#111111]/10 bg-white px-5 py-4 text-left transition-all hover:border-[#111111]"
                >
                  <p className="text-sm font-bold">{result.title || result.path}</p>
                  <p className="mt-2 text-sm text-[#666666]">{result.path}</p>
                </button>
              ))}
            </div>
          ) : null}
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          {(categoriesQuery.data || []).map((category) => (
            <Card key={category.name} className="rounded-[32px] p-8">
              <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
                {category.name}
              </p>
              <div className="mt-5 space-y-3">
                {(category.docs || []).map((doc) => (
                  <button
                    type="button"
                    key={doc.path}
                    onClick={() => setSelectedDoc(doc)}
                    className="w-full rounded-[24px] border border-[#111111]/10 bg-white px-4 py-4 text-left transition-all hover:border-[#111111]"
                  >
                    <p className="text-sm font-bold">{doc.title || doc.path}</p>
                    <p className="mt-1 text-xs text-[#666666]">{doc.path}</p>
                  </button>
                ))}
              </div>
            </Card>
          ))}
        </div>
      </div>

      <Modal
        isOpen={Boolean(selectedDoc)}
        onClose={() => setSelectedDoc(null)}
        title={selectedDoc?.title || "Documentation"}
        subtitle={selectedDoc?.path}
        size="xl"
      >
        {docQuery.isLoading ? (
          <LoadingBlock label="Loading Document" />
        ) : (
          <div className="prose max-w-none prose-headings:font-clash-display prose-pre:max-w-full prose-pre:overflow-x-auto">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {docQuery.data?.content || "No content"}
            </ReactMarkdown>
          </div>
        )}
        {selectedDoc?.github_url ? (
          <div className="mt-6">
            <a href={selectedDoc.github_url} target="_blank" rel="noreferrer">
              <PillButton>Open on GitHub</PillButton>
            </a>
          </div>
        ) : null}
      </Modal>
    </AppShell>
  );
}
