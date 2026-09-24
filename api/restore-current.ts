import { timingSafeEqual } from 'node:crypto';
import { mongodb } from '@fn/mongodb';
import { gzipSync } from 'node:zlib';
import { snapshotView } from '../src/snapshot-view.js';

const currentPages = mongodb.collection<any>('health_current_pages_v3');

async function restoreCurrentPageProjection(snapshot: any) {
  if (!snapshot?.generatedAt || !snapshot?.overview) throw new Error('恢复快照缺少生成时间或概览字段。');
  const collectedAt = new Date().toISOString();
  const pageNames = ['overview', 'production', 'agents', 'skills', 'risks'];
  // Upsert one projection at a time. Deleting an unbounded collection before
  // rebuilding it can leave the read path empty if FN times out mid-request.
  for (const page of pageNames) {
    const pageJson = JSON.stringify(snapshotView(snapshot, page));
    await currentPages.updateOne(
      { id: page },
      { $set: {
        id: page,
        collectedAt,
        // FN's Mongo bridge has a per-document payload cap below the raw
        // Skill evidence page. Gzip preserves the complete page while keeping
        // every stored document within that service limit.
        snapshotGzipBase64: gzipSync(Buffer.from(pageJson)).toString('base64')
      }, $unset: { snapshot: '' } },
      { upsert: true }
    );
  }
  return { collectedAt, pages: pageNames.length, reworkIssues: Number(snapshot?.daily?.reworkIssues?.count ?? 0) };
}

function authorised(request: Request) {
  const expected = process.env.RPG2_MIGRATION_TOKEN ?? process.env.MULTICA_TOKEN;
  const supplied = request.headers.get('x-rpg2-migration-token') ?? '';
  if (!expected || !supplied) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function POST(request: Request) {
  if (!authorised(request)) return Response.json({ error: '未授权的快照恢复请求。' }, { status: 403 });
  try {
    const body: any = await request.json();
    return Response.json(await restoreCurrentPageProjection(body.snapshot));
  } catch (error: any) {
    return Response.json({ error: error.message ?? '快照恢复失败。' }, { status: 400 });
  }
}
