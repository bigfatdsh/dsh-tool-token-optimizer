/**
 * 真实语料评测（v1.0.15 口径）。
 *
 * 输出四张表：按工具的省量、被裁剪结果的预算利用率、说明行质量、以及硬不变量。
 * 全部数字来自 `.corpus/raw` 里 DSH 会话日志解出来的**真实工具结果**，不含合成样本。
 *
 * 用法：
 *   node tools/bench2.mjs [语料目录] [--budget 1200]
 *
 * @module dsh-tool-token-optimizer/tools/bench2
 */
import { loadRows } from '../lib/replay-core.js';
import { optimizeResult } from '../lib/policy.js';

const args = process.argv.slice(2);
const budgetAt = args.indexOf('--budget');
const budget = budgetAt === -1 ? 1200 : Number(args[budgetAt + 1]);
const dir = args.find((value, index) => !value.startsWith('--') && index !== budgetAt + 1) ?? '.corpus/raw';

const OPTIONS = {
  inlineChars: budget,
  triggerRatio: 1,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: Math.max(400, Math.floor(budget * 0.4)),
  toolBudgets: {},
  minBlockChars: 400,
};

const rows = loadRows(dir).filter((row) => typeof row.text === 'string' && row.text.length > 0);
const byTool = new Map();
const over = [];
const readNotices = [];
let before = 0;
let after = 0;
let changed = 0;
let ms = 0;
const utilization = [];

for (const row of rows) {
  const started = Number(process.hrtime.bigint()) / 1e6;
  const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
  ms += Number(process.hrtime.bigint()) / 1e6 - started;
  const inputChars = row.text.length;
  let outputChars = 0;
  const truncatedNow = Array.isArray(result.steps) && result.steps.includes('retain-middle');
  for (const block of result.content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      outputChars += block.text.length;
      // 只考核"本次真的做了中段裁剪"的块；被跳过的 foreign-elided 结果由别的
      // 优化器负责，长度不归本插件管。
      if (truncatedNow && block.text.length > budget) over.push({ tool: row.tool, chars: block.text.length });
    }
  }
  before += inputChars;
  after += outputChars;
  const truncated = truncatedNow;
  if (truncated) {
    changed += 1;
    utilization.push(outputChars / budget);
  }
  if (truncated && row.tool === 'read') {
    const text = result.content.map((block) => block.text ?? '').join('');
    readNotices.push({ ranges: /file lines \d+/.test(text), notice: text.includes('[…] omitted') });
  }
  const entry = byTool.get(row.tool) ?? { n: 0, changed: 0, before: 0, after: 0 };
  entry.n += 1;
  entry.changed += result.changed ? 1 : 0;
  entry.before += inputChars;
  entry.after += outputChars;
  byTool.set(row.tool, entry);
}

const percent = (part, whole) => (whole === 0 ? '0.0' : ((100 * part) / whole).toFixed(1));
const quantile = (sorted, ratio) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]);
utilization.sort((left, right) => left - right);

console.log(`语料：${rows.length} 条真实工具结果，${(before / 1e6).toFixed(2)}M 字符；预算 ${budget} 字符/条`);
console.log(`总计：省 ${percent(before - after, before)}%（${((before - after) / 1e6).toFixed(2)}M 字符），中段裁剪 ${changed} 条（${percent(changed, rows.length)}%），平均 ${(ms / rows.length).toFixed(3)} ms/条`);

console.log('\n按工具（字符量 ≥ 20k）：');
const head = ['工具', '条数', '裁剪率', '输入', '输出', '省量'];
console.log(`  ${head[0].padEnd(30)} ${head[1].padStart(6)} ${head[2].padStart(6)} ${head[3].padStart(9)} ${head[4].padStart(9)} ${head[5].padStart(7)}`);
for (const [tool, entry] of [...byTool].sort((left, right) => right[1].before - left[1].before)) {
  if (entry.before < 20000) continue;
  console.log(
    `  ${tool.padEnd(30)} ${String(entry.n).padStart(6)} ${`${percent(entry.changed, entry.n)}%`.padStart(6)} ` +
      `${`${(entry.before / 1e6).toFixed(2)}M`.padStart(9)} ${`${(entry.after / 1e6).toFixed(2)}M`.padStart(9)} ` +
      `${`${percent(entry.before - entry.after, entry.before)}%`.padStart(7)}`,
  );
}

console.log('\n被裁剪结果的预算利用率：');
console.log(
  `  p10=${quantile(utilization, 0.1).toFixed(2)} p50=${quantile(utilization, 0.5).toFixed(2)} ` +
    `p90=${quantile(utilization, 0.9).toFixed(2)} 中位成品 ${Math.round(quantile(utilization, 0.5) * budget)} 字符`,
);

console.log('\n硬不变量：');
console.log(`  超过内联预算的文本块：${over.length} 个`);
console.log(`  read 裁剪结果带文件行号区间：${readNotices.filter((item) => item.ranges).length}/${readNotices.length}`);
console.log(`  read 裁剪结果带说明行：${readNotices.filter((item) => item.notice).length}/${readNotices.length}`);
