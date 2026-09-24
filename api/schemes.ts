import { loadSchemeUsage } from './_store';
import { SCHEMES } from '../src/schemes.js';

export async function GET() {
  try {
    const usage = await loadSchemeUsage();
    // Older stored summaries predate the two-count model. Derive the aggregate
    // totals on read as well, so an already-collected current snapshot renders
    // correctly before its next persistence cycle.
    const enrichedUsage = usage && {
      ...usage,
      totalUseCount: usage.totalUseCount ?? usage.schemes.reduce((total: number, scheme: any) => total + Number(scheme.useCount ?? 0), 0),
      totalIssueCoverage: usage.totalIssueCoverage ?? usage.schemes.reduce((total: number, scheme: any) => total + Number(scheme.issueCount ?? scheme.issues?.length ?? 0), 0)
    };
    return Response.json({ ok: true, catalog: SCHEMES, usage: enrichedUsage });
  } catch (error: any) {
    return Response.json({ ok: false, error: error.message ?? '互动方案汇总读取失败。' }, { status: 500 });
  }
}
