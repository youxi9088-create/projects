import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 把本地人工复核的 51 条 done Issue 最终落地方案回填到云端互动方案汇总，
// 供检测台"互动方案"页面展示中英文名、使用次数与涉及 Issue。
// 数据源：data/merged-results-all.json（每条的 schemes.final 为最终落地结论）。

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const endpoint = process.env.RPG2_CLOUD_API_URL ?? 'https://f.new.ndhy.com/a/rpg2-health-monitor/api/import-local';

function envToken() {
  const values = new Map();
  for (const line of fs.readFileSync(path.join(projectRoot, '.env.production'), 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  const token = process.env.RPG2_MIGRATION_TOKEN ?? values.get('RPG2_MIGRATION_TOKEN') ?? values.get('MULTICA_TOKEN');
  if (!token) throw new Error('未找到迁移令牌。');
  return token;
}

const results = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'merged-results-all.json'), 'utf8'));
const analysed = results.map((issue) => ({
  identifier: issue.identifier,
  title: issue.title ?? '',
  schemes: Array.isArray(issue.schemes?.final) ? issue.schemes.final : []
}));

console.log(`准备回填互动方案汇总：${analysed.length} 条 done Issue（其中 ${analysed.filter((i) => i.schemes.length).length} 条有明确落地方案）。`);

const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-rpg2-migration-token': envToken() },
  body: JSON.stringify({ kind: 'scheme-usage', migrationId: 'rpg2-scheme-usage', dataset: 'done-51-final-schemes', generatedAt: new Date().toISOString(), analysed })
});
const data = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`${response.status} ${data.error ?? '互动方案回填失败'}`);
console.log(`回填完成：方案 ${data.schemeCount} 种、Issue ${data.issuesAnalysed} 条、savedAt ${data.savedAt}。`);
