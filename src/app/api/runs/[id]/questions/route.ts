import { listQuestions, answerQuestion, getQuestion } from "@/lib/db";
import { controlAllowed } from "@/lib/originGuard";

// Same guard as POST below: questions can carry credentials a human typed mid-run
// (login.ts's askHuman), so a cross-origin/off-box page must not be able to read them.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = { origin: req.headers.get("origin"), host: req.headers.get("host"), token: req.headers.get("x-control-token") };
  if (!controlAllowed(guard, process.env.WEBTESTER_CONTROL_TOKEN, process.env.WEBTESTER_ALLOWED_HOSTS)) return Response.json({ error: "forbidden" }, { status: 403 });
  return Response.json(listQuestions(id));
}

// Same guard as the live-view control route: an answer here is typed straight
// into the app under test (credentials, form values), so a cross-origin page
// must not be able to post one.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = { origin: req.headers.get("origin"), host: req.headers.get("host"), token: req.headers.get("x-control-token") };
  if (!controlAllowed(guard, process.env.WEBTESTER_CONTROL_TOKEN, process.env.WEBTESTER_ALLOWED_HOSTS)) return Response.json({ error: "forbidden" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { questionId?: number; answer?: string } | null;
  if (!body?.questionId || typeof body.answer !== "string") return Response.json({ error: "questionId and answer are required" }, { status: 400 });
  const q = getQuestion(body.questionId);
  if (!q || q.runId !== id) return Response.json({ error: "not found" }, { status: 404 });
  answerQuestion(body.questionId, body.answer);
  return Response.json({ ok: true });
}
