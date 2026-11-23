/**
 * 结构单元：把一条工具结果切成「行边界上」的单元，供裁剪器取舍。
 *
 * v2 的三条改动：
 * 1. **单元自带行号跨度**（`line` / `lines`）——上下文的说明行、省略区间、
 *    行数统计都从同一份数据来，不会互相打架，也不需要再对全文做 `indexOf` 反查
 *    （旧实现的 `locateUnitSpans` 在最坏情况下是 O(n²)）。
 * 2. **长单行不再被切成"伪行"**：旧实现把 200k 的单行 SQL 切成 500 个 400 字的
 *    片段再当独立行交付，模型会把片段当完整行。现在整行是一个单元，需要截断时
 *    由 `clip.js` 带 `⟨…⟩` 标记地切头/切尾。
 * 3. 结构识别（`[stderr]`、`[exit code]`、grep 分组、read 的 `<path>`）保持不变。
 *
 * @module dsh-tool-token-optimizer/sections
 */

import { clipBoth, clipHead, clipTail } from './clip.js';

/** 这些工具的输出是「stdout/stderr/状态行」结构。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'job_output', 'job_kill']);

const STATUS_MARKER =
  /^\[(?:exit code:|timed out|killed by signal|stopped:|some output was dropped|result truncated|output truncated)[^\]]*\]$/;

const READ_STRUCTURAL = /^(?:<path>|<type>|<content>|<\/content>|\(End of file|\(Showing lines )/;

const GREP_FOOTER = /^\(.*(?:stored at|narrow pattern|complete result)/;

/**
 * 把一条结果切成单元。
 *
 * @param text - 结果文本。
 * @param tool - 工具名（决定结构识别方式）。
 * @param maxUnitChars - 单个单元的目标长度上限（多行单元按行边界合并到这个量级）。
 * @param firstLineChars - 首行长度；首行通常是最重要的（命令回显/路径），尽量整行保留。
 * @returns `{ units, kind }`。
 */
export function sectionsOf(text, tool, maxUnitChars = 400, firstLineChars = 0) {
  if (typeof text !== 'string' || text.length === 0) return { units: [], kind: 'empty' };
  const firstLineWindow = Number.isFinite(firstLineChars) && firstLineChars > 0 ? firstLineChars + 1 : 0;
  const window = Math.max(
    maxUnitChars,
    Math.min(firstLineWindow, maxUnitChars * 3),
  );
  let kind = 'lines';
  let units = null;
  if (SHELL_TOOLS.has(tool)) {
    const shell = shellSections(text);
    if (shell !== null) {
      units = shell.units;
      kind = 'shell';
    }
  }
  if (units === null && tool === 'grep' && /^Found \d/.test(text)) {
    const grep = grepSections(text);
    if (grep !== null) {
      units = grep.units;
      kind = 'grep-groups';
    }
  }
  if (units === null) units = lineUnits(text);
  if (tool === 'read') markReadStructure(units);
  return { units: refineUnits(units, window), kind };
}

function lineUnits(text) {
  const lines = text.split('\n');
  const units = new Array(lines.length);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    units[index] = { text: line, priority: 0, line: index + 1, lines: 1, blank: line.trim() === '' };
  }
  return units;
}

function shellSections(text) {
  const lines = text.split('\n');
  const units = [];
  let buffer = [];
  let start = 1;
  let sawStructure = false;
  const flush = (atLine) => {
    if (buffer.length === 0) return;
    units.push({ text: buffer.join('\n'), priority: 0, line: start, lines: buffer.length });
    buffer = [];
    start = atLine;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '[stderr]') {
      sawStructure = true;
      flush(index + 1);
      units.push({ text: line, priority: 1, line: index + 1, lines: 1 });
      start = index + 2;
      continue;
    }
    if (STATUS_MARKER.test(line)) {
      sawStructure = true;
      flush(index + 1);
      units.push({ text: line, priority: 2, line: index + 1, lines: 1 });
      start = index + 2;
      continue;
    }
    if (buffer.length === 0) start = index + 1;
    buffer.push(line);
  }
  flush(lines.length + 1);
  if (!sawStructure) return null;
  return { units, kind: 'shell' };
}

function grepSections(text) {
  const parts = text.split('\n\n');
  if (parts.length < 2) return null;
  const units = [{ text: parts[0], priority: 2, line: 1, lines: parts[0].split('\n').length }];
  let line = units[0].lines + 2;
  for (const part of parts.slice(1)) {
    const count = part.split('\n').length;
    const footer = count === 1 && GREP_FOOTER.test(part);
    units.push({ text: part, priority: footer ? 2 : 0, line, lines: count });
    line += count + 1;
  }
  return { units, kind: 'grep-groups' };
}

function markReadStructure(units) {
  for (const unit of units) {
    if (READ_STRUCTURAL.test(unit.text)) unit.priority = 2;
  }
  return units;
}

/**
 * 把过长的单元沿**行边界**切成多个单元；单行超长时原样保留（由裁剪器带标记地截）。
 *
 * @param units - 单元数组。
 * @param maxUnitChars - 单个单元的目标上限。
 * @returns 新数组（不修改入参）。
 */
export function refineUnits(units, maxUnitChars) {
  const out = [];
  for (const unit of units) {
    if (typeof unit?.text !== 'string') continue;
    if (unit.text.length <= maxUnitChars) {
      out.push(unit);
      continue;
    }
    if (!unit.text.includes('\n')) {
      // 单行超长：整行就是一个单元。绝不切成"伪行"，否则模型会读到半行还以为是完整行。
      out.push({ ...unit, long: true });
      continue;
    }
    const lines = unit.text.split('\n');
    let buffer = [];
    let size = 0;
    let startLine = unit.line ?? 1;
    const flush = () => {
      if (buffer.length === 0) return;
      out.push({
        text: buffer.join('\n'),
        priority: unit.priority,
        line: startLine,
        lines: buffer.length,
      });
      startLine += buffer.length;
      buffer = [];
      size = 0;
    };
    for (const line of lines) {
      const size2 = line.length + (buffer.length > 0 ? 1 : 0);
      if (buffer.length > 0 && size + size2 > maxUnitChars) flush();
      buffer.push(line);
      size += line.length + (buffer.length > 1 ? 1 : 0);
    }
    flush();
  }
  return out;
}

/**
 * 在预算内挑出「头部前缀 + 尾部后缀」。
 *
 * - 头：从第一单元起顺序取，**首单元永远优先**（命令回显 / `<path>` / 表头）；
 *   取不下就带 `⟨…+N⟩` 标记截断，绝不静默丢内容。
 * - 尾：从最后一单元起**逆序连续**取，保证最后一行永远是原文的最后一行；
 *   取不下就带 `⟨+N…⟩` 标记截断。旧实现在单行大输出上会让尾段退化成
 *   「原文第 97 个字符处的 2 个字符」，这里从结构上排除。
 *
 * @param units - `sectionsOf` 的单元。
 * @param budget - 头 + 尾的总字符预算。
 * @param options - `{ headRatio, tailRatio, keepLast, minTailChars }`。
 * @returns 选中的头/尾、被省略的单元与统计。
 */
export function pickSections(units, budget, options = {}) {
  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const keepLast = options.keepLast ?? true;
  const minTailChars = options.minTailChars ?? 0;
  const total = Math.max(0, budget);
  // 头尾比例之和常常是 0.9（0.55 + 0.35），照原样分预算会白扔 10%。
  // 这里按比例**归一化**：头尾合起来正好用满内容预算，比例关系不变。
  const share = Math.max(0.01, headRatio + tailRatio);
  let headBudget = Math.floor((total * headRatio) / share);
  let tailBudget = total - headBudget;
  if (tailBudget < minTailChars) {
    tailBudget = Math.min(total, minTailChars);
    headBudget = Math.max(0, total - tailBudget);
  }
  if (keepLast && total >= 80) {
    tailBudget = Math.max(tailBudget, Math.min(Math.floor(total / 2), 80));
    if (headBudget + tailBudget > total) headBudget = Math.max(0, total - tailBudget);
  }

  const head = [];
  let headChars = 0;
  let headUnits = 0;
  let headLong = null;
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const size = unit.text.length + (headUnits > 0 ? 1 : 0);
    if (headChars + size > headBudget) {
      // 装不下：如果还剩得下上百字符，就把这一单元**带标记**地截一段进来
      // （长行、大段 JSON 的开头通常正是模型要的），否则停下。
      const room = headBudget - headChars;
      if (room >= 120) {
        const clipped = clipHead(unit.text, room);
        if (clipped.text !== '') {
          head.push(clipped.text);
          headChars += clipped.text.length;
          headUnits += 1;
          if (unit.text.length > room) headLong = { index, kept: unit.text.length - clipped.clipped };
        }
      } else if (headUnits === 0 && headBudget > 0) {
        const clipped = clipHead(unit.text, headBudget);
        if (clipped.text !== '') {
          head.push(clipped.text);
          headChars = clipped.text.length;
          headUnits = 1;
        }
      }
      break;
    }
    head.push(unit.text);
    headChars += size;
    headUnits += 1;
  }

  const tailEntries = [];
  let tailChars = 0;
  if (keepLast && headUnits < units.length) {
    for (let index = units.length - 1; index >= headUnits; index -= 1) {
      const unit = units[index];
      const last = index === units.length - 1;
      // 只有行号的空行（`44:`）不携带信息，也不该吃掉尾部预算。
      if (!last && isEmptyUnit(unit.text)) continue;
      const size = unit.text.length + (tailEntries.length > 0 ? 1 : 0);
      if (last && size > tailBudget) {
        const clipped = clipBoth(unit.text, Math.max(48, tailBudget));
        if (clipped.text !== '') tailEntries.push({ index, text: clipped.text });
        break;
      }
      if (tailChars + size > tailBudget) {
        const room = tailBudget - tailChars;
        if (room >= 120) {
          const clipped = clipTail(unit.text, room);
          if (clipped.text !== '') tailEntries.push({ index, text: clipped.text });
        }
        break;
      }
      tailEntries.push({ index, text: unit.text });
      tailChars += size;
    }
  }
  if (headLong !== null && tailChars < tailBudget) {
    const unit = units[headLong.index];
    const rest = unit.text.slice(headLong.kept);
    const room = tailBudget - tailChars;
    if (rest.length > 0 && room >= 120) {
      const clipped = clipTail(rest, room);
      if (clipped.text !== '') {
        tailEntries.push({ index: headLong.index, text: clipped.text });
        tailChars += clipped.text.length;
      }
    }
  }
  tailEntries.sort((left, right) => left.index - right.index);

  const tailIndexes = tailEntries.map((entry) => entry.index);
  const tailSet = new Set(tailIndexes);
  const omittedUnitsList = [];
  const omittedIndexes = [];
  let omittedChars = 0;
  for (let index = 0; index < units.length; index += 1) {
    if (index < headUnits || tailSet.has(index)) continue;
    const unit = units[index];
    omittedUnitsList.push(unit);
    omittedIndexes.push(index);
    omittedChars += unit.text.length + 1;
  }

  return {
    head: head.join('\n'),
    tail: tailEntries.map((entry) => entry.text).join('\n'),
    headUnits,
    tailUnits: tailIndexes.length,
    tailIndexes,
    omittedUnits: omittedUnitsList.length,
    omittedChars,
    omittedUnitsList,
    omittedIndexes,
    partialLine: headLong === null ? null : (units[headLong.index].line ?? null),
    lastUnitText: units.length > 0 ? units[units.length - 1].text : '',
  };
}

function isEmptyUnit(text) {
  return text.trim() === '' || /^\d+:\s*$/.test(text);
}
