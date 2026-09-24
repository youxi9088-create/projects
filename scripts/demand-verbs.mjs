// Verify: scan all 51 issue descriptions' 颗粒任务/教学验收 verbs to prove the
// demand input never requested multi-select / image / sentence-sort etc.
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

const done = JSON.parse(fs.readFileSync('data/done-issues.json', 'utf8'));
console.log('scanning', done.length, 'issues...');

// verb / requirement patterns in 颗粒任务 + 教学验收
const patterns = {
  '预测/判断': /预测|判断|辨析|鉴别|比较|对比|选择/,
  '分类/归纳': /分类|归纳|归类|建立.{0,4}(分类|树)|分组/,
  '记录/整理': /记录|整理|汇总|列表|表格/,
  '解释/说明': /解释|说明|分析|推导|证明|论证/,
  '记忆/复述': /记忆|背诵|复述|朗读|默写/,
  '计算/定量': /计算|定量|测量|数值/,
  '多选/看图/排序/填空/拾取': /多选|多个正确答案|看图|图片识别|图像|句序|句子排序|拖词|词库挖空|分组命名|3D检视|证物拾取/
};
const hits = {};
for (const k of Object.keys(patterns)) hits[k] = new Set();

for (const issue of done) {
  const desc = String(issue.description ?? '');
  for (const [k, re] of Object.entries(patterns)) {
    if (re.test(desc)) hits[k].add(issue.identifier);
  }
}
for (const [k, set] of Object.entries(hits)) {
  console.log(k.padEnd(26), ':', String(set.size).padStart(3), '条 ->', [...set].slice(0, 10).join(','));
}
