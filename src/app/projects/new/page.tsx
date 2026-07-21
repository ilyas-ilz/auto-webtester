import { ProjectForm } from "./ProjectForm";

export default function NewProjectPage() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <p className="section-label">Setup</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">New project</h1>
      <p className="mt-1 text-sm text-muted">Credentials are encrypted at rest and never leave the server.</p>
      <div className="mt-6 rounded-xl border border-line bg-panel p-6">
        <ProjectForm />
      </div>
    </div>
  );
}
