import type { ReactNode } from "react";

// `role` is accepted so an alert/status card announces itself to screen readers
// (the error and connection banners rely on it).
export function Card({ children, className = "", role }: { children: ReactNode; className?: string; role?: "alert" | "status" }) {
  return (
    <div role={role} className={`rounded-xl border border-line bg-panel shadow-[0_1px_0_rgba(255,255,255,0.03)_inset] ${className}`}>
      {children}
    </div>
  );
}
