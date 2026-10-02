/**
 * 回放内核：解析会话日志、套用策略、逐步归因。被 CLI（`tools/replay.mjs`）与
 * 单元测试共用，保证“测试里量到的”和“回放报告里量到的”是同一段代码。
 *
 * @module dsh-tool-token-optimizer/replay-core
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { estimateBlock, estimateContent } from './tokens.js';
import { compactText } from './text.js';
import { optimizeResult } from './policy.js';

/** 取出一条结果里所有文本块的拼接（仅用于统计与指纹）。 */
export function resultText(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * 解析目录下全部 `.jsonl` 会话日志，产出「工具调用 → 结果」行。
 *
 * @param dir - 原始（已解压）会话日志目录。
 * @returns 行数组：`{ file, tool, args, content, text, isError, chars, baselineTokens }`。
 */
export function loadRows(dir) {
  const rows = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    const names = new Map();
    const args = new Map();
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'tool/call') {
        const call = event.data?.call ?? event.data;
        if (call?.callId !== undefined) {
          names.set(call.callId, call.name);
          args.set(call.callId, call.arguments);
        }
      } else if (event.type === 'tool/result') {
        const message = event.data?.message;
        const callId = message?.toolCallId;
        const content = message?.content ?? [];
        rows.push({
          file,
          tool: names.get(callId) ?? 'unknown',
          args: args.get(callId),
          content,
          text: resultText(content),
          isError: message?.isError === true,
          chars: resultText(content).length,
          baselineTokens: estimateContent(content),
        });
      }
    }
  }
  return rows;
}

/**
 * 对一行结果套用**真实策略**。
 *
 * 直接调用插件运行时用的 `optimizeResult`，因此回放报告里的省量就是插件上线后的省量，
 * 不存在“回放器一套算法、插件另一套算法”的偏差。
 *
 * @param row - `loadRows` 产出的一行。
 * @param options - 见 `policy.js` 的 `PolicyOptions`；缺省时用插件默认值。
 * @returns `{ content, saved, steps }`。
 */
export function applyPolicy(row, options = {}) {
  const resolved = {
    inlineChars: 1600,
    triggerRatio: 1,
    headRatio: 0.55,
    tailRatio: 0.35,
    minTailChars: 300,
    importantBudgetChars: 640,
    toolBudgets: {},
    minBlockChars: 400,
    ...options,
  };
  const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, resolved);
  return { content: result.content, saved: result.savedTokens, steps: result.steps };
}

/**
 * 逐步归因：把每个变换单独施加在同一份原文上，量出它自己贡献的 token 数。
 * 用于判断“哪一步值得保留”，不参与插件运行时决策。
 *
 * @param row - `loadRows` 产出的一行。
 * @returns `{ name, saved }[]`。
 */
export function isolatedSteps(row) {
  if (row.isError) return [];
  const text = row.text;
  if (text.length === 0) return [];
  const variants = {
    newlines: { enableJsonBreak: false },
    'trailing-spaces': { enableJsonBreak: false },
    'blank-padding': { enableJsonBreak: false },
    'blank-runs': { enableJsonBreak: false },
    'duplicate-runs': { enableJsonBreak: false },
    'json-break': { enableJsonBreak: true },
  };
  const out = [];
  for (const [name, options] of Object.entries(variants)) {
    const result = compactText(text, options);
    if (!result.steps.includes(name)) continue;
    const saved = estimateBlock({ type: 'text', text }) - estimateBlock({ type: 'text', text: result.text });
    if (saved > 0) out.push({ name, saved });
  }
  return out;
}
