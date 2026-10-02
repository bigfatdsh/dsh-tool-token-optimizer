/**
 * 真实语料不变量测试：把 DSH 历史上真实产生过的 2000+ 条工具结果逐条跑一遍，
 * 证明压缩策略在**真实数据**上也不丢结构、不丢报错、不丢可恢复路径。
 *
 * 语料目录默认取仓库内的 `.corpus/raw`（由 `tools/extract-corpus.mjs` 从本机会话
 * 日志解压得到）。目录不存在时整组测试跳过——它验证的是真实数据，不参与 CI 门禁。
 *
 * @module dsh-tool-token-optimizer/test/corpus
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadRows } from '../lib/replay-core.js';
import { estimateContent } from '../lib/tokens.js';
import { optimizeResult } from '../lib/policy.js';
import { findRecoveryPath, isImportantLine } from '../lib/retain.js';
import { compactText, decodeText, normalizeNewlines, stripTrailingSpaces } from '../lib/text.js';

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

/**
 * 统计可疑行（按行内容去重）。
 *
 * 先把文本归一到“无损变换之后”的形态（CRLF→LF、行尾空白删除），这样比较的是
 * **信息**而不是排版：插件本来就保证这一层等价，测试再比一遍没有意义。
 */
function importantLines(text) {
  const lines = new Set();
  for (const line of stripTrailingSpaces(normalizeNewlines(text)).split('\n')) {
    if (isImportantLine(line)) lines.add(line);
  }
  return lines;
}

/** 文本块拼接。 */
const joinText = (content) =>
  (content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');

test('真实语料：无损层可精确还原（逐条解码比对）', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  let exact = 0;
  for (const row of rows) {
    if (row.isError || row.text.length === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    // 只看“纯无损”的结果：发生预算裁剪的结果，中段本来就靠取回路径，不在此列。
    if (!result.changed || result.steps.includes('retain-middle')) continue;
    const decoded = result.content
      .filter((block) => block?.type === 'text')
      .map((block) => decodeText(block.text))
      .join('\n');
    const original = stripTrailingSpaces(normalizeNewlines(row.text));
    assert.equal(decoded, original, `${row.tool}: 无损层必须可精确还原`);
    checked += 1;
    exact += decoded === original ? 1 : 0;
  }
  assert.ok(checked > 30, `应有足够多的纯无损样本，实际 ${checked}`);
  console.log(`    lossless results decoded back exactly: ${exact}/${checked}`);
});

test('真实语料：结果永不放大、块结构永不改变', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  assert.ok(rows.length > 1000, `语料应有上千条结果，实际 ${rows.length}`);
  let optimized = 0;
  let savedTokens = 0;
  let beforeTokens = 0;
  for (const row of rows) {
    beforeTokens += estimateContent(row.content);
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    assert.ok(
      estimateContent(result.content) <= estimateContent(row.content),
      `${row.tool}: 压缩后不得变大`,
    );
    assert.equal(result.content.length, row.content.length, `${row.tool}: 块数量不得变化`);
    for (const [index, block] of result.content.entries()) {
      assert.equal(block.type, row.content[index].type, `${row.tool}: 块类型与顺序不得变化`);
    }
    if (result.changed) {
      optimized += 1;
      savedTokens += result.savedTokens;
    }
  }
  assert.ok(optimized > 100, `应有大量结果被压缩，实际 ${optimized}`);
  // 记录到测试输出，便于人工核对省量（不是断言，避免把测量阈值写死）。
  console.log(
    `    corpus: ${rows.length} results, ${optimized} optimized, ` +
      `${beforeTokens} -> ${beforeTokens - savedTokens} tok (${((100 * savedTokens) / beforeTokens).toFixed(1)}% saved)`,
  );
});

test('真实语料：read 结果要么逐字节不变，要么可精确还原，且续读 footer 永不丢', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir).filter((row) => row.tool === 'read' && row.text.includes('<path>') && !row.isError);
  assert.ok(rows.length > 100, `应有足够多的 read 样本，实际 ${rows.length}`);
  let identical = 0;
  let reversible = 0;
  let elided = 0;
  for (const row of rows) {
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const after = result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
    // 1) 永不放大
    assert.ok(after.length <= row.text.length, 'read 结果不得变大');
    if (result.steps.includes('retain-middle')) {
      elided += 1;
      // 2) 被裁剪时：信封与续读 footer 必须在（模型据此决定下一段从哪读）
      assert.equal(after.includes('<path>'), true, '丢失 <path>');
      assert.equal(after.includes('</content>'), true, '丢失 </content>');
      const footer = /\((?:Showing lines|Output capped|End of file)[^)]*\)/.exec(row.text);
      if (footer !== null) assert.equal(after.includes(footer[0]), true, `丢失续读 footer: ${footer[0]}`);
      assert.match(after, /\[…\] omitted \d+ chars/, '必须写明省略量');
    } else if (after === row.text) {
      identical += 1;
    } else {
      // 3) 未裁剪但被无损层规范化（行尾空白/空行）：必须能精确还原
      const decoded = result.content
        .filter((block) => block?.type === 'text')
        .map((block) => decodeText(block.text))
        .join('\n');
      assert.equal(decoded, stripTrailingSpaces(normalizeNewlines(row.text)), '无损层必须可精确还原');
      reversible += 1;
    }
  }
  console.log(`    read results: ${identical} identical, ${reversible} exactly reversible, ${elided} elided (footer kept)`);
});

test('真实语料：被裁剪的结果绝不切进行中间（保留部分都是完整行）', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  let hardCut = 0;
  let clippedLines = 0;
  for (const row of rows) {
    if (row.isError || row.text.length === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    if (!result.steps.includes('retain-middle')) continue;
    checked += 1;
    const out = result.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
    const lines = out.split('\n');
    const at = lines.findIndex((line) => line.includes('[…] omitted'));
    assert.ok(at > 0, `${row.tool}: 必须有说明行`);
    // 头部末行与尾部首行都必须是原文里逐字存在的完整行。
    //
    // 允许的例外只有两种，且都必须是**被明确标注**的退化：
    //   a) 整个结果没有行结构（单行块）——没有"完整行"可言；
    //   b) 那一行**自己就超过给它分配的预算**，此时按字符截断并在行尾留下
    //      `…[line clipped]` 标记。绝不静默地把一行切一半。
    const headLine = lines[at - 1];
    const tailLine = at + 1 < lines.length ? lines[at + 1] : null;
    const singleLineBlock = !row.text.includes('\n');
    if (singleLineBlock) {
      hardCut += 1;
      continue;
    }
    // 比较基准 = **仅施加无损层之后**的文本：无损层会引入 `⟨dup ×N⟩` 这类自己的标记，
    // 也会把裸 `\r`（终端覆盖写）规范化，拿原始字节比对必然误报。
    const lossless = compactText(row.text, { enableJsonBreak: false });
    const normalizedOriginal = lossless.changed ? lossless.text : stripTrailingSpaces(normalizeNewlines(row.text));
    const clippedHead = headLine.includes('[line clipped]');
    if (clippedHead) clippedLines += 1;
    assert.equal(
      clippedHead || normalizedOriginal.includes(stripTrailingSpaces(normalizeNewlines(headLine))),
      true,
      `${row.tool}: 头部末行被切半且没有截断标记: ${JSON.stringify(headLine.slice(0, 60))}`,
    );
    if (tailLine !== null && tailLine.length > 0) {
      const clippedTail = tailLine.includes('[line clipped]');
      if (clippedTail) clippedLines += 1;
      assert.equal(
        clippedTail || normalizedOriginal.includes(stripTrailingSpaces(normalizeNewlines(tailLine))),
        true,
        `${row.tool}: 尾部首行被切半: ${JSON.stringify(tailLine.slice(0, 60))}`,
      );
    }
  }
  assert.ok(checked > 300, `应有大量被裁剪样本，实际 ${checked}`);
  console.log(
    `    elided results checked for line integrity: ${checked} ` +
      `(single-line blocks exempt: ${hardCut}, budget-clipped first/last lines: ${clippedLines})`,
  );
});

test('真实语料：图片等富内容块逐字节保留', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  for (const row of rows) {
    const rich = row.content.filter((block) => block.type !== 'text');
    if (rich.length === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const richAfter = result.content.filter((block) => block.type !== 'text');
    assert.deepEqual(richAfter, rich, `${row.tool}: 富内容块必须原样保留`);
    checked += 1;
  }
  console.log(`    rich-content results checked: ${checked}`);
});

test('真实语料：失败结果逐字节不变', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  const failures = rows.filter((row) => row.isError);
  assert.ok(failures.length > 0, '语料里应含失败结果');
  for (const row of failures) {
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: true }, OPTIONS);
    assert.equal(result.changed, false, `${row.tool}: 失败结果不得被改动`);
    assert.deepEqual(result.content, row.content);
  }
  console.log(`    failures checked: ${failures.length}`);
});

test('真实语料：DSH 自己的可恢复路径必须保留', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  for (const row of rows) {
    const path = findRecoveryPath(row.text);
    if (path === null) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const after = joinText(result.content);
    assert.equal(after.includes(path), true, `${row.tool}: 可恢复路径被切掉了: ${path}`);
    checked += 1;
  }
  console.log(`    recovery paths checked: ${checked}`);
});

test('真实语料：可疑行要么原样保留，要么被精确计数说明', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let checked = 0;
  let droppedLines = 0;
  let worst = { tool: '', dropped: 0, chars: 0 };
  for (const row of rows) {
    if (row.isError || row.text.length === 0) continue;
    const before = importantLines(row.text);
    if (before.size === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const afterText = joinText(result.content);
    const afterLines = importantLines(afterText);
    // 只比较“这条可疑行还在不在”，不比较出现次数：连续重复行折叠会把 N 次
    // 压成「首行 + ×N」，内容仍在，次数由标记写回。
    let missing = 0;
    for (const line of before) {
      if (!afterLines.has(line)) missing += 1;
    }
    checked += 1;
    if (missing === 0) continue;
    // 有可疑行没进内联文本时，结果**必须**带省略说明，且说明里的省略量必须
    // 足以涵盖这些行——说明行是模型判断“还要不要取回”的唯一依据。
    const notice = /\[…\] omitted (\d+) chars \/ (\d+) lines of (\d+)/.exec(afterText);
    assert.ok(notice !== null, `${row.tool}: 丢了可疑行却没有省略说明`);
    // 允许 2 行的记账误差：中段是按字符切的，边缘那一行可能只被切掉一半，
    // 因此“说明里的省略行数”与“整行消失的行数”最多差一个边界行。
    assert.ok(
      Number(notice[2]) >= missing - 2,
      `${row.tool}: 说明只写了 ${notice[2]} 行，却丢了 ${missing} 行可疑行`,
    );
    assert.match(afterText, /(?:re-run|re-read|narrow|fetch|query|repeat|re-load|full text:)/, '必须给出取回路径');
    droppedLines += missing;
    if (missing > worst.dropped) worst = { tool: row.tool, dropped: missing, chars: row.chars };
  }
  console.log(
    `    results with error/warning lines: ${checked}, lines not kept inline: ${droppedLines} ` +
      `(worst: ${worst.tool} ${worst.dropped} lines of a ${worst.chars}-char result)`,
  );
});

test('真实语料：DSH 的结构标记行（[stderr]/[exit code: N]/截断提示）必须保留', { skip: !hasCorpus && '语料不存在' }, () => {
  const MARKER = /^\[(?:stderr|exit code|timed out|killed by signal|stopped|result truncated|output truncated|some output was dropped)[^\]]*\]$/;
  const rows = loadRows(corpusDir);
  let checked = 0;
  let kept = 0;
  let lost = 0;
  for (const row of rows) {
    if (row.isError || row.text.length === 0) continue;
    const markers = new Set(row.text.split('\n').filter((line) => MARKER.test(line)));
    if (markers.size === 0) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const after = joinText(result.content);
    for (const marker of markers) {
      checked += 1;
      if (after.includes(marker)) kept += 1;
      else {
        lost += 1;
        assert.fail(`${row.tool}: 结构标记被丢了: ${JSON.stringify(marker)}`);
      }
    }
  }
  console.log(`    structural markers checked: ${checked} (kept ${kept}, lost ${lost})`);
});

test('真实语料：read 的结构（path/type/content/footer）必须保留', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir).filter((row) => row.tool === 'read' && row.text.includes('<path>'));
  assert.ok(rows.length > 0, '语料里应有 read 结果');
  for (const row of rows) {
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const after = joinText(result.content);
    const path = /<path>[\s\S]*?<\/path>/.exec(row.text)[0];
    assert.equal(after.includes(path), true, 'read 的 <path> 必须保留');
    assert.equal(after.includes('<type>file</type>'), true);
    assert.equal(after.includes('<content>'), true);
    assert.equal(after.includes('</content>'), true);
    const footer = /\((?:Showing lines|Output capped|End of file)[^)]*\)/.exec(row.text);
    if (footer !== null) {
      assert.equal(after.includes(footer[0]), true, `read 的续读 footer 必须保留: ${footer[0]}`);
    }
  }
  console.log(`    read envelopes checked: ${rows.length}`);
});

test('真实语料：grep 的头部与文件路径必须保留', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir).filter((row) => row.tool === 'grep' && /^Found \d+/.test(row.text));
  for (const row of rows) {
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    const after = joinText(result.content);
    const header = row.text.split('\n')[0];
    assert.equal(after.includes(header), true, 'grep 的匹配计数头部必须保留');
    for (const path of new Set(row.text.split('\n').filter((line) => line.startsWith('/') || line.startsWith('./')))) {
      assert.equal(after.includes(path), true, `grep 的文件头必须保留: ${path}`);
    }
  }
  console.log(`    grep results checked: ${rows.length}`);
});

test('真实语料：被裁剪的结果必须给出取回提示', { skip: !hasCorpus && '语料不存在' }, () => {
  const rows = loadRows(corpusDir);
  let retained = 0;
  for (const row of rows) {
    if (row.isError) continue;
    const result = optimizeResult({ tool: row.tool, content: row.content, isError: row.isError }, OPTIONS);
    if (!result.steps.includes('retain-middle')) continue;
    const after = joinText(result.content);
    assert.equal(after.includes('[…] omitted'), true, '必须写明省略量');
    assert.match(after, /(?:re-run|re-read|narrow|fetch|query|repeat|re-load|full text:)/, '必须给出取回路径');
    retained += 1;
  }
  assert.ok(retained > 50, `应有大量结果被裁剪，实际 ${retained}`);
  console.log(`    retained results checked: ${retained}`);
});
