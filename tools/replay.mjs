/**
 * 语料回放：把真实会话日志里的每一个工具结果取出来，逐条跑一遍**真实策略**
 * （`optimizeResult`，与插件运行时同一段代码），报出可复现的省量数字，
 * 以及每一步变换各自的贡献。
 *
 * 用法：
 *   node tools/replay.mjs <raw-jsonl-dir> [--step] [--json <out.json>] [--top N] [--inline N]
 *
 * 指标口径与插件内部完全一致（`lib/tokens.js` 复刻官方估算器），因此报告里的
 * 数字就是插件上线后会发生的数字，而不是另一套算法的估计。
 *
 * @module dsh-tool-token-optimizer/tools/replay
 */

import { readdirSync, writeFileSync } from 'node:fs';
import { applyPolicy, isolatedSteps, loadRows } from '../lib/replay-core.js';

const args = process.argv.slice(2);
const dir = args[0];
if (dir === undefined) {
  console.error('usage: node tools/replay.mjs <raw-jsonl-dir> [--step] [--json out.json] [--top N] [--inline N]');
  process.exit(2);
}
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};
const perStep = args.includes('--step');
const topN = Number(flag('--top', 5));
const inlineChars = Number(flag('--inline', 1600));
/** `--budgets bash=1000,read=2400` → `{ bash: 1000, read: 2400 }`。 */
const toolBudgets = Object.fromEntries(
  String(flag('--budgets', ''))
    .split(',')
    .map((pair) => pair.split('='))
    .filter(([tool, value]) => tool && Number.isFinite(Number(value)))
    .map(([tool, value]) => [tool.trim(), Number(value)]),
);

const policy = {
  inlineChars,
  triggerRatio: 1,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: Math.max(400, Math.floor(inlineChars * 0.4)),
  toolBudgets,
  minBlockChars: 400,
};

const rows = loadRows(dir);
const perTool = new Map();
const stepTotals = new Map();
let baseline = 0;
let after = 0;
let touched = 0;
let retained = 0;
let losslessOnly = 0;
const ranked = [];

for (const row of rows) {
  const result = applyPolicy(row, policy);
  baseline += row.baselineTokens;
  after += row.baselineTokens - result.saved;
  if (result.saved > 0) touched += 1;
  if (result.steps.includes('retain-middle')) retained += 1;
  else if (result.saved > 0) losslessOnly += 1;
  if (result.saved > 0) ranked.push({ tool: row.tool, saved: result.saved, chars: row.chars });

  const entry = perTool.get(row.tool) ?? { calls: 0, tokens: 0, saved: 0, touched: 0, retained: 0 };
  entry.calls += 1;
  entry.tokens += row.baselineTokens;
  entry.saved += result.saved;
  if (result.saved > 0) entry.touched += 1;
  if (result.steps.includes('retain-middle')) entry.retained += 1;
  perTool.set(row.tool, entry);

  if (perStep) {
    // 单步归因：每个无损变换单独施加在同一份原文上，量出它自己贡献的 token。
    for (const step of isolatedSteps(row)) {
      stepTotals.set(step.name, (stepTotals.get(step.name) ?? 0) + step.saved);
    }
    // 预算裁剪的贡献单独记账：它不是无损变换，用“不设预算”与“设预算”的差来量。
    const noBudget = applyPolicy(row, { ...policy, inlineChars: Number.MAX_SAFE_INTEGER });
    const budgetSaved = result.saved - noBudget.saved;
    if (budgetSaved > 0) stepTotals.set('retain-middle', (stepTotals.get('retain-middle') ?? 0) + budgetSaved);
  }
}

const totalSaved = baseline - after;
const pc = (value) => `${(100 * value).toFixed(1)}%`;
console.log(`会话文件        : ${readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length}`);
console.log(`工具结果条数    : ${rows.length}`);
console.log(`基线 token      : ${baseline.toLocaleString()}`);
console.log(`压缩后 token    : ${after.toLocaleString()}`);
console.log(`省下 token      : ${totalSaved.toLocaleString()}  (${pc(totalSaved / baseline)})`);
console.log(`被改动的结果条数: ${touched}  (${pc(touched / rows.length)})`);
console.log(`  其中预算裁剪  : ${retained}，纯无损规范化: ${losslessOnly}`);
console.log(`预算            : inlineChars=${inlineChars}`);

console.log('\n按工具（省量降序）：');
console.log('  tool                          calls      base     saved   saved%  trimmed');
for (const [tool, entry] of [...perTool].sort((a, b) => b[1].saved - a[1].saved)) {
  if (entry.saved === 0) continue;
  console.log(
    `  ${tool.padEnd(28)} ${String(entry.calls).padStart(5)} ${String(entry.tokens).padStart(9)} ${String(entry.saved).padStart(9)} ${pc(entry.saved / entry.tokens).padStart(7)} ${String(entry.retained).padStart(8)}`,
  );
}

if (perStep) {
  console.log('\n按变换步骤（单步归因，降序）：');
  for (const [name, saved] of [...stepTotals].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(20)} ${String(saved).padStart(9)} tok  ${pc(saved / totalSaved).padStart(6)} of savings`);
  }
}

if (topN > 0) {
  console.log(`\n省量最大的 ${topN} 条结果：`);
  for (const row of ranked.sort((a, b) => b.saved - a.saved).slice(0, topN)) {
    console.log(`  ${row.tool.padEnd(24)} ${String(row.chars).padStart(8)} chars -> saved ${row.saved} tok`);
  }
}

const jsonAt = args.indexOf('--json');
if (jsonAt !== -1) {
  writeFileSync(
    args[jsonAt + 1],
    JSON.stringify(
      {
        files: readdirSync(dir).filter((name) => name.endsWith('.jsonl')).length,
        results: rows.length,
        inlineChars,
        baselineTokens: baseline,
        afterTokens: after,
        savedTokens: totalSaved,
        savingsPct: (100 * totalSaved) / baseline,
        touched,
        retained,
        losslessOnly,
        perTool: Object.fromEntries(perTool),
        perStep: Object.fromEntries(stepTotals),
      },
      null,
      1,
    ),
  );
}
