import fs from "fs";
import { generateReportDocs } from "@/lib/runner/report-doc";

// Download the run report. Generated on demand (a run is finished, so the content is
// fixed) — no background job, no cache to invalidate.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const format = new URL(req.url).searchParams.get("format") === "pdf" ? "pdf" : "md";
  const out = await generateReportDocs(id);
  if (!out) return new Response("Run not found", { status: 404 });
  const file = format === "pdf" ? out.pdf : out.md;
  if (!file) return new Response("PDF unavailable (Chromium not installed) — download the Markdown instead", { status: 503 });
  return new Response(new Uint8Array(fs.readFileSync(file)), {
    headers: {
      "content-type": format === "pdf" ? "application/pdf" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="webtester-${id}.${format}"`,
    },
  });
}
