// Pull the Stage 02 教学活动设计 output for a few representative issues to see
// the actual activity/assessment design (why no multi-select / image-choice).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function loadProductionEnv() {
  const values = new Map();
  for (const line of fs.readFileSync(path.join(projectRoot, '.env.production'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) values.set(m[1], m[2]);
  }
  return values;
}
const env = loadProductionEnv();
const cliEnv = { ...process.env, MULTICA_SERVER_URL: env.get('MULTICA_SERVER_URL'), MULTICA_TOKEN: env.get('MULTICA_TOKEN'), MULTICA_WORKSPACE_ID: env.get('MULTICA_WORKSPACE_ID') };

async function multicaJson(args) {
  const { stdout } = await execFileAsync('multica', [...args, '--output', 'json'], { env: cliEnv, timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

// Pull issue detail + comments for 2 representative issues to find the
// 教学活动设计 attachment content (or the research-design run output).
for (const ident of ['RPG-334', 'RPG-330']) {
  console.log(`\n===== ${ident} =====`);
  try {
    const detail = await multicaJson(['issue', 'get', ident]);
    console.log('title:', detail.title);
    console.log('description:', String(detail.description ?? '').slice(0, 1200));
  } catch (e) {
    console.log('get err:', e.message.slice(0, 100));
  }
}
