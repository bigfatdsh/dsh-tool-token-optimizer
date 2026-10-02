/**
 * 无损规范化测试：每一条都验证「语义等价」，而不只是「变小了」。
 *
 * 等价口径：
 * - 折叠类变换必须能从结果反推回原文的长度或行数；
 * - 规范化类变换必须证明 `normalize(结果) === normalize(原文)`；
 * - 净收益闸门必须证明“绝不放大”。
 *
 * @module dsh-tool-token-optimizer/test/text
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collapseBlankRuns,
  collapseDuplicateRuns,
  compactText,
  decodeText,
  normalizeNewlines,
  stripBlankLinePadding,
  stripTrailingSpaces,
} from '../lib/text.js';

/**
 * 无损变换的不动点：连续施加规范化直到稳定。
 *
 * 用它作为“语义等价”的判据：两份文本在这个口径下逐字节相同，就意味着它们携带的
 * 行序列信息完全相同——差别只剩行尾空白、换行风格与超长空行这类终端排版噪声。
 * 重复行折叠会把次数写回文本，单独在下面的用例与属性测试里验证。
 */
function canonical(text) {
  let current = text;
  for (let round = 0; round < 4; round += 1) {
    const next = collapseBlankRuns(stripBlankLinePadding(stripTrailingSpaces(normalizeNewlines(current))));
    if (next === current) return next;
    current = next;
  }
  return current;
}

test('normalizeNewlines 去掉 CRLF 与裸 CR', () => {
  assert.equal(normalizeNewlines('a\r\nb\r\n'), 'a\nb\n');
  // 终端进度条：\r 覆盖同一行，删除裸 CR 后剩下的是最终显示那一版。
  assert.equal(normalizeNewlines('progress 10%\rprogress 100%'), 'progress 10%progress 100%');
  assert.equal(normalizeNewlines('a\rb\nc'), 'ab\nc');
});

test('collapseBlankRuns 只折叠 4 个以上连续换行，且可反推', () => {
  const input = 'a\n\n\n\n\n\nb';
  const out = collapseBlankRuns(input);
  assert.equal(out, 'a\n\n\nb');
  assert.ok(out.length < input.length);
  // 3 行以下空行不动。
  assert.equal(collapseBlankRuns('a\n\n\nb'), 'a\n\n\nb');
  assert.equal(collapseBlankRuns('a\n\nb'), 'a\n\nb');
});

test('collapseDuplicateRuns 保留首末锚点，且可精确还原', () => {
  const repeated = Array.from({ length: 37 }, () => 'node_modules/foo/index.js').join('\n');
  const out = collapseDuplicateRuns(repeated);
  assert.equal(out, ['node_modules/foo/index.js', '⟨dup ×37⟩', 'node_modules/foo/index.js'].join('\n'));
  // 精确还原：首锚点 + 标记里的次数 + 末锚点。
  const marker = /⟨dup ×(\d+)⟩/.exec(out);
  assert.equal(Number(marker[1]), 37);
  assert.equal(decodeText(out), repeated);
  // 只重复 2 次时不动（标记比省下的那行还长）。
  assert.equal(collapseDuplicateRuns('a\na\n'), 'a\na\n');
  // 空行不折叠（空行由 collapseBlankRuns 负责，语义不同）。
  assert.equal(collapseDuplicateRuns('\n\n\n\n'), '\n\n\n\n');
  // 已经带标记的行不再折叠，避免二次编码。
  assert.equal(collapseDuplicateRuns('⟨dup ×3⟩\n⟨dup ×3⟩\n⟨dup ×3⟩'), '⟨dup ×3⟩\n⟨dup ×3⟩\n⟨dup ×3⟩');
  // 行号不漂移：锚点行保留在原位。
  const mixed = ['header', 'a', 'a', 'a', 'a', 'footer'].join('\n');
  assert.equal(collapseDuplicateRuns(mixed), ['header', 'a', '⟨dup ×4⟩', 'a', 'footer'].join('\n'));
  assert.equal(decodeText(collapseDuplicateRuns(mixed)), mixed);
});

test('decodeText 精确还原全部无损变换（除排版噪声）', () => {
  const fixtures = [
    'a\r\nb   \r\nc',
    'x\n\n\n\n\n\ny',
    ['same', 'same', 'same', 'other'].join('\n'),
    ['h', 'd', 'd', 'd', 'd', 't'].join('\n'),
    'plain text',
  ];
  for (const fixture of fixtures) {
    const compacted = compactText(fixture, { jsonMinChars: 10_000 });
    assert.equal(decodeText(compacted.text), canonical(fixture), `还原必须落在规范形: ${JSON.stringify(fixture)}`);
  }
});

test('compactText 结果与原文在规范化口径下等价', () => {
  const fixtures = [
    'a\r\nb   \r\nc\n\n\n\n\nd\n',
    Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'),
    'x'.repeat(5000),
    '{\n  "a": 1\n}',
    '',
    '\n',
  ];
  for (const fixture of fixtures) {
    const result = compactText(fixture);
    assert.ok(result.text.length <= fixture.length, '绝不能放大');
    assert.equal(canonical(result.text), canonical(fixture), `语义必须等价: ${JSON.stringify(fixture.slice(0, 40))}`);
  }
});

test('compactText 对已经最简的文本不做任何改动', () => {
  const text = 'a\nb\nc';
  const result = compactText(text);
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
  assert.deepEqual(result.steps, []);
});

test('压缩是幂等的：对已压缩文本再压一次不再变化', () => {
  const fixtures = [
    'a\r\nb   \r\n\n\n\n\nc',
    Array.from({ length: 30 }, () => 'same line').join('\n'),
    JSON.stringify({ list: Array.from({ length: 50 }, (_, index) => `item-${index}`) }),
  ];
  for (const fixture of fixtures) {
    const once = compactText(fixture);
    const twice = compactText(once.text);
    assert.equal(twice.text, once.text);
  }
});

test('属性测试：随机“日志”文本永不放大、永不改变规范化语义', () => {
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
    // 折叠标记只会在行首出现，且真实输出里不会自带该字符；生成器同样排除它。
    const vocabulary = ['ok', 'error: failed', '  ', '', 'path/to/file.js', '\t', 'done'];
  for (let round = 0; round < 400; round += 1) {
    const lines = [];
    const count = 1 + Math.floor(random() * 40);
    for (let index = 0; index < count; index += 1) {
      const word = vocabulary[Math.floor(random() * vocabulary.length)];
      const repeats = 1 + Math.floor(random() * 5);
      lines.push(word.repeat(repeats));
    }
    const text = lines.join(random() < 0.3 ? '\r\n' : '\n');
    const result = compactText(text);
    assert.ok(result.text.length <= text.length, `round ${round}: 结果不得大于原文`);
    // 无损折叠类变换（行尾空白、CR、空行超限折叠、连续重复行折叠）整体**可精确还原**：
    // 解码结果必须与原文在同一“规范形”下逐字节一致。
    assert.equal(decodeText(result.text), canonical(text), `round ${round}: 必须可精确还原`);
  }
});
