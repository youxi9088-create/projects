// Pull the scheme-selection guidance files (decision tree, diversity red lines)
// from the skill to check whether selection rules bias against multi-select /
// image-choice / sentence-sort etc.
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

const SKILL_ID = '51a5aac2-76f1-4e17-8447-13b97351d399';
const TARGETS = [
  'references/schemes-reference.md',
  'references/scheme_registry.json',
  'references/branch-and-node-basics.md',
  'references/examples-direction.md'
];

const { stdout } = await execFileAsync('multica', ['skill', 'files', 'list', SKILL_ID, '--output', 'json'], { env: cliEnv, timeout: 120000, maxBuffer: 128 * 1024 * 1024 });
const files = JSON.parse(stdout);
const list = Array.isArray(files) ? files : (files.files ?? files.items ?? []);
console.log('total files:', list.length);

for (const rel of TARGETS) {
  const file = list.find((f) => String(f.path ?? '').endsWith(rel));
  console.log(`\n===== ${rel} ${file ? '(len ' + String(file.content ?? '').length + ')' : 'NOT FOUND'} =====`);
  if (!file) continue;
  const content = String(file.content ?? '').replace(/\r/g, '');
  fs.writeFileSync(process.env.TEMP + '/' + rel.replace(/[\/.]/g, '_') + '.txt', content, 'utf8');
}
console.log('\nsaved to TEMP');
