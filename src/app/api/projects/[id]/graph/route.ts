import { graphSummary, listGraphNodes } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const summary = graphSummary(id);
  const nodes = listGraphNodes(id).slice(0, 50);
  return Response.json({ summary, nodes });
}
