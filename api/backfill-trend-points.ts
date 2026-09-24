import { timingSafeEqual } from 'node:crypto';
import { backfillTrendPoints } from './_store';

function authorised(request: Request) {
  const expected = process.env.RPG2_MIGRATION_TOKEN ?? process.env.MULTICA_TOKEN;
  const supplied = request.headers.get('x-rpg2-migration-token') ?? '';
  if (!expected || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Migrates the legacy fat health_trends rows into the lightweight
// health_trend_points_v2 collection. Call in batches (limit/offset) until
// done is true; each batch reads one legacy row at a time because the legacy
// documents exceed the Mongo bridge response cap when paged in bulk.
export async function POST(request: Request) {
  if (!authorised(request)) return Response.json({ error: '未授权的趋势回填请求。' }, { status: 403 });
  try {
    const body: any = await request.json();
    const limit = Math.min(Math.max(Number(body?.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(body?.offset ?? 0) || 0, 0);
    const result = await backfillTrendPoints({ limit, offset });
    return Response.json({ ...result, done: result.total < limit });
  } catch (error: any) {
    return Response.json({ error: error.message ?? '趋势回填失败。' }, { status: 400 });
  }
}
