import { timingSafeEqual } from 'node:crypto';
import { completedImportBatches, importHistoricalLineEvidenceBatch, importHistoricalReworkNodesBatch, importLocalArchiveBatch, importLocalCurrentSnapshot, importLocalTrendBatch, saveArchitectureReview, saveSchemeUsage } from './_store';
import { buildSchemeUsage, normaliseScheme } from '../src/schemes.js';

function authorised(request: Request) {
  const expected = process.env.RPG2_MIGRATION_TOKEN ?? process.env.MULTICA_TOKEN;
  const supplied = request.headers.get('x-rpg2-migration-token') ?? '';
  if (!expected || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validName(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(value)) throw new Error(`${label} 无效。`);
  return value;
}

export async function GET(request: Request) {
  if (!authorised(request)) return Response.json({ error: '未授权的迁移请求。' }, { status: 403 });
  const url = new URL(request.url);
  try {
    const migrationId = validName(url.searchParams.get('migrationId'), 'migrationId');
    const dataset = validName(url.searchParams.get('dataset'), 'dataset');
    return Response.json({ completedBatches: await completedImportBatches(migrationId, dataset) });
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  if (!authorised(request)) return Response.json({ error: '未授权的迁移请求。' }, { status: 403 });
  try {
    const body: any = await request.json();
    const migrationId = validName(body.migrationId, 'migrationId');
    const dataset = validName(body.dataset, 'dataset');
    if (body.kind === 'archive') return Response.json(await importLocalArchiveBatch({ ...body, migrationId, dataset }));
    if (body.kind === 'trend') return Response.json(await importLocalTrendBatch({ ...body, migrationId, dataset }));
    if (body.kind === 'current-snapshot') return Response.json(await importLocalCurrentSnapshot({ ...body, migrationId, dataset }));
    if (body.kind === 'line-history') return Response.json(await importHistoricalLineEvidenceBatch({ ...body, migrationId, dataset }));
    if (body.kind === 'rework-history') return Response.json(await importHistoricalReworkNodesBatch({ ...body, migrationId, dataset, batch: body.batch ?? 0 }));
    if (body.kind === 'architecture-review') return Response.json(await saveArchitectureReview(body));
    if (body.kind === 'scheme-usage') {
      if (!Array.isArray(body.analysed)) throw new Error('scheme-usage 需要 analysed 列表。');
      const analysed = body.analysed.map((item: any) => ({
        identifier: String(item?.identifier ?? item?.id ?? ''),
        title: String(item?.title ?? ''),
        schemes: (Array.isArray(item?.schemes) ? item.schemes : []).map((token: any) => normaliseScheme(token)).filter(Boolean)
      })).filter((item: any) => item.identifier);
      return Response.json(await saveSchemeUsage(buildSchemeUsage(analysed, body.generatedAt ?? new Date().toISOString())));
    }
    return Response.json({ error: '不支持的迁移类型。' }, { status: 400 });
  } catch (error: any) {
    return Response.json({ error: error.message ?? '迁移批次失败。' }, { status: 400 });
  }
}
