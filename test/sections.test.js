/**
 * 结构感知切分测试：证明「按结果自身的边界切」这条性质可被检验。
 *
 * 最关键的一条不变量：**被保留的文本永远是完整行的拼接**——除了"单行本身就超预算"
 * 这种没有行结构可言的机器输出，任何情况下都不把一行劈成两半。
 *
 * @module dsh-tool-token-optimizer/test/sections
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { pickSections, refineUnits, sectionsOf } from '../lib/sections.js';
import { optimizeResult } from '../lib/policy.js';

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

const bigText = (label, lines) =>
  Array.from({ length: lines }, (_, index) => `${label} line ${index} ${'x'.repeat(50)}`).join('\n');

test('bash 结果按 [stderr] 与状态标记分节', () => {
  const text = [
    ...Array.from({ length: 60 }, (_, index) => `stdout ${index}`),
    '[stderr]',
    ...Array.from({ length: 40 }, (_, index) => `stderr ${index}`),
    '[exit code: 1]',
  ].join('\n');
  const { units, kind } = sectionsOf(text, 'bash', 200);
  assert.equal(kind, 'shell');
  const texts = units.map((unit) => unit.text);
  assert.ok(texts.includes('[stderr]'), '[stderr] 必须是独立单元');
  assert.ok(texts.includes('[exit code: 1]'), '状态标记必须是独立单元');
  assert.equal(units.find((unit) => unit.text === '[exit code: 1]').priority >= 2, true, '状态标记优先级最高');
});

test('grep 结果按文件分组切分，头部与取回提示是独立单元', () => {
  const text = [
    'Found 3 of 9 matches',
    '',
    '/a/b.js\nLine 12: const x = 1',
    '',
    '/c/d.js\nLine 3: const y = 2',
    '',
    '(Full grep result stored at: /tmp/spill/grep.txt. Use read with offset/limit.)',
  ].join('\n');
  const { units, kind } = sectionsOf(text, 'grep', 100);
  assert.equal(kind, 'grep-groups');
  assert.equal(units[0].text, 'Found 3 of 9 matches');
  assert.ok(units.some((unit) => unit.text.includes('/a/b.js')));
  assert.ok(units.some((unit) => unit.text.includes('Full grep result stored at')));
  assert.equal(units.at(-1).priority >= 2, true, '取回提示必须高优先级');
});

test('没有结构的结果退化为按行切', () => {
  const { units, kind } = sectionsOf('a\nb\nc', 'weird_tool', 400);
  assert.equal(kind, 'lines');
  assert.deepEqual(units.map((unit) => unit.text), ['a', 'b', 'c']);
});

test('refineUnits 只在行边界断开（单行超长是唯一例外）', () => {
  const text = Array.from({ length: 40 }, (_, index) => `row ${index} ${'-'.repeat(30)}`).join('\n');
  const refined = refineUnits([{ text, priority: 0 }], 100);
  assert.ok(refined.length > 1, '应当被切成多个单元');
  for (const unit of refined) {
    assert.equal(unit.text.includes('\n') && !text.includes(unit.text) ? false : true, true);
    // 每个单元都必须是原文里**逐字存在**的片段（不会出现半行拼接的假文本）
    assert.equal(text.includes(unit.text), true, `单元必须是原文的连续片段: ${JSON.stringify(unit.text.slice(0, 40))}`);
  }
  const joined = refined.map((unit) => unit.text).join('\n');
  assert.equal(joined, text, '单元顺序拼接必须还原原文');

  // 单行超长：允许硬切，但拼接后仍等于原文
  const oneLine = 'z'.repeat(5000);
  const hard = refineUnits([{ text: oneLine, priority: 0 }], 400);
  assert.equal(hard.map((unit) => unit.text).join(''), oneLine);
});

test('pickSections 只取整单元，且省略集合与实际未保留的单元一致', () => {
  const text = bigText('body', 300);
  const { units } = sectionsOf(text, 'bash', 200);
  const picked = pickSections(units, 1200, { headRatio: 0.55, tailRatio: 0.35 });
  const kept = new Set([
    ...Array.from({ length: picked.headUnits }, (_, index) => units[index].text),
    ...units.filter((unit, index) => index >= picked.headUnits && !picked.omittedUnitsList.includes(unit)).map((u) => u.text),
  ]);
  assert.ok(picked.head.length > 0 && picked.tail.length > 0);
  // 省略统计必须等于"未被保留单元"的字符数
  const omittedChars = picked.omittedUnitsList.reduce((sum, unit) => sum + unit.text.length + 1, 0);
  assert.equal(picked.omittedChars, omittedChars);
  assert.equal(picked.omittedUnits, picked.omittedUnitsList.length);
  assert.ok(kept.size > 0);
});

test('端到端不变量：被裁剪的结果里，保留部分永远是完整行', () => {
  const fixtures = [
    bigText('plain', 400),
    `${bigText('out', 300)}\n[stderr]\n${bigText('err', 200)}\n[exit code: 2]`,
    // grep 夹具要足够大才会触发裁剪（1600 字符预算）
    'Found 200 of 200 matches\n\n' +
      Array.from({ length: 200 }, (_, index) => `/f${index}.js\nLine ${index}: const hit${index} = ${index}`).join('\n\n'),
  ];
  for (const [index, text] of fixtures.entries()) {
    const tool = index === 1 ? 'bash' : index === 2 ? 'grep' : 'other';
    const result = optimizeResult({ tool, content: [{ type: 'text', text }], isError: false }, OPTIONS);
    assert.equal(result.changed, true);
    const out = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const noticeAt = out.split('\n').findIndex((line) => line.includes('[…] omitted'));
    assert.ok(noticeAt > 0, '必须有说明行');
    const lines = out.split('\n');
    // 头部最后一行、尾部第一行都必须是原文里存在的完整行
    assert.equal(text.includes(lines[noticeAt - 1]), true, `头部末行不是完整原文行: ${lines[noticeAt - 1]}`);
    if (noticeAt + 1 < lines.length) {
      assert.equal(text.includes(lines[noticeAt + 1]), true, `尾部首行不是完整原文行: ${lines[noticeAt + 1]}`);
    }
  }
});

test('被裁剪的结果永不放大，且说明里的省略量为正', () => {
  const text = bigText('x', 500);
  const result = optimizeResult({ tool: 'bash', content: [{ type: 'text', text }], isError: false }, OPTIONS);
  const out = result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  assert.ok(out.length < text.length);
  const notice = /\[…\] omitted (\d+) chars \/ (\d+) lines of (\d+)/.exec(out);
  assert.ok(notice !== null);
  assert.ok(Number(notice[1]) > 0);
  assert.equal(Number(notice[3]), text.length);
});
