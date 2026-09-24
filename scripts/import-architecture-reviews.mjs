// Imports the locally authored Darwin architecture-review Markdown documents
// into the cloud health_architecture_reviews_v1 collection via the protected
// import-local endpoint (kind=architecture-review).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArchitectureReview } from '../src/architecture-reviews.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reviewDirectory = process.env.SKILL_ARCHITECTURE_REVIEW_PATH
  ?? path.join(projectRoot, '..', 'Multica', 'skill-architecture-reviews-2026-08-12');
const endpoint = process.env.RPG2_CLOUD_API_URL ?? 'https://f.new.ndhy.com/a/rpg2-health-monitor/api/import-local';

function loadProductionEnv() {
  const file = path.join(projectRoot, '.env.production');
  const values = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  const token = process.env.RPG2_MIGRATION_TOKEN ?? values.get('RPG2_MIGRATION_TOKEN') ?? values.get('MULTICA_TOKEN');
  if (!token) throw new Error('未找到迁移令牌；请在 .env.production 配置 RPG2_MIGRATION_TOKEN 或 MULTICA_TOKEN。');
  return token;
}

const migrationToken = loadProductionEnv();

if (!fs.existsSync(reviewDirectory)) {
  console.error(`找不到评审文档目录：${reviewDirectory}`);
  process.exitCode = 1;
} else {
  const documents = fs.readdirSync(reviewDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{2}-.+\.md$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(reviewDirectory, entry.name);
      const review = parseArchitectureReview(fs.readFileSync(filePath, 'utf8'), { filePath, updatedAt: fs.statSync(filePath).mtime.toISOString() });
      return review ? { skillId: review.skillId, review } : null;
    })
    .filter(Boolean);
  console.log(`解析到 ${documents.length} 份独立评审文档。`);
  let saved = 0;
  for (const document of documents) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rpg2-migration-token': migrationToken },
      body: JSON.stringify({ kind: 'architecture-review', migrationId: 'rpg2-local-architecture-reviews-v1', dataset: 'architecture-reviews', ...document })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status} ${data.error ?? '导入失败'}`);
    saved += 1;
    console.log(`✓ ${document.review.source?.fileName ?? document.skillId} → ${document.skillId}`);
  }
  console.log(`完成：已导入 ${saved}/${documents.length} 份评审。`);
}
