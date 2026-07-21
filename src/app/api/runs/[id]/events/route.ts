import { listEvents } from "@/lib/db";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const after = Number(new URL(req.url).searchParams.get("after") ?? "0") || 0;
  return Response.json(listEvents(id, after));
}
