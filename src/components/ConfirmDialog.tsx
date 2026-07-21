"use client";

import { useEffect, useRef } from "react";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Modern confirmation modal built on the native <dialog> element — the browser
 * gives us focus-trapping, Esc-to-close, the top layer, and a real backdrop for
 * free, so this stays small. Replaces window.confirm(), which can't be styled.
 */
export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const confirmBtn = destructive
    ? "bg-red-600 hover:bg-red-500 focus-visible:outline-red-600"
    : "bg-indigo-600 hover:bg-indigo-500 focus-visible:outline-indigo-600";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-0 text-foreground shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="flex flex-col gap-2 p-6">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm leading-relaxed text-muted">{body}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-panel-2"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={() => { onConfirm(); onClose(); }}
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${confirmBtn}`}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
