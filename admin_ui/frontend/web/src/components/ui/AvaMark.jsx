/** Presentation only: integration IDs, endpoint paths and payloads stay unchanged. */
export function AvaMark({ module = "platform", size = 24, className, label }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      {module === "crm" ? <><path d="m6 16 6-12 6 12M9 11h6M6 20h12" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="20" r="2" /></>
        : module === "knowledge" ? <path d="M3 7v13c3-2 6-2 9 0 3-2 6-2 9 0V7M8 15l4-9 4 9m-6.5-3h5" />
          : <path d="M4 20 12 4l8 16M7.5 13h9M10 17l2 3 2-3" />}
    </svg>
  );
}
