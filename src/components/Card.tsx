import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-panel shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}>
      {children}
    </div>
  );
}
