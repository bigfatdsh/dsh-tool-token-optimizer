/**
 * 会话度量 CLI：给一个 session id，直接读出它的请求数、prompt token、缓存命中率、
 * 工具调用分布、工具结果大小与裁剪次数——用于给行为对照实验判分与计量。
 *
 * 聚合逻辑在 `lib/metrics.js`（可安全 import，CLI 与实验脚本共用）。
 *
 * 用法：
 *   node tools/session-metrics.mjs <sessionId> [<sessionId> ...] [--json]
 *   node tools/session-metrics.mjs --answer <sessionId>     # 只抽取末尾的 ANSWER= 行
 *
 * @module dsh-tool-token-optimizer/tools/session-metrics
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { metricsOf } from '../lib/metrics.js';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 按 zstd 帧魔数切开并逐帧解压。 */
function readSession(sessionId) {
  const root = join(homedir(), '.dsh', 'sessions');
  for (const workspace of readdirSync(root)) {
    const file = join(root, workspace, sessionId, 'session.v4.jsonl.zstd');
    try {
      statSync(file);
    } catch {
      continue;
    }
    const buffer = readFileSync(file);
    const starts = [];
    let at = buffer.indexOf(MAGIC, 0);
    while (at !== -1) {
      starts.push(at);
      at = buffer.indexOf(MAGIC, at + 4);
    }
    const parts = [];
    for (let index = 0; index < starts.length; index += 1) {
      const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
      try {
        parts.push(zstdDecompressSync(buffer.subarray(starts[index], end)));
      } catch {
        // 帧内假魔数
      }
    }
    return Buffer.concat(parts).toString('utf8');
  }
  return null;
}

/**
 * 从一份会话日志里聚合度量。
 *
 * @param text - 解压后的 JSONL 文本。
 * @returns 度量对象。
 */
const args = process.argv.slice(2);
const onlyAnswer = args.includes('--answer');
const ids = args.filter((value) => !value.startsWith('--'));
if (ids.length === 0) {
  console.error('usage: node tools/session-metrics.mjs <sessionId> [...] [--answer] [--json]');
  process.exit(2);
}

const out = {};
for (const id of ids) {
  const text = readSession(id);
  if (text === null) {
    out[id] = null;
    if (!args.includes('--json')) console.log(`${id}: 日志不存在`);
    continue;
  }
  const metrics = metricsOf(text);
  out[id] = metrics;
  if (args.includes('--json')) continue;
  if (onlyAnswer) {
    console.log(`${id}\t${metrics.answer ?? '(无 ANSWER= 行)'}`);
    continue;
  }
  console.log(`【${id}】`);
  console.log(`  请求 ${metrics.requests} | prompt ${metrics.prompt.toLocaleString()}（命中 ${metrics.cacheRead.toLocaleString()} / 未命中 ${metrics.uncached.toLocaleString()}，${metrics.hitPct.toFixed(1)}%）| 输出 ${metrics.output.toLocaleString()}`);
  console.log(`  工具结果 ${metrics.toolResults} 条 / ${metrics.toolResultChars.toLocaleString()} 字符 | 被裁剪 ${metrics.elided} 条（省 ${metrics.elidedChars.toLocaleString()} 字符）`);
  console.log(`  工具调用：${JSON.stringify(metrics.toolCalls)}`);
  console.log(`  末尾 ANSWER：${metrics.answer ?? '(无)'}`);
}
if (args.includes('--json')) console.log(JSON.stringify(out, null, 1));
