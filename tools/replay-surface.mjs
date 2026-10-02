/**
 * 全表面回放：对真实会话做“反事实计量”。
 *
 * 对每一个模型请求，重建当时真正发出去的表面（system 提示 + 历史消息 + 工具表），
 * 分别按「原始结果」与「压缩后结果」计价，两者的差就是插件在那一次请求上省下的
 * token。所有请求累加，得到的是**与会话账单同口径**的省量，而不是“工具结果总量”
 * 这种上界估计。
 *
 * 用法：
 *   node tools/replay-surface.mjs <raw-jsonl-dir> [--inline N] [--json out.json]
 *
 * 说明：这是离线反事实模型，不调用模型、不产生费用；计价函数与插件运行时共用
 * `lib/tokens.js`，与官方 token-meter 同构。
 *
 * @module dsh-tool-token-optimizer/tools/replay-surface
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateContent, estimateMessage, estimateToolsTokens } from '../lib/message.js';
import { optimizeResult } from '../lib/policy.js';

const args = process.argv.slice(2);
const dir = args[0];
if (dir === undefined) {
  console.error('usage: node tools/replay-surface.mjs <raw-jsonl-dir> [--inline N] [--json out.json]');
  process.exit(2);
}
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : Number(args[at + 1]);
};
const inlineChars = flag('--inline', 2400);

const options = {
  inlineChars,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: Math.floor(inlineChars * 0.2),
  breakJson: true,
  jsonMinChars: 2000,
  jsonMinCommas: 24,
  minBlockChars: 400,
};

/** 读一份会话日志的事件流。 */
function readEvents(file) {
  const events = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // 截断的尾行：跳过。
    }
  }
  return events;
}

/**
 * 回放一份会话：返回每一次请求的计价明细。
 *
 * 表面按 seq 顺序累加：`system/message`、`user/message`、`assistant/message`、`tool/result`。
 * 带 `surfaceOp: replace` 的结果替换它 `sourceEventSeqs` 指向的那一条（压缩器写回的
 * 替换事件就是这个形状），因此回放对“被压缩过的历史”同样成立。
 */
function replaySession(file) {
  const events = readEvents(file);
  const header = events.find((event) => event.type === 'request/header')?.data?.header;
  const toolsTokens = header === undefined ? 0 : estimateToolsTokens(header);
  const surface = [];
  const bySeq = new Map();
  const requests = [];
  const names = new Map();

  for (const event of events) {
    if (event.type === 'tool/call') {
      const call = event.data?.call ?? event.data;
      if (call?.callId !== undefined) names.set(call.callId, call.name);
    }
    const op = event.surfaceOp;
    const message = event.data?.message;
    if (message !== undefined && typeof event.seq === 'number') {
      const entry = { seq: event.seq, message, kind: event.type };
      if (op?.op === 'replace') {
        const from = event.sourceEventSeqs?.[0];
        const at = from === undefined ? -1 : surface.findIndex((item) => item.seq === from);
        if (at >= 0) surface[at] = entry;
        else surface.push(entry);
      } else {
        surface.push(entry);
      }
      bySeq.set(event.seq, entry);
    }
    if (event.type === 'assistant/message') {
      requests.push({ at: surface.length, events: [...surface], names: new Map(names) });
    }
  }

  const priced = [];
  for (const request of requests) {
    let before = toolsTokens;
    let after = toolsTokens;
    for (const entry of request.events) {
      const message = entry.message;
      before += estimateMessage(message);
      if (entry.kind === 'tool/result' && message?.content !== undefined) {
        const tool = request.names.get(message.toolCallId) ?? 'unknown';
        const optimized = optimizeResult(
          { tool, content: message.content, isError: message.isError === true },
          options,
        );
        after += estimateMessage({ ...message, content: optimized.content });
      } else {
        after += estimateMessage(message);
      }
    }
    priced.push({ before, after });
  }
  return priced;
}

const perSession = [];
let totalBefore = 0;
let totalAfter = 0;
let requests = 0;
for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
  let priced;
  try {
    priced = replaySession(join(dir, file));
  } catch (error) {
    console.error(`skip ${file}: ${error.message}`);
    continue;
  }
  const before = priced.reduce((sum, item) => sum + item.before, 0);
  const after = priced.reduce((sum, item) => sum + item.after, 0);
  if (before === 0) continue;
  requests += priced.length;
  totalBefore += before;
  totalAfter += after;
  perSession.push({ file, requests: priced.length, before, after, savedPct: (100 * (before - after)) / before });
}

perSession.sort((a, b) => b.savedPct - a.savedPct);
const pct = (value) => `${(100 * value).toFixed(1)}%`;
const ratios = perSession.map((item) => item.savedPct / 100).sort((a, b) => a - b);
console.log(`inlineChars=${inlineChars}`);
console.log(`会话数 ${perSession.length}，请求数 ${requests}`);
console.log(`基线表面 token ${totalBefore.toLocaleString()} -> ${totalAfter.toLocaleString()}，省 ${(totalBefore - totalAfter).toLocaleString()} (${pct((totalBefore - totalAfter) / totalBefore)})`);
console.log(
  `单会话省量中位数 ${pct(ratios[Math.floor(ratios.length * 0.5)] ?? 0)}，p25 ${pct(ratios[Math.floor(ratios.length * 0.25)] ?? 0)}，p75 ${pct(ratios[Math.floor(ratios.length * 0.75)] ?? 0)}`,
);
console.log('\n会话                                 请求     基线     压缩后    省%');
for (const item of perSession.slice(0, 30)) {
  console.log(
    `${item.file.replace('.jsonl', '').slice(0, 36).padEnd(36)} ${String(item.requests).padStart(5)} ${String(item.before).padStart(9)} ${String(item.after).padStart(9)} ${item.savedPct.toFixed(1).padStart(7)}%`,
  );
}

const jsonOut = args.indexOf('--json');
if (jsonOut !== -1) {
  writeFileSync(
    args[jsonOut + 1],
    JSON.stringify({ inlineChars, requests, totalBefore, totalAfter, perSession }, null, 1),
  );
}
