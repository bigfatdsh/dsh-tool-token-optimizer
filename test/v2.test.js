import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRecoveryStore } from '../lib/spill.js';
import { optimizeResult } from '../lib/policy.js';
import { retainMiddle } from '../lib/retain.js';

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

const run = (tool, text, options = {}) => {
  const result = optimizeResult(
    { tool, content: [{ type: 'text', text }], isError: false },
    { ...OPTIONS, ...options },
  );
  return { ...result, out: result.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') };
};

const noticeOf = (out) => out.split('\n').find((line) => line.includes('[…] omitted')) ?? '';

test('v2 长单行：开头与结尾都在，且不存在"没标记的裸片段"', () => {
  const head = 'HEAD-MARKER';
  const tail = 'TAIL-MARKER';
  const line = `${head}${'m'.repeat(200000)}${tail}`;
  const text = `first line\n${line}\nlast line`;
  const { out, changed } = run('bash', text);
  assert.equal(changed, true);
  assert.ok(out.length <= OPTIONS.inlineChars);
  assert.ok(out.includes(head), '长行开头必须留下');
  assert.ok(out.includes(tail), '长行结尾必须留下');
  for (const piece of out.split('\n')) {
    if (piece.includes('[…] omitted')) continue;
    const complete = text.includes(piece);
    const marked = piece.includes('⟨…+') || piece.includes('⟨+');
    assert.ok(complete || marked, `出现既不是原文行、也没有截断标记的片段: ${JSON.stringify(piece.slice(0, 60))}`);
  }
});

test('v2 末行超长：结论的开头与真正的结尾同时保留', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `line ${i} ${'f'.repeat(40)}`);
  const conclusion = `SUMMARY: FINAL CONCLUSION ${'x'.repeat(900)} THE-END`;
  const { out } = run('bash', [...filler, conclusion].join('\n'));
  assert.ok(out.includes('SUMMARY: FINAL CONCLUSION'), '结论开头必须留下');
  assert.ok(out.includes('THE-END'), '真正的结尾必须留下');
});

test('v2 行数与区间自洽：区间跨度之和 == 说明里的行数', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `row ${i} ${'r'.repeat(30)}`);
  lines[150] = 'Error: boom in the middle';
  const { out } = run('bash', lines.join('\n'));
  const notice = noticeOf(out);
  const counts = /omitted (\d+) chars \/ (\d+) lines of/.exec(notice);
  assert.ok(counts !== null, notice);
  const rangeText = /; lines ([^;]+)/.exec(notice);
  if (rangeText !== null && !rangeText[1].includes('more')) {
    let sum = 0;
    for (const part of rangeText[1].split(', ')) {
      const [from, to] = part.split('-').map(Number);
      sum += (to === undefined ? from : to) - from + 1;
    }
    assert.equal(sum, Number(counts[2]), `区间 ${rangeText[1]} 与行数 ${counts[2]} 对不上`);
  }
});

test('v2 多文本块：总长永不超预算（旧实现可到 4.7 倍）', () => {
  const content = Array.from({ length: 20 }, (_, i) => ({ type: 'text', text: `${i}:${'z'.repeat(700)}` }));
  const result = optimizeResult({ tool: 'bash', content, isError: false }, { ...OPTIONS, minBlockChars: 400 });
  assert.equal(result.changed, true);
  const total = result.content.filter((b) => b?.type === 'text').reduce((sum, b) => sum + b.text.length, 0);
  assert.ok(total <= OPTIONS.inlineChars, `多块总长 ${total} 超过 ${OPTIONS.inlineChars}`);
});

test('v2 预算 1200 时"被丢掉的报错"摘要必须出现', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `src/mod${i}.ts(${i + 1},7): error TS2322: type mismatch ${i}`);
  lines.push('Found 60 errors.');
  const { out } = run('read', lines.join('\n'));
  const notice = noticeOf(out);
  assert.match(notice, /only in full text/, notice);
  assert.match(notice, /first: /, `1200 预算下摘要不应为空: ${notice}`);
});

test('v2 可恢复性：中段落盘 + 路径进说明 + 同一内容同一路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tto-test-'));
  try {
    const store = createRecoveryStore({ dir });
    const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${'q'.repeat(50)}`).join('\n');
    const first = run('bash', text, { recordOmitted: (omitted) => store.record(omitted) });
    const path = /middle: (\S+)/.exec(first.out)?.[1];
    assert.ok(path !== undefined && existsSync(path), `说明行里应有可读取的路径: ${noticeOf(first.out)}`);
    const saved = readFileSync(path, 'utf8');
    assert.ok(saved.length > 0);
    for (const line of saved.split('\n')) {
      assert.ok(text.includes(line), '落盘内容必须来自原文');
      assert.equal(first.out.includes(line), false, '落盘内容必须是被拿掉的那部分');
    }
    const second = run('bash', text, { recordOmitted: (omitted) => store.record(omitted) });
    assert.equal(/middle: (\S+)/.exec(second.out)?.[1], path, '同一内容必须得到同一路径');
    assert.equal(second.out, first.out, '同一内容必须得到逐字节相同的输出');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v2 幂等：已经是成品的结果一个字节都不动', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i} ${'w'.repeat(50)}`).join('\n');
  const once = run('bash', text);
  const twice = run('bash', once.out);
  assert.equal(twice.changed, false);
  assert.equal(twice.out, once.out);
});

test('v2 代理对：不会切出孤立代理（emoji 原样或带标记）', () => {
  const emojis = '😀🚀🧪🔥';
  const text = `${emojis.repeat(2000)}`;
  const { out } = run('bash', text);
  for (let index = 0; index < out.length; index += 1) {
    const code = out.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = out.charCodeAt(index + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `高位代理后必须跟低位代理（位置 ${index}）`);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = out.charCodeAt(index - 1);
      assert.ok(prev >= 0xd800 && prev <= 0xdbff, `低位代理前必须是高位代理（位置 ${index}）`);
    }
  }
});

test('v2 极小预算不放大、不越界', () => {
  const text = Array.from({ length: 300 }, (_, i) => `row ${i} ${'v'.repeat(40)}`).join('\n');
  for (const budget of [64, 120, 200, 400]) {
    const result = retainMiddle(text, { ...OPTIONS, maxChars: budget });
    if (!result.changed) continue;
    assert.ok(result.text.length <= budget, `${budget}: 输出 ${result.text.length} 越界`);
    assert.ok(result.text.length < text.length);
  }
});
