/**
 * 缓存稳定性测试：证明本插件**不会**降低 provider 侧的缓存命中率。
 *
 * 命中率由三个机制决定，本文件逐条给出可执行证据：
 *
 * 1. **前缀不变性**：插件只在 `tools/post-execute` 改“尚未落盘、也尚未发出去”的那一条
 *    结果；不触碰系统提示、工具表、任何历史消息，因此已缓存前缀永远有效。
 * 2. **确定性**：同一份输入内容永远得到同一份输出（无时间、随机数、跨调用状态），
 *    因此同一条结果不会在两次请求里呈现成不同文本——“同一前缀”必须是逐字节相同。
 * 3. **只减不增**：压缩后更小，所以真发生前缀作废时，需要重新计价的 token 也更少。
 *
 * @module dsh-tool-token-optimizer/test/cache
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { loadRows } from '../lib/replay-core.js';
import { optimizeResult } from '../lib/policy.js';
import { estimateContent } from '../lib/tokens.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = process.env.DSH_OPTIMIZER_CORPUS ?? join(here, '..', '..', '.corpus', 'raw');
const hasCorpus = existsSync(corpusDir);

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

/** 一个极简上下文，用来捕获注册的监听器。 */
function createContext() {
  const listeners = [];
  return {
    listeners,
    agents: { list: () => [] },
    on(event, handler, options) {
      listeners.push({ event, handler, options });
    },
    inject() {},
    effect(register) {
      register();
    },
    logger: { info() {}, warn() {} },
    handler() {
      return listeners.find((item) => item.event === 'tools/post-execute').handler;
    },
  };
}

const run = (handler, exec, result, next = { kind: 'accept' }) => handler(exec, result, async () => next);

test('前缀不变性：插件从不改写系统提示与工具表', async () => {
  const ctx = createContext();
  apply(ctx, {});
  // 只注册了 tools/post-execute 与 agent/created：没有任何 system-prompt 装配钩子。
  const events = new Set(ctx.listeners.map((item) => item.event));
  assert.deepEqual([...events].sort(), ['agent/created', 'tools/post-execute']);
  for (const event of ctx.listeners.map((item) => item.event)) {
    assert.equal(/system-prompt|request|tool.*schema|assemble/i.test(event), false, `不得挂 ${event}`);
  }
});

test('确定性：同一内容重复处理 N 次，输出逐字节相同', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 1600 });
  const handler = ctx.handler();
  const text = Array.from({ length: 500 }, (_, index) => `line ${index} ${'x'.repeat(60)}`).join('\n');
  const outputs = new Set();
  for (let round = 0; round < 8; round += 1) {
    // 每次都换一个结果对象（复刻真实调用：每次工具调用都是新对象）
    const decision = await run(handler, { name: 'bash' }, { isError: false, content: [{ type: 'text', text }] });
    outputs.add(JSON.stringify(decision.content));
  }
  assert.equal(outputs.size, 1, '同一输入必须只产生一种输出');
});

test('确定性：与调用顺序、其它结果、时间无关', async () => {
  const text = (label) => Array.from({ length: 300 }, (_, index) => `${label} ${index} ${'y'.repeat(50)}`).join('\n');
  const first = optimizeResult({ tool: 'bash', content: [{ type: 'text', text: text('a') }] }, OPTIONS);
  // 中间穿插完全不同的结果，再算一次同样的输入
  optimizeResult({ tool: 'read', content: [{ type: 'text', text: text('b') }] }, OPTIONS);
  optimizeResult({ tool: 'web_fetch', content: [{ type: 'text', text: 'short' }] }, OPTIONS);
  const second = optimizeResult({ tool: 'bash', content: [{ type: 'text', text: text('a') }] }, OPTIONS);
  assert.deepEqual(second.content, first.content, '输出不得依赖历史调用');
});

test('确定性：多个并发的相同输入互不干扰', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 800 });
  const handler = ctx.handler();
  const text = Array.from({ length: 400 }, (_, index) => `row ${index} ${'z'.repeat(40)}`).join('\n');
  const results = await Promise.all(
    Array.from({ length: 6 }, () => run(handler, { name: 'bash' }, { isError: false, content: [{ type: 'text', text }] })),
  );
  const unique = new Set(results.map((item) => JSON.stringify(item.content)));
  assert.equal(unique.size, 1);
});

test('前缀作废时重新计价的 token 只减不增', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let before = 0;
  let after = 0;
  for (const row of rows) {
    before += estimateContent(row.content);
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    after += estimateContent(result.content);
    assert.ok(after <= before + 1, '任何时刻累计量都不得反超');
  }
  const savedPct = (100 * (before - after)) / before;
  assert.ok(savedPct > 50, `真实语料省量应过半，实际 ${savedPct.toFixed(1)}%`);
  console.log(
    `    invalidation re-pricing surface: ${before.toLocaleString()} -> ${after.toLocaleString()} tok ` +
      `(${savedPct.toFixed(1)}% smaller on every prefix miss)`,
  );
});

test('插件不引入任何额外的模型请求或提示内容', () => {
  const ctx = createContext();
  apply(ctx, {});
  // 没有 section/context/tools provider、没有命令、没有工具注册——只有监听器。
  assert.equal(ctx.listeners.length, 2, '恰好两个监听器：post-execute 与 agent/created');
  assert.equal(ctx.listeners.every((item) => typeof item.handler === 'function'), true);
});
