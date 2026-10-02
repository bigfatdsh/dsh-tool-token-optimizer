/**
 * 缓存命中率审计：直接从会话日志的 provider usage 里算真实命中率，并定位每一次
 * **前缀作废**（缓存读取量断崖下跌）及其发生原因。
 *
 * 用法：
 *   node tools/cache-audit.mjs <raw-jsonl-dir> [--json out.json]
 *
 * ## 命中率的口径
 *
 * DeepSeek 侧返回的两个字段构成一次请求的输入：
 * - `cacheReadTokens`：命中前缀缓存、按缓存价计费的部分；
 * - `inputTokens`：未命中、按全价计费的部分。
 *
 * 因此 `命中率 = cacheRead / (cacheRead + input)`。这个数字**不是**插件能直接控制的：
 * 它由「前缀是否稳定」决定，而前缀 = 系统提示 + 工具表 + 历史消息。
 *
 * ## 什么会让它掉下来
 *
 * 1. **每个会话的首个请求**：注定全 miss，属于一次性成本；会话越长，占比越小。
 * 2. **前缀作废**：系统提示或工具表发生变化（`request/header` 的 `reason=change|resume`
 *    往往伴随工具表尺寸变化），已缓存前缀整段失效，下一次请求要把整个上下文重新计价。
 * 3. **短会话**：请求数少到一次性成本摊不开。
 *
 * 本工具把这三项分开计量，因此“要不要优化、优化哪一项”是可判断的，而不是拍脑袋。
 *
 * @module dsh-tool-token-optimizer/tools/cache-audit
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = args[0];
if (dir === undefined) {
  console.error('usage: node tools/cache-audit.mjs <raw-jsonl-dir> [--json out.json]');
  process.exit(2);
}
const charBudget = Number(process.env.DSH_OPTIMIZER_INLINE ?? 1600);

/** 读一份会话日志的全部事件。 */
function readEvents(file) {
  const events = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 截断尾行
    }
  }
  return events;
}

const sessions = [];
for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
  const events = readEvents(join(dir, file));
  const requests = [];
  let pendingHeader = null;
  for (const event of events) {
    if (event.type === 'request/header') {
      pendingHeader = {
        bytes: JSON.stringify(event.data?.header ?? {}).length,
        reason: event.data?.reason ?? '-',
        tools: Array.isArray(event.data?.header?.tools) ? event.data.header.tools.length : 0,
      };
      continue;
    }
    if (event.type !== 'assistant/message' || event.data?.usage === undefined) continue;
    const usage = event.data.usage;
    requests.push({
      read: usage.cacheReadTokens ?? 0,
      uncached: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      header: pendingHeader,
    });
  }
  if (requests.length === 0) continue;

  const sum = (key) => requests.reduce((total, item) => total + item[key], 0);
  const read = sum('read');
  const uncached = sum('uncached');
  const prompt = read + uncached;
  const first = requests[0].uncached;

  // 前缀作废：缓存读取量相对上一次跌去一半以上
  const invalidations = [];
  let previous = null;
  for (const [index, request] of requests.entries()) {
    if (index > 0 && request.read < previous.read * 0.5) {
      invalidations.push({
        at: index,
        missedTokens: request.uncached,
        header: request.header,
        previousHeader: previous.header,
      });
    }
    previous = request;
  }

  sessions.push({
    file: file.replace('.jsonl', ''),
    requests: requests.length,
    read,
    uncached,
    prompt,
    hitPct: (100 * read) / Math.max(1, prompt),
    firstRequestMiss: first,
    invalidationMiss: invalidations.reduce((total, item) => total + item.missedTokens, 0),
    invalidations,
  });
}

sessions.sort((a, b) => a.hitPct - b.hitPct);
const sum = (key) => sessions.reduce((total, item) => total + item[key], 0);
const read = sum('read');
const uncached = sum('uncached');
const overall = (100 * read) / Math.max(1, read + uncached);

const pct = (value) => `${value.toFixed(1)}%`;
console.log(`会话数 ${sessions.length}　请求数 ${sum('requests')}`);
console.log(
  `整体命中率 ${pct(overall)}　（cacheRead ${read.toLocaleString()} / 未命中输入 ${uncached.toLocaleString()}）`,
);
console.log(
  `未命中构成：每会话首请求 ${sum('firstRequestMiss').toLocaleString()}（${pct((100 * sum('firstRequestMiss')) / uncached)}）、` +
    `前缀作废 ${sum('invalidationMiss').toLocaleString()}（${pct((100 * sum('invalidationMiss')) / uncached)}）`,
);
const below = sessions.filter((item) => item.hitPct < 95);
console.log(`达到 95% 的会话：${sessions.length - below.length}/${sessions.length}`);

console.log('\n会话                                    请求    命中率   首请求miss  作废miss  作废次数');
for (const item of sessions) {
  console.log(
    `${item.file.slice(0, 38).padEnd(38)} ${String(item.requests).padStart(5)} ${pct(item.hitPct).padStart(8)} ` +
      `${String(item.firstRequestMiss).padStart(11)} ${String(item.invalidationMiss).padStart(9)} ${String(item.invalidations.length).padStart(9)}`,
  );
}

if (below.length > 0) {
  console.log('\n未达 95% 的会话及其原因：');
  for (const item of below) {
    const reasons = [];
    if (item.requests <= 6) reasons.push(`短会话（${item.requests} 个请求，首请求 ${item.firstRequestMiss} tok 摊不开）`);
    if (item.invalidations.length > 0) reasons.push(`前缀作废 ${item.invalidations.length} 次（${item.invalidationMiss.toLocaleString()} tok）`);
    console.log(`  ${item.file.slice(0, 38).padEnd(38)} ${pct(item.hitPct)} ← ${reasons.join('；') || '未定位'}`);
  }
}

const jsonAt = args.indexOf('--json');
if (jsonAt !== -1) {
  writeFileSync(args[jsonAt + 1], JSON.stringify({ overall, charBudget, sessions }, null, 1));
}
