// Display messages only. Never use this helper for URLs, IDs, config or payloads.
export function moduleDisplayText(value) {
  if (typeof value !== "string") return value;
  return value.split(/(https?:\/\/[^\s<>]+|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b)/g)
    .map((part, index) => index % 2 ? part : part
      .replace(/\bTwenty\b/gi, "AVA CRM")
      .replace(/\bOnyx\b/gi, "AVA Знания"))
    .join("");
}
