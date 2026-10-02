/**
 * 硬约束测试：把"极致压缩"必须同时守住的四条底线钉死。
 *
 * 这四条都是**曾经被违反过**的：
 *   1. `maxChars` 是上界，不是软目标（旧实现 17% 的结果超出它，最大 1.31 倍）；
 *   2. 末行（结论/退出状态）永不消失（旧实现 30/677 条丢掉原文最后一行）；
 *   3. 真实失败信号不被漏检（`AssertionError`、`npm ERR!`、`Expected:/received:`、`✗`）；
 *   4. 说明行的数字是真的（`chars + 成品长度 == 原文长度`、行数、`of N`）。
 *
 * 另外覆盖旧测试完全没走到的**退化分支**（预算极小、单行超长）：那里的上界与
 * 行对齐同样必须成立。
 *
 * @module dsh-tool-token-optimizer/test/invariants
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadRows } from '../lib/replay-core.js';
import { optimizeResult } from '../lib/policy.js';
import { importantPriority, isImportantLine, retainMiddle } from '../lib/retain.js';
import { compactText, normalizeNewlines, stripTrailingSpaces } from '../lib/text.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = process.env.DSH_OPTIMIZER_CORPUS ?? join(here, '..', '..', '.corpus', 'raw');
const hasCorpus = existsSync(corpusDir);

/** 与插件默认值一致的策略。 */
const OPTIONS = {
  inlineChars: 1600,
  triggerRatio: 1,
  headRatio: 0.55,
  tailRatio: 0.35,
  minTailChars: 300,
  importantBudgetChars: Math.max(400, Math.floor(1600 * 0.4)),
  toolBudgets: {},
  minBlockChars: 400,
};

/** 文本块拼接（与监听器给出的形状一致）。 */
const joinText = (content) =>
  (content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');

test('失败信号覆盖：驼峰复合词、npm ERR!、断言差异、✗ 清单都不再漏检', () => {
  const failures = [
    'AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:',
    'npm ERR! code ELIFECYCLE',
    'Expected: 5, received: 3',
    '✗ cs:hostInstallInfo\thost=缺失\tpanel=缺失', // ✗ 不是 \w 字符，曾被 \b 断言整个漏掉
    '✘ test/foo.js failed',
    'TypeError: Cannot read properties of undefined',
    'fatal: not a git repository',
    'panic: runtime error: index out of range',
    '[exit code: 143]',
    '[stderr]',
  ];
  for (const line of failures) assert.equal(isImportantLine(line), true, line);
  // 优先级：状态标记 > 报错 > 警告（预算不够时先扔警告）。
  assert.equal(importantPriority('[exit code: 1]'), 3);
  assert.equal(importantPriority('Error: boom'), 2);
  assert.equal(importantPriority('warning: deprecated'), 1);
  assert.equal(importantPriority('const errorRate = 0.1;'), 0);
  assert.equal(importantPriority('deprecation warning: use foo() instead'), 1);
});

test('末行永不消失：即使它自己就超过整个尾部预算', () => {
  const filler = Array.from({ length: 120 }, (_, i) => `line ${i + 1}: routine filler content here`);
  const conclusion = `SUMMARY: FINAL CONCLUSION ${'x'.repeat(860)}`;
  const text = [...filler, conclusion].join('\n');
  const result = retainMiddle(text, { maxChars: 1600, ...OPTIONS });
  assert.equal(result.changed, true);
  assert.ok(result.text.length <= 1600, `必须不超过预算，实际 ${result.text.length}`);
  // 结论行要么整行在，要么以缓存的"可判断前缀"出现（长度不足以放下整行时才截断）。
  assert.ok(
    result.text.includes('SUMMARY: FINAL CONCLUSION'),
    '长结论行的开头（真正携带信息的部分）必须留下',
  );
});

test('单行超长的末行：留下的是这一行的开头，而不是尾部填充', () => {
  const padding = Array.from({ length: 200 }, (_, i) => `row ${i}: ${'p'.repeat(30)}`);
  const huge = `AssertionError: expected 200 to equal 404 :: ${'z'.repeat(2000)}`;
  const result = retainMiddle([...padding, huge].join('\n'), { maxChars: 1600, ...OPTIONS });
  assert.ok(result.changed);
  assert.ok(result.text.length <= 1600);
  assert.ok(result.text.includes('AssertionError: expected 200 to equal 404'), '首行片段必须留下');
});

test('上界是硬的：极小预算与单行超长输入同样不越界', () => {
  const cases = [
    ['多行普通文本', Array.from({ length: 400 }, (_, i) => `row ${i} ${'z'.repeat(40)}`).join('\n')],
    ['单行超长', 'q'.repeat(40000)],
    ['一堆短行', Array.from({ length: 50 }, (_, i) => `short ${i}`).join('\n')],
    ['首行超长', `${'h'.repeat(3000)}\n${Array.from({ length: 60 }, (_, i) => `body ${i}`).join('\n')}`],
  ];
  for (const budget of [64, 200, 400, 800, 1600, 4000]) {
    for (const [label, text] of cases) {
      const result = retainMiddle(text, { maxChars: budget, ...OPTIONS });
      if (!result.changed) continue;
      assert.ok(
        result.text.length <= budget,
        `${label} @ ${budget}: 输出 ${result.text.length} 超过上界`,
      );
    }
  }
});

test('说明行的数字必须自洽：chars + 成品长度 == 原文长度', () => {
  const samples = [
    Array.from({ length: 300 }, (_, i) => `line ${i}: ${'v'.repeat(30)}`).join('\n'),
    `head\n${'m'.repeat(5000)}`,
    `${Array.from({ length: 40 }, (_, i) => `a${i}`).join('\n')}\n${'e'.repeat(3000)}`,
  ];
  for (const text of samples) {
    const result = retainMiddle(text, { maxChars: 900, ...OPTIONS });
    assert.ok(result.changed, '样本应当被裁剪');
    const notice = /\[…\] omitted (\d+) chars \/ (\d+) lines of (\d+)/.exec(result.text);
    assert.ok(notice !== null, '必须有说明行');
    const total = Number(notice[3]);
    assert.equal(total, text.length, '"of N" 必须是原文长度');
    // 口径自洽：说明里的 chars 是从**原文**（of N）减出来的，因此两者相加必须等于 N。
    assert.equal(Number(notice[1]) + result.text.length, total, 'chars 与成品长度必须相加得原文');
  }
});

test('无损层省掉的字符也计入说明行（口径统一到原文）', () => {
  const text = `head\r\n\r\n\r\n\r\n\r\n${'b'.repeat(4000)}`;
  const result = retainMiddle(text, { maxChars: 1200, ...OPTIONS, originalChars: text.length });
  assert.ok(result.changed);
  const notice = /\[…\] omitted (\d+) chars \/ (\d+) lines of (\d+)/.exec(result.text);
  assert.equal(Number(notice[3]), text.length, '"of N" 必须报无损层之前的原文长度');
  // 无损层折掉的部分，由 of N 与"说明行 + 成品长度"之差体现，两个方向都不许失真。
  const accounted = Number(notice[1]) + result.text.length;
  assert.ok(accounted <= text.length, `不得高报：${accounted} > ${text.length}`);
  assert.ok(
    text.length - accounted <= 8,
    `低报不得超过无损层实际收益：差 ${text.length - accounted} 字符`,
  );
});

test('行号单调：保留的行按原文顺序出现，不出现 121 行排在 55 行之前', () => {
  const lines = [];
  for (let i = 1; i <= 300; i += 1) {
    if (i === 20) lines.push(`${i}: throw new Error("boom")`);
    else if (i === 45) lines.push(`${i}:   } catch (error) {`);
    else lines.push(`${i}: const value${i} = compute(${i});`);
  }
  const text = `<path>/tmp/demo.js</path>\n<type>file</type>\n<content>\n${lines.join('\n')}\n</content>`;
  const result = optimizeResult({ tool: 'read', content: [{ type: 'text', text }], isError: false }, OPTIONS);
  const out = joinText(result.content);
  const numbers = (out.match(/^\s*(\d+): /gm) ?? []).map((entry) => Number(entry.trim().split(':')[0]));
  assert.ok(numbers.length > 5, '应当保留若干行号行');
  for (let i = 1; i < numbers.length; i += 1) {
    assert.ok(numbers[i - 1] <= numbers[i], `行号必须单调：${numbers.join(',')}`);
  }
});

test('真实语料：每一个块都不超过 inlineChars（上界是硬的）', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let trimmed = 0;
  let worst = 0;
  let worstTool = '';
  for (const row of rows) {
    if (row.isError || row.text.length === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    if (!result.steps.includes('retain-middle')) continue;
    trimmed += 1;
    for (const block of result.content) {
      if (block?.type !== 'text') continue;
      if (block.text.length > worst) {
        worst = block.text.length;
        worstTool = row.tool;
      }
      assert.ok(
        block.text.length <= OPTIONS.inlineChars,
        `${row.tool}: 文本块 ${block.text.length} 超过 ${OPTIONS.inlineChars}`,
      );
    }
  }
  assert.ok(trimmed > 300, `应有大量被裁剪样本，实际 ${trimmed}`);
  console.log(`    blocks within inlineChars: ${trimmed} trimmed results (worst ${worst} via ${worstTool})`);
});

test('真实语料：原文首行与末行在成品里仍可定位（结论与格式不消失）', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  let missingLast = 0;
  let missingFirst = 0;
  for (const row of rows) {
    if (row.isError || row.text.length === 0 || !row.text.includes('\n')) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    if (!result.steps.includes('retain-middle')) continue;
    checked += 1;
    const lossless = compactText(row.text, { enableJsonBreak: false });
    const original = lossless.changed ? lossless.text : stripTrailingSpaces(normalizeNewlines(row.text));
    const after = joinText(result.content);
    const first = original.split('\n')[0];
    const last = original.split('\n').at(-1);
    // 允许"预算裁剪后的前缀"出现（首行/末行自己超过预算时的既定退化）。
    if (first.length > 0 && !after.includes(first) && !after.includes(first.slice(0, 40))) missingFirst += 1;
    if (last.length > 0 && !after.includes(last) && !after.includes(last.slice(0, 40))) missingLast += 1;
  }
  assert.ok(checked > 300, `应有大量被裁剪样本，实际 ${checked}`);
  assert.equal(missingLast, 0, `有 ${missingLast} 条结果的结论行（末行）不可定位`);
  assert.equal(missingFirst, 0, `有 ${missingFirst} 条结果的格式行（首行）不可定位`);
});

test('真实语料：可疑行优先于普通行，警告先于报错被放弃', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  let priorityRespected = 0;
  for (const row of rows) {
    if (row.isError || row.text.length === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    if (!result.steps.includes('retain-middle')) continue;
    const after = joinText(result.content);
    const lines = after.split('\n');
    const at = lines.findIndex((line) => line.includes('[…] omitted'));
    if (at <= 0) continue;
    // 说明行之前的内容 = 头部 + 保留下来的可疑行。其中不能出现 priority 0 的行被
    // 当作"可疑行"塞进来的情况（那说明取舍逻辑把普通行也算进了配额）。
    const retained = lines.slice(0, at);
    const suspicious = retained.filter((line) => importantPriority(line) > 0);
    if (suspicious.length === 0) continue;
    checked += 1;
    // 保留下来的可疑行里，优先级 3/2 的数量不得少于优先级 1（先扔警告）。
    const high = suspicious.filter((line) => importantPriority(line) >= 2).length;
    const low = suspicious.filter((line) => importantPriority(line) === 1).length;
    if (high >= low) priorityRespected += 1;
  }
  if (checked > 0) {
    assert.ok(
      priorityRespected >= Math.ceil(checked * 0.9),
      `${checked} 条里只有 ${priorityRespected} 条满足"报错优先于警告"`,
    );
  }
  console.log(`    important-line priority checked: ${checked} results`);
});
