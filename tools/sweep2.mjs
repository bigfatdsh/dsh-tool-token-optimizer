/**
 * 预算 × 安全带矩阵扫描：在真实语料上同时评估“省量”与“改动幅度”，
 * 用来给默认值定标。
 *
 * 用法：
 *   node tools/sweep2.mjs <raw-jsonl-dir>
 *
 * @module dsh-tool-token-optimizer/tools/sweep2
 */

import { loadRows } from '../lib/replay-core.js';
import { estimateContent } from '../lib/tokens.js';
import { optimizeResult } from '../lib/policy.js';

const dir = process.argv[2];
if (dir === undefined) {
  console.error('usage: node tools/sweep2.mjs <raw-jsonl-dir>');
  process.exit(2);
}
const rows = loadRows(dir).filter((row) => row.isError !== true && row.chars > 0);
const baseline = rows.reduce((sum, row) => sum + estimateContent(row.content), 0);

const perFile = new Map();
for (const row of rows) {
  const list = perFile.get(row.file) ?? [];
  list.push(row);
  perFile.set(row.file, list);
}
const sessions = [...perFile.values()].filter((list) => list.length >= 10);

const budgets = [1600, 2400, 3200, 4800];
const ratios = [1, 1.5, 2, 3, 4];

console.log(`rows=${rows.length} baseline=${baseline.toLocaleString()} sessions=${sessions.length}`);
console.log('budget  ratio  touched  touch%   saved%  medianSessionSaved%  p25%   p75%');
for (const inlineChars of budgets) {
  for (const triggerRatio of ratios) {
    const options = {
      inlineChars,
      triggerRatio,
      headRatio: 0.55,
      tailRatio: 0.35,
      minTailChars: 300,
      importantBudgetChars: Math.floor(inlineChars * 0.2),
      breakJson: true,
      jsonMinChars: 2000,
      jsonMinCommas: 24,
      minBlockChars: 400,
    };
    let after = 0;
    let touched = 0;
    for (const row of rows) {
      const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, options);
      after += estimateContent(result.content);
      if (result.changed) touched += 1;
    }
    const perSession = sessions.map((list) => {
      const before = list.reduce((sum, row) => sum + estimateContent(row.content), 0);
      const next = list.reduce(
        (sum, row) => sum + estimateContent(optimizeResult({ tool: row.tool, content: row.content }, options).content),
        0,
      );
      return before === 0 ? 0 : 1 - next / before;
    });
    perSession.sort((a, b) => a - b);
    const pc = (value) => `${(100 * value).toFixed(1)}%`;
    console.log(
      `${String(inlineChars).padStart(6)} ${String(triggerRatio).padStart(6)} ${String(touched).padStart(8)} ${pc(touched / rows.length).padStart(7)} ${pc((baseline - after) / baseline).padStart(8)} ${pc(perSession[Math.floor(perSession.length * 0.5)]).padStart(19)} ${pc(perSession[Math.floor(perSession.length * 0.25)]).padStart(6)} ${pc(perSession[Math.floor(perSession.length * 0.75)]).padStart(6)}`,
    );
  }
}
