/**
 * 生成行为对照实验的固定材料与标准答案。
 *
 * 材料必须在 bash 与 read 两条路径下都可用（模型可以像真实会话一样自己选路），
 * 而标准答案完全由本脚本算出，因此判分不依赖人眼。
 *
 * 用法：
 *   node tools/ab-fixtures.mjs [输出目录]     默认 .ab-fixtures
 *
 * @module dsh-tool-token-optimizer/tools/ab-fixtures
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.ab-fixtures';
mkdirSync(outDir, { recursive: true });

// ---- 材料 A：登记表（提取型任务）-----------------------------------------------
const registryLines = [];
for (let index = 1; index <= 400; index += 1) {
  const value = index * 1000 + 7;
  const owner = `team-${(index % 12) + 1}`;
  registryLines.push(`ITEM-${String(index).padStart(3, '0')} value=${value} owner=${owner} note=record number ${index} of the registry`);
}
// 两个“针”：只存在于中段，必须真的看到内容才能回答
const needles = [
  { line: 137, token: 'NEEDLE-ALPHA=Q7X2-M9' },
  { line: 291, token: 'NEEDLE-BETA=Z3P8-K4' },
];
for (const needle of needles) {
  registryLines[needle.line - 1] = `ITEM-${String(needle.line).padStart(3, '0')} ${needle.token} owner=team-9 note=buried record`;
}
const registryPath = join(outDir, 'registry.txt');
const registryText = `${registryLines.join('\n')}\n`;
writeFileSync(registryPath, registryText);

// ---- 材料 B：事件日志（枚举型任务）--------------------------------------------
const regions = ['head', 'mid', 'tail'];
const levels = ['info', 'warn', 'error'];
const logLines = [];
for (let index = 1; index <= 600; index += 1) {
  const region = regions[Math.floor((index - 1) / 200)];
  const level = levels[index % 3];
  const code = `E${String((index * 37) % 1000).padStart(3, '0')}`;
  logLines.push(`${String(index).padStart(3, '0')} region=${region} level=${level} code=${code} message="synthetic event number ${index} for the retention experiment"`);
}
const logPath = join(outDir, 'events.log');
writeFileSync(logPath, `${logLines.join('\n')}\n`);

// ---- 标准答案 ----------------------------------------------------------------
const divisibleBy7 = [];
for (let index = 1; index <= 400; index += 1) {
  if ((index * 1000 + 7) % 7 === 0) divisibleBy7.push(`ITEM-${String(index).padStart(3, '0')}`);
}
const ownerCounts = {};
for (let index = 1; index <= 400; index += 1) {
  const owner = `team-${(index % 12) + 1}`;
  ownerCounts[owner] = (ownerCounts[owner] ?? 0) + 1;
}
const warnMid = logLines.filter((line) => line.includes('region=mid') && line.includes('level=warn'));
const errorCodes = new Set(logLines.filter((line) => line.includes('level=error')).map((line) => /code=(E\d{3})/.exec(line)[1]));
const headErrorLines = logLines.filter((line) => line.includes('region=head') && line.includes('level=error'));

const answerKey = {
  'T1-divisible7-count': divisibleBy7.length,
  'T2-divisible7-list': divisibleBy7,
  'T3-needle-alpha': needles[0].token.split('=')[1],
  'T4-needle-beta': needles[1].token.split('=')[1],
  'T5-mid-warn-count': warnMid.length,
  'T6-distinct-error-codes': errorCodes.size,
  'T7-head-error-count': headErrorLines.length,
  'T8-owner-team-5-count': ownerCounts['team-5'] ?? 0,
};
const prompts = {
  'T1-divisible7-count': '读取 .ab-fixtures/registry.txt（400 行）。统计有多少条记录的 value 能被 7 整除。最后只输出一行：ANSWER=<数字>',
  'T2-divisible7-list': '读取 .ab-fixtures/registry.txt。列出所有 value 能被 7 整除的条目 ID。最后只输出一行：ANSWER=<ID 升序空格分隔，全部列出>',
  'T3-needle-alpha': '在 .ab-fixtures/registry.txt 里找到形如 NEEDLE-ALPHA=XXXX-XX 的标记，输出它等号右边的值。最后只输出一行：ANSWER=<值>',
  'T4-needle-beta': '在 .ab-fixtures/registry.txt 里找到形如 NEEDLE-BETA=XXXX-XX 的标记，输出它等号右边的值。最后只输出一行：ANSWER=<值>',
  'T5-mid-warn-count': '读取 .ab-fixtures/events.log（600 行）。统计有多少行同时包含 region=mid 和 level=warn。最后只输出一行：ANSWER=<数字>',
  'T6-distinct-error-codes': '读取 .ab-fixtures/events.log。统计 level=error 的行里一共出现了多少个**不同**的 code 值。最后只输出一行：ANSWER=<数字>',
  'T7-head-error-count': '读取 .ab-fixtures/events.log。统计 region=head 且 level=error 的行数。最后只输出一行：ANSWER=<数字>',
  'T8-owner-team-5-count': '读取 .ab-fixtures/registry.txt。统计 owner=team-5 的记录条数。最后只输出一行：ANSWER=<数字>',
};
writeFileSync(join(outDir, 'answer-key.json'), JSON.stringify({ answerKey, prompts, needles }, null, 1));
writeFileSync(join(outDir, 'prompts.md'), Object.entries(prompts).map(([id, text]) => `## ${id}\n${text}\n`).join('\n'));

console.log(`材料已生成于 ${outDir}`);
console.log(`  registry.txt  ${registryLines.length} 行 / ${registryText.length} 字符`);
console.log(`  events.log    ${logLines.length} 行`);
console.log(`  针位置（必落在中段）: 第 ${needles.map((n) => n.line).join(' 与 ')} 行`);
console.log('\n标准答案：');
for (const [id, value] of Object.entries(answerKey)) {
  console.log(`  ${id.padEnd(26)} ${Array.isArray(value) ? `${value.length} 项` : value}`);
}
