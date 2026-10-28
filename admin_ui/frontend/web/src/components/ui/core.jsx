import React from "react";
import { cn } from "@/lib/utils";

export function EchoStack({ text, className }) {
  const layers = [
    { offset: "-0.16em", color: "#d9d9d9" },
    { offset: "-0.12em", color: "#d1d1d1" },
    { offset: "-0.08em", color: "#c9c9c9" },
    { offset: "-0.04em", color: "#bfbfbf" },
    { offset: "0em", color: "#111111" },
  ];

  return (
    <div
      className={cn(
        "relative inline-block leading-[0.9] tracking-[-0.05em] font-clash-display",
        className,
      )}
    >
      {layers.map((layer, index) => (
        <span
          key={index}
          className={cn(
            "block",
            index < layers.length - 1
              ? "absolute inset-0 pointer-events-none"
              : "relative",
          )}
          style={{
            transform:
              index < layers.length - 1
                ? `translate(${layer.offset}, ${layer.offset})`
                : "none",
            color: layer.color,
            zIndex: index,
          }}
        >
          {text}
        </span>
      ))}
    </div>
  );
}

export function PillButton({
  children,
  className,
  variant = "outline",
  ...props
}) {
  const variants = {
    outline:
      "border border-[#111111] text-[#111111] hover:bg-[#111111] hover:text-[#f2f2f2]",
    solid: "bg-[#111111] text-[#f2f2f2] hover:bg-[#333333]",
  };

  return (
    <button
      className={cn(
        "px-6 py-2 rounded-full font-satoshi text-sm uppercase tracking-wider transition-all duration-200 active:scale-95",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Card({ children, className, ...props }) {
  return (
    <div
      className={cn(
        "border border-[#111111]/10 bg-white/50 backdrop-blur-sm p-6 transition-all duration-300 hover:border-[#111111]/30",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
