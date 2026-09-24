import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const target = path.join(root, '.env.production');
if (existsSync(target)) {
  const existing = await readFile(target, 'utf8');
  const normalized = existing.replace(/^MULTICA_CLI_PATH=.*\r?\n?/m, '');
  if (normalized !== existing) {
    await writeFile(target, normalized, { encoding: 'utf8', mode: 0o600 });
    console.log('Removed the deprecated relative MULTICA_CLI_PATH setting.');
  } else {
    console.log('.env.production already exists; it was not changed.');
  }
  process.exit(0);
}
const local = JSON.parse(await readFile(path.join(process.env.USERPROFILE, '.multica', 'config.json'), 'utf8'));
if (!local.token || !local.server_url || !local.workspace_id) throw new Error('Current Multica CLI configuration is incomplete.');
const cliPath = './vendor/multica';
const body = [
  `MULTICA_SERVER_URL=${local.server_url}`,
  `MULTICA_WORKSPACE_ID=${local.workspace_id}`,
  `MULTICA_TOKEN=${local.token}`
].join('\n') + '\n';
await writeFile(target, body, { encoding: 'utf8', mode: 0o600 });
console.log('Created .env.production with the cloud-only Multica connection settings.');
