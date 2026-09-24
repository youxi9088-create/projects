// Categorize the 51 done issues by subject/theme and inspect the Stage 02
// teaching-design delegation text to understand the activity patterns.
import fs from 'node:fs';

const done = JSON.parse(fs.readFileSync('data/done-issues.json', 'utf8'));
const txt = fs.readFileSync('data/analysis-digest.txt', 'utf8');

const subjects = {
  '化学': /化学|氧化还原|电解质|物料守恒|无机物|反应速率|化学反应|蒸馏|净水/,
  '物理': /物理|浮力|牛顿|摩擦力|欧姆定律|力与运动|压强/,
  '生物': /生物|光合作用|分类概念|鱼类|爬行/,
  '语文': /语文|岳阳楼记|水调歌头|行路难|湖心亭|狼|酬乐天|背诵法/,
  '消防': /消防|灭火/,
  '其他': /基准|Demo|联调|canary|治理|视频|AIC|接口/
};

const counts = {};
for (const issue of done) {
  const title = String(issue.title ?? '');
  let matched = '未分类';
  for (const [subj, re] of Object.entries(subjects)) {
    if (re.test(title)) { matched = subj; break; }
  }
  counts[matched] = (counts[matched] ?? 0) + 1;
}
console.log('=== 51 条 Issue 学科分布 ===');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(6), v);

// Inspect Stage 02 教研设计 delegation text for activity-type keywords
console.log('\n=== 教研设计委托中的"学生活动/互动"描述抽样 ===');
const sections = txt.split(/\n### /);
const activityKw = /学生活动|活动设计|互动设计|练习|操练|理解|记忆|背诵|记录|判断|选择|分类|实验|观察|计算|朗读|复述|填空|配对|排序/;
let shown = 0;
for (const s of sections) {
  const header = s.split('\n')[0];
  if (!/^RPG-\d+/.test(header)) continue;
  const id = header.split(' ')[0];
  const delegLines = s.split('\n').filter((l) => l.includes('教研设计') && l.includes('委托'));
  for (const l of delegLines) {
    const m = l.match(/任务目标[：:](.{0,260})/);
    if (m) {
      console.log(id.padEnd(8), '|', m[1].replace(/\s+/g, ' ').slice(0, 200));
      shown += 1;
      if (shown >= 8) break;
    }
  }
  if (shown >= 8) break;
}
