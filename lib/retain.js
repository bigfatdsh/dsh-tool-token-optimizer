/**
 * 有界保留：结果超预算时，保留「头 + 尾 + 全部可疑行」，中段换成**一行精确说明**。
 *
 * v2 相对 v1 的改动（都能对应到一次实测缺陷）：
 * - 行数、省略区间、省略字符三者从**同一份行号集合**推导，不再一个按内容计数、
 *   一个按单元跨度计算 —— 旧实现里 `lines 77-147` 会和 `71 lines` 对不上（相差的
 *   正是被保留下来的那几行报错）。
 * - 长单行由 `clip.js` 带 `⟨…+N⟩` 标记截断，不再切成"伪行"；尾部永远是原文最后
 *   几个字符，因此「结论 / 退出码 / footer」不再可能被挤掉。
 * - 说明行本身也参与预算：先算出说明长度，再决定内容预算，最后按真实长度收敛，
 *   并把「被丢掉的报错行」摘要的额度**显式预留**（旧实现在 1200 预算下这项恒为 0，
 *   等于永远不写摘要）。
 * - 省略掉的中段可以交给 `recordOmitted` 落盘，说明行里给出一个可直接 `read` 的
 *   路径 —— 这是「可恢复性」从"重跑命令"变成"读一个文件"的关键。
 *
 * @module dsh-tool-token-optimizer/retain
 */

import { clipHead, clipTail } from './clip.js';
import { pickSections, sectionsOf } from './sections.js';

/** 省略说明的固定前缀（模型与测试都靠它识别）。 */
export const ELISION_PREFIX = '[…]';

/** 每个非文本块固定开销（与官方估计器一致）。 */
const DEFAULT_RECOVERY = 're-run this tool call to get the full text';

const STACK_FRAME = /^\s+at\s+\S+/;

const STATUS_PATTERNS = [
  /^\[(?:exit code|timed out|killed by signal|stopped|stderr|result truncated|output truncated|some output was dropped)[^\]]*\]/,
  /\[exit code:\s*-?\d+\]/,
  /\bexit code\b/i,
];

const ERROR_PATTERNS = [
  /\b(?:error|failed|failure|fatal|panic|exception|traceback)\b/i,
  /\w*(?:Error|Exception)\b/,
  /\bnpm ERR!/,
  /\b(?:ELIFECYCLE|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+)\b/,
  /^\s*at\s+\S+\s*\(/,
  /^\s*(?:FAIL|FAILED|not ok|panic:|fatal:)\b/,
  /^\s*[✗✘✖×]/,
  /^\s*Expected:.*(?:received|actual)/i,
  /^\s*(?:AssertionError|Assertion failed)\b/,
];

const WARN_PATTERNS = [/\b(?:warn|warning|deprecated)\b/i];

const IMPORTANT_HINT =
  /error|fail|fatal|panic|exception|traceback|warn|deprecat|exit code|stderr|assert|expected|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|MODULE_NOT_FOUND|ELIFECYCLE|ERR_|npm ERR|timed out|killed by signal|stopped|truncated|some output was dropped|not ok|FAIL|✗|✘|✖|×/i;

/**
 * 判断一行是否值得优先保留。
 *
 * @param line - 单行文本。
 * @returns 布尔。
 */
export function isImportantLine(line) {
  return importantPriority(line) > 0;
}

/**
 * 可疑行的优先级：3 = 状态行，2 = 错误/堆栈，1 = 警告，0 = 普通。
 *
 * @param line - 单行文本。
 * @returns 0..3。
 */
export function importantPriority(line) {
  if (typeof line !== 'string' || line === '') return 0;
  if (STACK_FRAME.test(line)) return 2;
  if (!IMPORTANT_HINT.test(line)) return 0;
  if (STATUS_PATTERNS.some((pattern) => pattern.test(line))) return 3;
  if (ERROR_PATTERNS.some((pattern) => pattern.test(line))) return 2;
  if (WARN_PATTERNS.some((pattern) => pattern.test(line))) return 1;
  return 0;
}

/**
 * 从别家插件写的说明里找出「全文在哪」。
 *
 * @param text - 结果文本。
 * @returns 路径或 null。
 */
export function findRecoveryPath(text) {
  if (typeof text !== 'string') return null;
  const truncated = /\[output truncated;\s*full output:\s*([^\]\s]+)\s*\]/.exec(text);
  if (truncated !== null) return truncated[1];
  const stored = /Full formatted result stored at: ([^\s)\]]+)/.exec(text);
  if (stored !== null) return stored[1].replace(/[.,;:]$/, '');
  const grep = /Full grep result stored at: ([^\s)\]]+)/.exec(text);
  if (grep !== null) return grep[1].replace(/[.,;:]$/, '');
  const spill = /\bFull text:\s*([^\s—]+)/.exec(text);
  if (spill !== null) return spill[1].replace(/[.,;:]$/, '');
  return null;
}

function selectImportantLines(entries, budget, alreadyVisible, visibleIndexes) {
  const candidates = [];
  for (let index = 0; index < entries.length; index += 1) {
    const { line, absolute } = entries[index];
    const priority = importantPriority(line);
    if (priority === 0) continue;
    if (visibleIndexes !== undefined && absolute !== undefined && visibleIndexes.has(absolute)) continue;
    if (alreadyVisible !== undefined && alreadyVisible.has(line)) continue;
    candidates.push({ line, priority, index, absolute });
  }
  candidates.sort((left, right) => right.priority - left.priority || left.index - right.index);
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const candidate of candidates) {
    const size = candidate.line.length + 1;
    if (used + size > budget) {
      dropped.push(candidate);
      continue;
    }
    used += size;
    kept.push(candidate);
  }
  kept.sort((left, right) => left.index - right.index);
  return { kept, dropped };
}

function importantDigest(dropped, limit) {
  if (dropped.length === 0 || limit < 24) return '';
  let out = '';
  let shown = 0;
  for (const item of dropped) {
    const room = limit - out.length - (shown === 0 ? 0 : 2) - 1;
    if (room < 16) break;
    const oneLine = item.line.trim().replace(/\s+/g, ' ');
    const clipped = oneLine.length > room ? `${oneLine.slice(0, room - 1)}…` : oneLine;
    out += `${shown === 0 ? '' : '; '}${clipped}`;
    shown += 1;
    if (shown >= 3) break;
  }
  if (shown === 0) return '';
  const remaining = dropped.length - shown;
  if (remaining > 0) {
    const tailText = ` (+${remaining} more)`;
    if (out.length + tailText.length <= limit) out += tailText;
  }
  return out;
}

/** 把连续行号压成 `a-b` 区间，最多展示两段。 */
function runText(numbers, label) {
  if (numbers.length === 0) return '';
  const runs = [];
  for (const number of numbers) {
    const last = runs[runs.length - 1];
    if (last !== undefined && number === last[1] + 1) last[1] = number;
    else runs.push([number, number]);
  }
  const shown = runs.slice(0, 2).map(([from, to]) => (from === to ? `${from}` : `${from}-${to}`));
  const more = runs.length > 2 ? ` +${runs.length - 2} more` : '';
  return `${label} ${shown.join(', ')}${more}`;
}

/**
 * 生成省略说明行（**格式向后兼容**：前三个字段与 v1 完全一致）。
 *
 * @param options - `{ chars, lines, total, ranges, important, importantPresent, importantDropped, digest, recovery }`。
 * @returns 单行说明。
 */
export function elisionNotice(options) {
  const parts = [`${ELISION_PREFIX} omitted ${options.chars} chars / ${options.lines} lines of ${options.total}`];
  if (typeof options.ranges === 'string' && options.ranges !== '') parts.push(options.ranges);
  const present = options.importantPresent ?? options.important ?? 0;
  const kept = options.important ?? 0;
  if (present > 0) {
    parts.push(`${present} error line${present === 1 ? '' : 's'} inside`);
    if (kept > 0 && kept < present) parts.push(`${kept} kept`);
  }
  if (options.importantDropped > 0) {
    parts.push(`${options.importantDropped} only in full text`);
    if (typeof options.digest === 'string' && options.digest !== '') parts.push(`first: ${options.digest}`);
  }
  parts.push(options.recovery ?? DEFAULT_RECOVERY);
  return parts.join('; ');
}

/** 说明行的预留长度：经验上界，随后会被真实长度收敛掉。 */
function noticeReserve(textLength, recoveryReserve = 0, maxChars = Number.POSITIVE_INFINITY) {
  void textLength;
  void recoveryReserve;
  // 说明行也是模型要付的 token：给它一个**固定份额**（约 20%，最多 240 字符），
  // 内容预算 = 总预算 − 这个份额。这样"说明写多长"永远不会挤掉内容，
  // 也不会出现"先按小份额算、装不下再回头砍内容"的两头不靠。
  const share = Math.floor(maxChars * 0.2);
  return Math.min(240, Math.max(72, share));
}

/** 单个保留单元的行集合（unit → 绝对行号 + 行文本）。 */
function linesOfUnit(unit) {
  const text = unit.text;
  const start = Number.isFinite(unit.line) ? unit.line : 1;
  const parts = text.split('\n');
  const out = new Array(parts.length);
  for (let index = 0; index < parts.length; index += 1) {
    out[index] = { no: start + index, text: parts[index] };
  }
  return out;
}

/** read 工具的行号前缀（`123: text`）。 */
function readLineNumber(text) {
  const match = /^(\d+):/.exec(text);
  return match === null ? null : Number(match[1]);
}

/**
 * 保留头、尾与中段里的可疑行。
 *
 * @param text - 结果文本。
 * @param options - `{ maxChars, tool, headRatio, tailRatio, minTailChars, importantBudgetChars, recordOmitted, recovery, originalChars }`。
 * @returns `{ text, changed, omitted, omittedLines, importantKept, importantDropped, units }`。
 */
export function retainMiddle(text, options) {
  const maxChars = options.maxChars;
  const unchanged = {
    text,
    changed: false,
    omitted: 0,
    omittedLines: 0,
    importantKept: 0,
    importantDropped: 0,
  };
  if (typeof text !== 'string' || text.length <= maxChars) return unchanged;
  const originalChars = options.originalChars ?? text.length;
  if (!text.includes('\n')) return retainSingleLine(text, options, unchanged, originalChars);
  const recoveryReserve = typeof options.recordOmitted === 'function' ? 74 : 0;
  const floor = Math.max(48, noticeReserve(originalChars, recoveryReserve, maxChars));
  const contentBudget = Math.max(0, maxChars - floor);
  if (contentBudget < 64) return unchanged;

  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const minTailChars = options.minTailChars ?? 300;
  const firstBreak = text.indexOf('\n');
  const firstLineChars = firstBreak === -1 ? text.length : firstBreak;
  const { units, kind } = sectionsOf(
    text,
    options.tool,
    Math.max(120, Math.floor(contentBudget / 4)),
    firstLineChars,
  );
  if (units.length === 0) return unchanged;

  const pickOptions = { headRatio, tailRatio, minTailChars, keepLast: true };
  // 先用 80% 预算拿结构，剩下的留给中段报错行；若中段没有报错行，再按满预算取一次。
  let picked = pickSections(units, Math.floor(contentBudget * 0.8), pickOptions);
  let middleLines = [];
  for (const unit of picked.omittedUnitsList) middleLines.push(...linesOfUnit(unit));
  const visibleHead = new Set(picked.head.split('\n'));
  const visibleTail = new Set(picked.tail.split('\n'));
  const hasImportant = middleLines.some(
    (entry) => importantPriority(entry.text) > 0 && !visibleHead.has(entry.text) && !visibleTail.has(entry.text),
  );
  if (!hasImportant) picked = pickSections(units, contentBudget, pickOptions);
  return finish(text, units, kind, picked, options, originalChars, maxChars, hasImportant);
}


/**
 * 单行结果（minified JSON、大 SQL dump、base64）：整行不是"很多行"，而是**一行**。
 * 保留策略是「前缀 + 说明 + 后缀」，两端都用 `clip.js` 带标记地截，绝不造伪行，
 * 也绝不让尾段退化成原文中间的碎片。
 *
 * @param text - 单行全文。
 * @param options - `retainMiddle` 的选项。
 * @param unchanged - 未改动时的返回值。
 * @param originalChars - 折叠前的原文长度。
 * @returns retainMiddle 的结果。
 */
function retainSingleLine(text, options, unchanged, originalChars) {
  const maxChars = options.maxChars;
  const recoveryReserve = typeof options.recordOmitted === 'function' ? 74 : 0;
  const reserve = noticeReserve(originalChars, recoveryReserve, maxChars);
  const contentBudget = maxChars - reserve;
  if (contentBudget < 96) return unchanged;
  const headRatio = options.headRatio ?? 0.55;
  const headBudget = Math.max(40, Math.floor(contentBudget * headRatio));
  const tailBudget = Math.max(40, contentBudget - headBudget);
  const headClip = clipHead(text, headBudget);
  const headKept = text.length - headClip.clipped;
  const tailRoom = Math.min(tailBudget, Math.max(0, text.length - headKept - 1));
  const tailClip = tailRoom > 40 ? clipTail(text.slice(headKept), tailRoom) : { text: '', clipped: 0 };
  const tailKept = tailRoom > 40 ? text.length - headKept - tailClip.clipped : 0;
  const omittedText = text.slice(headKept, Math.max(headKept, text.length - tailKept));

  let recovery = options.recovery;
  const record = typeof options.recordOmitted === 'function' ? options.recordOmitted : null;
  if (record !== null && omittedText !== '') {
    try {
      const path = record(omittedText);
      if (typeof path === 'string' && path !== '') recovery = `middle: ${path}`;
    } catch {
      // 落盘失败不影响结果。
    }
  }

  let notice = elisionNotice({ chars: omittedText.length, lines: 1, total: originalChars, recovery });
  let next = [headClip.text, notice, tailClip.text].filter((part) => part !== '').join('\n');
  for (let round = 0; round < 3 && next.length > maxChars; round += 1) {
    const room = Math.max(40, maxChars - next.length + tailClip.text.length - (notice.length + 2));
    const tighter = clipTail(text.slice(headKept), room);
    if (tighter.text === tailClip.text) break;
    tailClip.text = tighter.text;
    notice = elisionNotice({ chars: omittedText.length, lines: 1, total: originalChars, recovery });
    next = [headClip.text, notice, tailClip.text].filter((part) => part !== '').join('\n');
  }
  // 收缩后说明长度可能变，用不动点把 chars 钉死：chars + len(next) == total。
  for (let round = 0; round < 5; round += 1) {
    const chars = Math.max(0, originalChars - next.length);
    const built = elisionNotice({ chars, lines: 1, total: originalChars, recovery });
    if (built.length === notice.length) {
      notice = built;
      next = [headClip.text, notice, tailClip.text].filter((part) => part !== '').join('\n');
      break;
    }
    notice = built;
    next = [headClip.text, notice, tailClip.text].filter((part) => part !== '').join('\n');
  }
  if (next.length >= text.length) return unchanged;
  return {
    text: next,
    changed: true,
    omitted: text.length - next.length,
    omittedLines: 1,
    importantKept: 0,
    importantDropped: 0,
    units: 'single-line',
  };
}

function finish(text, units, kind, picked, options, originalChars, maxChars) {
  let headText = picked.head;
  let tailIndexes = Array.isArray(picked.tailIndexes) ? [...picked.tailIndexes] : [];
  let tailText = picked.tail;
  const omittedUnits = picked.omittedUnitsList;

  const headLineSet = new Set();
  for (const unit of units.slice(0, picked.headUnits)) {
    for (const entry of linesOfUnit(unit)) headLineSet.add(entry.no);
  }
  const tailLineSet = new Set();
  for (const index of tailIndexes) {
    const unit = units[index];
    if (unit === undefined) continue;
    for (const entry of linesOfUnit(unit)) tailLineSet.add(entry.no);
  }

  const middleEntries = [];
  for (const unit of omittedUnits) {
    for (const entry of linesOfUnit(unit)) middleEntries.push({ line: entry.text, absolute: entry.no });
  }
  const alreadyVisible = new Set([...headText.split('\n'), ...tailText.split('\n')]);
  const visibleNumbers = new Set([...headLineSet, ...tailLineSet]);
  const importantBudget = Math.min(
    Math.floor(maxChars * 0.3),
    options.importantBudgetChars ?? Math.max(400, Math.floor(maxChars * 0.4)),
  );
  let { kept, dropped } = selectImportantLines(
    middleEntries,
    importantBudget,
    alreadyVisible,
    visibleNumbers,
  );

  const recoveryReserve = typeof options.recordOmitted === 'function' ? 74 : 0;
  const noticeCap = noticeReserve(originalChars, recoveryReserve, maxChars);
  let recovery = options.recovery;
  let recordPath = null;

  const omittedFrom = (keptLines) => {
    const keptNumbers = new Set(keptLines.map((item) => item.absolute));
    const numbers = [];
    for (const unit of omittedUnits) {
      for (const entry of linesOfUnit(unit)) {
        if (keptNumbers.has(entry.no)) continue;
        numbers.push({ no: entry.no, text: entry.text, unit });
      }
    }
    numbers.sort((left, right) => left.no - right.no);
    return numbers;
  };

  const buildNotice = (omittedNow, chars, withExtras) => {
    const ranges = withExtras
      ? options.tool === 'read'
        ? runText(readNumbers(omittedNow), 'file lines')
        : runText(lineNumbers(), 'lines')
      : '';
    const base = {
      chars: Math.max(0, chars),
      lines: omittedNow.length + (partialLine === null ? 0 : 1),
      total: originalChars,
      importantPresent: kept.length + dropped.length,
      important: kept.length,
      importantDropped: dropped.length,
      recovery,
    };
    const full = elisionNotice({ ...base, ranges });
    if (dropped.length > 0) {
      const room = noticeBudget - full.length - 8;
      if (room >= 24) {
        const digest = importantDigest(dropped, Math.min(80, room));
        if (digest !== '') {
          const withDigest = elisionNotice({ ...base, ranges, digest });
          if (withDigest.length <= noticeBudget) return { base, notice: withDigest };
        }
      }
    }
    if (full.length <= noticeBudget) return { base, notice: full };
    const lean = elisionNotice({ ...base, ranges: '' });
    if (lean.length <= noticeBudget) return { base, notice: lean };
    const bare = elisionNotice({ ...base, ranges: '', importantPresent: 0, important: 0, importantDropped: 0 });
    if (bare.length <= noticeBudget) return { base, notice: bare };
    return { base, notice: elisionNotice({ chars: base.chars, lines: base.lines, total: base.total, recovery }) };
  };

  const noticeBudget = Math.max(72, Math.min(240, Math.floor(maxChars * 0.2)));
  // 一个长单行被头/尾同时截过：它不占"整行省略"，但确实缺了一段，
  // 行数与区间都要算上一行，否则会出现"省略 199402 字符 / 0 行"的自相矛盾。
  const partialLine = Number.isFinite(picked.partialLine) ? picked.partialLine : null;
  const lineNumbers = () => {
    const numbers = omittedNow.map((entry) => entry.no);
    if (partialLine !== null) numbers.push(partialLine);
    numbers.sort((left, right) => left - right);
    return numbers;
  };
  let notice = '';
  let omittedNow = omittedFrom(kept);
  let next = '';
  for (let round = 0; round < 6; round += 1) {
    const keptText = kept.map((item) => item.line).join('\n');
    const visibleNoNotice = [headText, keptText, tailText].filter((part) => part !== '').join('\n');
    const chars = originalChars - visibleNoNotice.length - 1 - notice.length;
    const built = buildNotice(omittedNow, chars, true);
    notice = built.notice;
    next = [headText, keptText, notice, tailText].filter((part) => part !== '').join('\n');
    if (next.length > maxChars) {
      if (kept.length > 0) {
        const victim = kept[kept.length - 1];
        kept = kept.slice(0, -1);
        dropped = [...dropped, victim];
        omittedNow = omittedFrom(kept);
        continue;
      }
      if (tailIndexes.length > 1) {
        tailIndexes = tailIndexes.slice(1);
        tailText = tailTextFromIndexes(units, tailIndexes);
        continue;
      }
      // 最后兜底：把尾部按剩余空间带标记截断，保证「真正的结尾」留在里面。
      const room = maxChars - (headText.length + 1 + notice.length + 1);
      if (room >= 40) {
        const clipped = clipTail(tailText, room);
        tailText = clipped.text;
        continue;
      }
      notice = elisionNotice({
        chars: Math.max(0, originalChars - 1),
        lines: 1,
        total: originalChars,
        recovery,
      });
      next = [headText, notice].filter((part) => part !== '').join('\n');
      break;
    }
    break;
  }

  // 落盘：把最终被拿掉的中段写成文件（失败就算了，绝不抛）。
  const record = typeof options.recordOmitted === 'function' ? options.recordOmitted : null;
  const keptTextOf = () => kept.map((item) => item.line).join('\n');
  const visibleOf = () => [headText, keptTextOf(), tailText].filter((part) => part !== '');
  const contentLenOf = () => {
    const parts = visibleOf();
    return parts.length === 0 ? 0 : parts.join('\n').length;
  };
  const assemble = () => [headText, keptTextOf(), notice, tailText].filter((part) => part !== '').join('\n');
  if (record !== null && omittedNow.length > 0) {
    try {
      const path = record(omittedNow.map((entry) => entry.text).join('\n'));
      if (typeof path === 'string' && path !== '') recovery = `middle: ${path}`;
    } catch {
      // 落盘失败：保留"重跑"提示。
    }
  }

  // 收敛：说明里的 chars 与成品长度必须严格自洽（chars + len == total）。
  // 说明长度只影响 chars 的位数，不动点迭代几轮就稳。
  for (let outer = 0; outer < 3; outer += 1) {
    let noticeLen = notice.length;
    for (let round = 0; round < 6; round += 1) {
      const sep = contentLenOf() > 0 ? 1 : 0;
      const chars = originalChars - contentLenOf() - sep - noticeLen;
      const built = buildNotice(omittedNow, chars, true);
      if (built.notice.length === noticeLen) {
        notice = built.notice;
        break;
      }
      notice = built.notice;
      noticeLen = built.notice.length;
    }
    next = assemble();
    if (next.length <= maxChars) break;
    const over = next.length - maxChars;
    if (headText.length > 80) {
      const shrunk = clipHead(headText, Math.max(40, headText.length - over - 12));
      if (shrunk.text.length >= headText.length) break;
      headText = shrunk.text;
      continue;
    }
    if (tailText.length > 80) {
      const shrunk = clipTail(tailText, Math.max(40, tailText.length - over - 12));
      if (shrunk.text.length >= tailText.length) break;
      tailText = shrunk.text;
      continue;
    }
    break;
  }
  if (next.length >= text.length) return { ...emptyResult(text) };

  return {
    text: next,
    changed: true,
    omitted: text.length - next.length,
    omittedLines: omittedNow.length + (partialLine === null ? 0 : 1),
    importantKept: kept.length,
    importantDropped: dropped.length,
    units: kind,
    omittedText: omittedNow.map((entry) => entry.text).join('\n'),
  };
}

function emptyResult(text) {
  return {
    text,
    changed: false,
    omitted: 0,
    omittedLines: 0,
    importantKept: 0,
    importantDropped: 0,
  };
}
function tailTextFromIndexes(units, indexes) {
  const parts = [];
  for (const index of indexes) {
    const unit = units[index];
    if (unit === undefined) continue;
    parts.push(unit.text);
  }
  return parts.join('\n');
}

/** read 的行号：优先用行首 `123:` 前缀，没有前缀就退回绝对行号。 */
function readNumbers(omittedNow) {
  const prefixed = [];
  for (const entry of omittedNow) {
    const number = readLineNumber(entry.text);
    if (number !== null) prefixed.push(number);
  }
  return prefixed.length > 0 ? prefixed : omittedNow.map((entry) => entry.no);
}

/**
 * 多文本块：总预算在块之间分配，**总和永不超预算**。
 *
 * @param content - 内容块数组。
 * @param options - `retainMiddle` 的选项外加 `minBlockChars`。
 * @returns `{ content, changed, omittedChars, importantKept, importantDropped }`。
 */
export function retainContent(content, options) {
  const blocks = content ?? [];
  const textBlocks = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string');
  const totalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  if (totalChars <= options.maxChars) {
    return { content, changed: false, omittedChars: 0, importantKept: 0, importantDropped: 0 };
  }
  const minBlockChars = Math.max(0, options.minBlockChars ?? 400);
  const maxChars = Math.max(0, options.maxChars);
  const budgets = new Map();
  let assigned = 0;
  for (const block of textBlocks) {
    const share = Math.max(0, Math.floor((maxChars * block.text.length) / Math.max(1, totalChars)));
    budgets.set(block, share);
    assigned += share;
  }
  // 小块兜底：把剩余的预算（以及大块多占的部分）挪给不足 minBlockChars 的块，
  // 但**总和不超过 maxChars** —— 旧实现会把 20 个块顶到 4.7 倍预算。
  let remaining = Math.max(0, maxChars - assigned);
  for (const block of textBlocks) {
    const need = minBlockChars - budgets.get(block);
    if (need <= 0 || remaining <= 0) continue;
    const give = Math.min(need, remaining);
    budgets.set(block, budgets.get(block) + give);
    remaining -= give;
  }
  // 块数不多时，保证每块至少拿得到 160 字符（否则裁了也等于没裁，只能整块变说明）。
  // 差额从最大的块里挪，总量不变。
  if (textBlocks.length * 160 <= maxChars) {
    for (let pass = 0; pass < 3; pass += 1) {
      let moved = 0;
      for (const block of textBlocks) {
        const have = budgets.get(block);
        if (have >= 160) continue;
        const need = 160 - have;
        let donor = null;
        for (const candidate of textBlocks) {
          if (budgets.get(candidate) - need >= 160 && (donor === null || budgets.get(candidate) > budgets.get(donor))) {
            donor = candidate;
          }
        }
        if (donor === null) continue;
        budgets.set(donor, budgets.get(donor) - need);
        budgets.set(block, 160);
        moved += need;
      }
      if (moved === 0) break;
    }
  }
  if (remaining > 0 && textBlocks.length > 0) {
    let largest = textBlocks[0];
    for (const block of textBlocks) if (block.text.length > largest.text.length) largest = block;
    budgets.set(largest, budgets.get(largest) + remaining);
  }
  let changed = false;
  let omittedChars = 0;
  let importantKept = 0;
  let importantDropped = 0;
  const originalChars = options.originalChars;
  const out = blocks.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block;
    const budget = Math.max(0, Math.min(maxChars, budgets.get(block) ?? 0));
    if (budget < 160) {
      // 块多到每块只剩几十字符：与其"裁了等于没裁"，不如整块换成一行可恢复的说明。
      let hint = options.recovery ?? 're-run this tool call to get the full text';
      if (typeof options.recordOmitted === 'function') {
        try {
          const path = options.recordOmitted(block.text);
          if (typeof path === 'string' && path !== '') hint = `middle: ${path}`;
        } catch {
          // 落盘失败退回重跑提示。
        }
      }
      const notice = `[…] omitted ${block.text.length} chars / 1 lines of ${block.text.length}; ${hint}`;
      const text = notice.length <= budget ? notice : `${notice.slice(0, Math.max(8, budget - 1))}…`;
      changed = true;
      omittedChars += block.text.length;
      return { ...block, text };
    }
    const result = retainMiddle(block.text, {
      ...options,
      maxChars: budget,
      originalChars: originalChars?.get?.(block),
    });
    if (!result.changed) return block;
    changed = true;
    omittedChars += result.omitted;
    importantKept += result.importantKept;
    importantDropped += result.importantDropped;
    return { ...block, text: result.text };
  });
  return { content: changed ? out : blocks, changed, omittedChars, importantKept, importantDropped };
}
