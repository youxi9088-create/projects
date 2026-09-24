// Render the 51-issue interaction schemes report (markdown) to styled HTML.
import fs from 'node:fs';

const md = fs.readFileSync('docs/done-51-issues-interaction-schemes-report.md', 'utf8');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(line) {
  // bold **x**
  let out = escapeHtml(line);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // inline code `x`
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  return out;
}

const lines = md.split('\n');
const html = [];
let inTable = false;
let tableRows = [];

function flushTable() {
  if (!tableRows.length) return;
  const header = tableRows[0];
  const body = tableRows.slice(2); // skip separator row
  html.push('<div class="table-wrap"><table>');
  html.push('<thead><tr>' + header.map((c) => `<th>${renderInline(c)}</th>`).join('') + '</tr></thead>');
  html.push('<tbody>' + body.map((row) => '<tr>' + row.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody>');
  html.push('</table></div>');
  tableRows = [];
}

for (const raw of lines) {
  const line = raw;
  if (line.startsWith('|') && line.endsWith('|')) {
    inTable = true;
    const cells = line.slice(1, -1).split('|').map((c) => c.trim());
    tableRows.push(cells);
    continue;
  }
  if (inTable) { flushTable(); inTable = false; }

  if (line.startsWith('# ')) { html.push(`<h1>${renderInline(line.slice(2))}</h1>`); }
  else if (line.startsWith('## ')) { html.push(`<h2>${renderInline(line.slice(3))}</h2>`); }
  else if (line.startsWith('### ')) { html.push(`<h3>${renderInline(line.slice(4))}</h3>`); }
  else if (line.startsWith('> ')) { html.push(`<blockquote>${renderInline(line.slice(2))}</blockquote>`); }
  else if (/^[-*] /.test(line)) { html.push(`<li>${renderInline(line.slice(2))}</li>`); }
  else if (line === '---') { html.push('<hr>'); }
  else if (line.trim() === '') { html.push(''); }
  else { html.push(`<p>${renderInline(line)}</p>`); }
}
if (inTable) flushTable();

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>终态 51 条 Issue 互动方案分析报告 · RPG2 健康度检测台</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b111a; color: #e6edf7; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.65; }
  .page { max-width: 1080px; margin: 0 auto; padding: 32px 28px 80px; }
  h1 { font-size: 1.7rem; color: #fff; border-bottom: 2px solid #2b4d55; padding-bottom: 10px; }
  h2 { font-size: 1.3rem; color: #9fd8e8; margin-top: 34px; border-left: 4px solid #2b4d55; padding-left: 10px; }
  h3 { font-size: 1.05rem; color: #c9d8e8; margin-top: 26px; }
  p { margin: 8px 0; }
  blockquote { border-left: 3px solid #4a5a6a; margin: 10px 0; padding: 8px 14px; background: #111c2a; color: #9fb2c8; border-radius: 0 8px 8px 0; }
  code { background: #16222f; padding: 1px 6px; border-radius: 4px; font-size: .88em; color: #c8e6c9; }
  li { margin: 4px 0; }
  .table-wrap { overflow-x: auto; margin: 12px 0; }
  table { border-collapse: collapse; width: 100%; font-size: .86rem; background: #101925; }
  th, td { border: 1px solid #27364a; padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: #172536; color: #9fd8e8; font-weight: 600; white-space: nowrap; }
  tr:nth-child(even) td { background: #0e1622; }
  strong { color: #ffd479; }
  hr { border: none; border-top: 1px solid #27364a; margin: 22px 0; }
  .footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #27364a; color: #7b8ba0; font-size: .8rem; }
</style>
</head>
<body>
<div class="page">
${html.join('\n')}
<div class="footer">RPG2 健康度检测台 · 互动方案分析报告 · 生成于 2026-08-19</div>
</div>
</body>
</html>`;

fs.writeFileSync('docs/done-51-issues-interaction-schemes-report.html', page, 'utf8');
console.log('HTML written:', page.length, 'bytes ->', 'docs/done-51-issues-interaction-schemes-report.html');
