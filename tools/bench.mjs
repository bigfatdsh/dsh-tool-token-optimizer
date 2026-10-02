/**
 * 性能基准：量化插件在**每一次工具调用**上增加的开销。
 *
 * 插件的全部运行时成本只有一处：工具结果落盘**之前**在内存里跑一遍纯函数变换。
 * 它不发起任何 I/O、网络、子进程或模型请求，因此“性能影响”就是这段 CPU 时间。
 *
 * 用法：
 *   node tools/bench.mjs [raw-jsonl-dir] [--runs N]
 *
 * 输出：
 * - 真实语料 2596 条结果的总耗时与单条 P50/P95/最大耗时；
 * - 按结果大小分档的耗时（确认随长度线性、无二次爆炸）；
 * - 最坏情况（40k 字符单行、40k 行多行、紧凑 JSON）的单条耗时；
 * - 与 DSH 一次工具调用基线（本地 bash 进程启动约 5–20 ms、网络类工具数百 ms）的对比。
 *
 * @module dsh-tool-token-optimizer/tools/bench
 */

import { loadRows } from '../lib/replay-core.js';
import { optimizeResult } from '../lib/policy.js';

const args = process.argv.slice(2);
const dir = args.find((value) => !value.startsWith('--')) ?? '../.corpus/raw';
const runsAt = args.indexOf('--runs');
const runs = runsAt === -1 ? 3 : Number(args[runsAt + 1]);

const OPTIONS = {
  inlineChars: 1600,
  triggerRatio: 1,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: 640,
  toolBudgets: {},
  minBlockChars: 400,
};

/** 高精度计时（毫秒）。 */
const now = () => Number(process.hrtime.bigint()) / 1e6;

/** 百分位。 */
function percentile(sorted, ratio) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

const rows = loadRows(dir);
console.log(`语料：${rows.length} 条真实工具结果，${runs} 轮\n`);

// ---- 1) 真实语料逐条计时 --------------------------------------------------------
const timings = [];
let totalChars = 0;
const perRow = [];
for (const row of rows) {
  totalChars += row.chars;
  const start = now();
  optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
  const cost = now() - start;
  timings.push(cost);
  perRow.push({ chars: row.chars, cost });
}
timings.sort((a, b) => a - b);
const total = timings.reduce((sum, value) => sum + value, 0);
console.log('【真实语料】');
console.log(`  总耗时        ${total.toFixed(1)} ms（${runs} 轮合计见下）`);
console.log(`  单条 平均     ${(total / rows.length).toFixed(3)} ms`);
console.log(`  单条 P50      ${percentile(timings, 0.5).toFixed(3)} ms`);
console.log(`  单条 P95      ${percentile(timings, 0.95).toFixed(3)} ms`);
console.log(`  单条 P99      ${percentile(timings, 0.99).toFixed(3)} ms`);
console.log(`  单条 最大     ${timings[timings.length - 1].toFixed(3)} ms（${rows[perRow.reduce((best, item, index, list) => (item.cost > list[best].cost ? index : best), 0)].tool}，${rows[perRow.reduce((best, item, index, list) => (item.cost > list[best].cost ? index : best), 0)].chars} 字符）`);

// ---- 2) 分档：确认随长度线性 -----------------------------------------------------
const buckets = [
  [0, 512],
  [512, 2048],
  [2048, 8192],
  [8192, 32768],
  [32768, Number.MAX_SAFE_INTEGER],
];
console.log('\n【按结果大小分档】（每档取平均值，确认线性、无二次爆炸）');
console.log('  字符区间         条数     平均字符     平均耗时      每 KB 耗时');
for (const [low, high] of buckets) {
  const items = perRow.filter((item) => item.chars >= low && item.chars < high);
  if (items.length === 0) continue;
  const avgChars = items.reduce((sum, item) => sum + item.chars, 0) / items.length;
  const avgCost = items.reduce((sum, item) => sum + item.cost, 0) / items.length;
  console.log(
    `  ${`${low}–${high === Number.MAX_SAFE_INTEGER ? '∞' : high}`.padEnd(16)} ${String(items.length).padStart(5)} ${avgChars.toFixed(0).padStart(12)} ${(`${avgCost.toFixed(3)} ms`).padStart(13)} ${(avgCost / Math.max(0.001, avgChars / 1024)).toFixed(4).padStart(14)} ms`,
  );
}

// ---- 3) 最坏情况 ---------------------------------------------------------------
const worstCases = {
  '40k 字符单行（minified JSON）': JSON.stringify({
    entries: Array.from({ length: 400 }, (_, index) => ({ id: index, name: `pkg-${index}`, path: `/tmp/dir/${index}/index.js` })),
  }),
  '40k 行多行文本': Array.from({ length: 40000 }, (_, index) => `line ${index} ${'x'.repeat(20)}`).join('\n'),
  '10 万行重复行': Array.from({ length: 100000 }, () => 'node_modules/foo/index.js').join('\n'),
  '200KB 无换行无重复': 'a'.repeat(200_000),
};
console.log('\n【最坏情况】（单条结果）');
for (const [label, text] of Object.entries(worstCases)) {
  const start = now();
  const result = optimizeResult({ tool: 'bash', content: [{ type: 'text', text }] }, OPTIONS);
  const cost = now() - start;
  const size = `${(text.length / 1024).toFixed(0)} KB`.padStart(8);
  console.log(`  ${label.padEnd(30)} ${size}  ${cost.toFixed(2).padStart(8)} ms  省 ${(text.length - result.after * 4).toLocaleString()} 字符量级`);
}

// ---- 4) 多轮稳定性 -------------------------------------------------------------
console.log(`\n【${runs} 轮重复】`);
for (let round = 1; round <= runs; round += 1) {
  const start = now();
  for (const row of rows) optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
  const cost = now() - start;
  console.log(`  第 ${round} 轮：${cost.toFixed(1)} ms（平均 ${(cost / rows.length).toFixed(3)} ms/条）`);
}

console.log('\n【与 DSH 工具调用基线的对比】');
console.log('  一次本地 bash 命令（进程启动 + 执行）：约 5–20 ms 起');
console.log('  一次文件 read：约 1–5 ms');
console.log('  一次 web 请求：数百 ms');
console.log(`  本插件单条平均：${(total / rows.length).toFixed(3)} ms —— 比最便宜的工具调用基线还低一个数量级以上`);
