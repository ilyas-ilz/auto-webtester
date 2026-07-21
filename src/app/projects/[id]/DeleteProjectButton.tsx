"use client";

import { useState, useTransition } from "react";
import { deleteProjectAction } from "@/app/actions";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function DeleteProjectButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={pending}
        className="rounded-lg border border-red-500/30 px-3 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-60"
      >
        {pending ? "Deleting…" : "Delete"}
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => startTransition(() => deleteProjectAction(projectId))}
        title="Delete project?"
        body="This permanently deletes the project and all of its run history. This cannot be undone."
        confirmLabel="Delete project"
        destructive
      />
    </>
  );
}
