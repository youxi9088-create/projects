import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { healthPage } from './_store';
import { multicaCommand } from '../src/multica.js';

const execFileAsync = promisify(execFile);

export async function GET() {
  let cli: { available: boolean; version?: string; error?: string };
  try {
    const command = multicaCommand();
    const { stdout: version } = await execFileAsync(command, ['version'], { timeout: 10_000 });
    await execFileAsync(command, ['workspace', 'get', '--output', 'json'], { timeout: 20_000 });
    cli = { available: true, version: version.trim() };
  } catch (error: any) {
    cli = { available: false, error: error.message };
  }
  // The collector intentionally writes fresh page projections without
  // rewriting the legacy full snapshot document. Read the current overview
  // projection so the status timestamp reflects the latest completed cloud
  // collection rather than the older legacy document.
  const snapshot = await healthPage('overview');
  return Response.json({ ok: cli.available, cli, latestSnapshotAt: snapshot?.generatedAt ?? null });
}
