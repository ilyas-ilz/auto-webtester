import { getRun } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getRun(id);
  if (!run) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(run);
}
