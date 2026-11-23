/**
 * v1 vs v2 对照基准：同一批真实结果，同一份预算，比"省多少 / 多快 / 说明多长 / 保真"。
 *
 * 用法：node tools/bench-v2.mjs <corpusDir> [--json out.json]
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadRows } from '../lib/replay-core.js';
import { optimizeResult as v2 } from '../lib/policy.js';
// 基线（v1）从环境变量指向旧版 lib 的入口；不给就只跑当前版本。
//   mkdir -p /tmp/v1-lib && for f in $(git ls-tree --name-only HEAD lib/); do git show HEAD:$f > /tmp/v1-lib/$(basename $f); done
//   TTO_BASELINE=/tmp/v1-lib/policy.js node tools/bench-v2.mjs <corpusDir>
const baselinePath = process.env.TTO_BASELINE ?? '';
const v1 = baselinePath === '' ? null : (await import(pathToFileURL(baselinePath).href)).optimizeResult;
import { estimateContent } from '../lib/tokens.js';

const corpus = process.argv[2];
const outFlag = process.argv.indexOf('--json');
const outPath = outFlag === -1 ? null : process.argv[outFlag + 1];
if (corpus === undefined) {
  console.error('usage: node tools/bench-v2.mjs <corpusDir> [--json out.json]');
  process.exit(2);
}

const OPTIONS = {
  inlineChars: 1200,
  triggerRatio: 1,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: 480,
  toolBudgets: {},
  minBlockChars: 200,
};

const rows = loadRows(corpus).filter((row) => !row.isError && row.text.length > 0);
const rowsV1 = rows.filter((row) => !/\[…\] omitted \d+ chars \/ \d+ lines/.test(row.text));

const textOf = (result) => (result.content ?? []).filter((block) => block?.type === 'text').map((block) => block.text).join('');

function run(impl, list) {
  const stats = {
    rows: 0, changed: 0, hit: 0,
    charsBefore: 0, charsAfter: 0,
    tokensBefore: 0, tokensAfter: 0,
    noticeChars: 0, notices: 0, noticeMax: 0,
    overBudget: 0, fakeLines: 0, lostErrorLines: 0, arithmeticBad: 0,
    ms: 0, slowest: { ms: 0, chars: 0, tool: '' },
  };
  const errorPattern = /\b(?:error|failed|fatal|panic|exception|traceback)\b|npm ERR!|\[exit code: \d+\]/i;
  for (const row of list) {
    stats.rows += 1;
    const before = estimateContent(row.content);
    const t0 = process.hrtime.bigint();
    const result = impl({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    stats.ms += ms;
    if (ms > stats.slowest.ms) stats.slowest = { ms: Number(ms.toFixed(2)), chars: row.text.length, tool: row.tool };
    const out = textOf(result);
    stats.charsBefore += row.text.length;
    stats.charsAfter += out.length;
    stats.tokensBefore += before;
    stats.tokensAfter += estimateContent(result.content);
    if (!result.changed) continue;
    stats.changed += 1;
    const notice = /\[…\] omitted (\d+) chars \/ (\d+) lines of (\d+)/.exec(out);
    if (notice === null) continue;
    stats.hit += 1;
    stats.notices += 1;
    const noticeLine = out.split('\n').find((line) => line.includes('[…] omitted')) ?? '';
    stats.noticeChars += noticeLine.length;
    stats.noticeMax = Math.max(stats.noticeMax, noticeLine.length);
    // 硬上界
    for (const block of result.content) {
      if (block?.type === 'text' && block.text.length > OPTIONS.inlineChars) stats.overBudget += 1;
    }
    // 算术自洽（逐块：多块结果各块各有一行说明）
    for (const block of result.content) {
      if (block?.type !== 'text') continue;
      const own = /\[…\] omitted (\d+) chars \/ (\d+) lines of (\d+)/.exec(block.text);
      if (own === null) continue;
      if (Number(own[1]) + block.text.length !== Number(own[3])) stats.arithmeticBad += 1;
    }
    // 伪行：成品里既不在原文、也没有截断标记的片段
    for (const line of out.split('\n')) {
      if (line.includes('[…] omitted')) continue;
      if (row.text.includes(line)) continue;
      if (line.includes('[line clipped]') || line.includes('⟨…+') || line.includes('⟨+')) continue;
      stats.fakeLines += 1;
      break;
    }
    // 报错行丢失（原文里有、成品里没有、说明也没提到）
    const errorLines = row.text.split('\n').filter((line) => errorPattern.test(line));
    if (errorLines.length > 0) {
      const missing = errorLines.filter((line) => !out.includes(line));
      if (missing.length > 0 && !/only in full text|error lines inside|error line inside/.test(out)) {
        stats.lostErrorLines += 1;
      }
    }
  }
  stats.avgNotice = stats.notices === 0 ? 0 : Number((stats.noticeChars / stats.notices).toFixed(1));
  stats.savedPct = Number((100 * (1 - stats.tokensAfter / stats.tokensBefore)).toFixed(1));
  stats.ms = Number(stats.ms.toFixed(0));
  return stats;
}

const a = v1 === null ? null : run(v1, rowsV1);
const b = run(v2, rowsV1);
// 速度：同一批数据各跑 3 轮取最好
const best = (impl) => {
  if (impl === null) return null;
  let bestMs = Infinity;
  for (let round = 0; round < 3; round += 1) {
    const t0 = process.hrtime.bigint();
    for (const row of rowsV1) impl({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    bestMs = Math.min(bestMs, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return Number(bestMs.toFixed(0));
};
const speedV1 = best(v1);
const speedV2 = best(v2);

const payload = { rows: rowsV1.length, skippedNested: rows.length - rowsV1.length, v1: a, v2: b, speed: { v1: speedV1, v2: speedV2 } };
if (outPath !== null) writeFileSync(outPath, JSON.stringify(payload, null, 1));
console.log(JSON.stringify(payload));
