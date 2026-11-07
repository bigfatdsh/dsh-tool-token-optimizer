/**
 * v1.0.15 新增行为的回归测试：行号区间、单行大结果的尾部、词边界裁剪、
 * 空行号不占尾部、预算填充、spill 路径识别。
 *
 * 这些用例描述的是**可由模型核对**的性质，而不是实现细节：
 * 说明行里必须给得出"哪几行被省略"，成品必须用满预算，尾部必须存在。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { optimizeResult } from '../lib/policy.js';
import { findRecoveryPath, retainMiddle } from '../lib/retain.js';

const OPTIONS = {
  inlineChars: 1200,
  triggerRatio: 1,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: 480,
  toolBudgets: {},
  minBlockChars: 400,
};

const optimize = (tool, text) => {
  const result = optimizeResult({ tool, content: [{ type: 'text', text }], isError: false }, OPTIONS);
  return { ...result, out: result.content.map((block) => block.text ?? '').join('') };
};

test('read 结果的说明行给出文件行号区间，而不是只给行数', () => {
  const lines = ['<path>/tmp/demo.js</path>', '<content>'];
  for (let index = 1; index <= 120; index += 1) lines.push(`${index}: const value${index} = compute(${index});`);
  lines.push('(End of file - total 120 lines)', '</content>');
  const { out } = optimize('read', lines.join('\n'));
  assert.match(out, /file lines \d+-\d+/, `说明行里必须出现文件行号区间：${out.slice(-200)}`);
});

test('单行（minified）大结果不会退化成"只有头部"：尾部必须存在', () => {
  const payload = JSON.stringify(
    Array.from({ length: 80 }, (_, index) => ({ index, name: `item-${index}`, value: 'x'.repeat(20) })),
  );
  assert.ok(payload.length > 2000 && !payload.includes('\n'));
  const { out } = optimize('mcp__demo__search', payload);
  assert.ok(out.length >= OPTIONS.inlineChars * 0.75, `成品应贴住预算，实际 ${out.length}`);
  assert.ok(out.trimEnd().endsWith('}]'), `结果的结尾必须保留，实际结尾：${out.slice(-60)}`);
});

test('超长行在词边界收刀，不制造半个标识符', () => {
  const text = Array.from({ length: 60 }, () => 'word '.repeat(12).trim()).join('\n');
  const result = retainMiddle(`${'alpha '.repeat(400)}\n${text}`, {
    ...OPTIONS,
    maxChars: 700,
    tool: 'bash',
  });
  const clipped = /(\S+) …\[line clipped\]/.exec(result.text);
  if (clipped !== null) {
    assert.match(clipped[1], /^[\w.'"`/-]+$/, `截断点应落在词边界：${clipped[1]}`);
  }
});

test('只有行号的空行（`44:`）不占用尾部预算', () => {
  const lines = ['<path>/tmp/demo.js</path>', '<content>'];
  for (let index = 1; index <= 60; index += 1) {
    if (index >= 50 && index <= 58) lines.push(`${index}:`);
    else lines.push(`${index}: const row${index} = ${index};`);
  }
  lines.push('(End of file - total 60 lines)', '</content>');
  const { out } = optimize('read', lines.join('\n'));
  const tail = out.slice(-400);
  assert.doesNotMatch(tail, /^5\d:\s*$/m, `尾部不应只剩空行号：${tail}`);
});

test('预算填充：成品贴近内联预算，而不是只用一半', () => {
  const text = Array.from({ length: 200 }, (_, index) => `line ${index} ${'v'.repeat(24)}`).join('\n');
  const { out } = optimize('bash', text);
  assert.ok(out.length >= OPTIONS.inlineChars * 0.8, `应使用 ≥80% 预算，实际 ${out.length}/${OPTIONS.inlineChars}`);
  assert.ok(out.length <= OPTIONS.inlineChars, `不得超过预算，实际 ${out.length}`);
});

test('findRecoveryPath 认识 dsh-exec-optimizer 的 spill 路径', () => {
  const text = '[... 1234 chars omitted by dsh-exec-optimizer (kept 500 head + 300 tail).\n\nFull text: /tmp/spill/abc.txt — read it with offset/limit]';
  assert.equal(findRecoveryPath(text), '/tmp/spill/abc.txt');
});
