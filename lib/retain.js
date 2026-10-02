/**
 * 有界保留：当一条工具结果太大时，保留「头 + 尾 + 全部可疑行」，中段用一行**精确**说明替代。
 *
 * ## 为什么这不是“砍信息”
 *
 * 工具结果的最终作用只有一个：让模型决定下一步。决定下一步需要的是开头（格式/接口/
 * 命令回显）、结尾（结论/报错/退出状态）与所有异常行（错误、失败、警告、堆栈）。
 * 大段中段通常是枚举、依赖树、转义 HTML、逐行快照——它们的信息可以用“被省略了多少”
 * 精确概括，而内容本身**全部可以从这一次工具调用的参数重新取回**：
 * `bash` 重跑同一条命令、`read` 用 `offset` 续读、`grep` 缩小模式、`web_fetch` 重取 URL。
 * 提示里给出的就是这条取回路径，所以中段是“延后读取”，不是“丢失”。
 *
 * ## 安全边界
 *
 * - 只在**确实变小**时替换（净收益闸门，与 `text.js` 同一口径）；
 * - 原文自带的可恢复路径（DSH 自己的 `[output truncated; full output: …]` 或
 *   `Full formatted result stored at: …`）一律原样保留，绝不因为裁剪而丢掉它；
 * - 富内容（图片等非文本块）不参与裁剪判定，也不会被删除，只按原顺序保留；
 * - 失败结果（`isError`）由调用方整体跳过，本模块不负责该判断。
 *
 * @module dsh-tool-token-optimizer/retain
 */

import { pickSections, sectionsOf } from './sections.js';

/** 中段省略标记的固定前缀，便于测试与模型识别。 */
export const ELISION_PREFIX = '[…]';

/**
 * “可疑行”判定：这些行无论位置都必须保留。
 *
 * 刻意只匹配**有信息量**的失败信号，且用词边界避免误报（例如 `errorRate`、
 * `0 errors` 不应算异常行）。
 */
const IMPORTANT_PATTERNS = [
  /\b(?:error|failed|failure|fatal|panic|exception|traceback)\b/i,
  /\b(?:warn|warning|deprecated)\b/i,
  /\b(?:assert|assertion)\w*\s+failed\b/i,
  /\b(?:ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|MODULE_NOT_FOUND)\b/,
  /^\s*at\s+\S+\s*\(/,
  /^\s*(?:FAIL|FAILED|✗|✘|not ok)\b/,
  /^\s*(?:Error|TypeError|RangeError|SyntaxError|ReferenceError)\b/,
  /\[exit code:\s*-?\d+\]/,
  /\bexit code\b/i,
  // DSH 工具自己写的结构化标记行：`[stderr]`、`[output truncated; full output: …]`、
  // `[timed out after …]`、`[killed by signal: …]`、`[stopped: …]`、`[result truncated]`、
  // `[some output was dropped from memory; …]`。它们是**分节与状态**的唯一标记：
  // 丢了 `[stderr]` 之后，一段警告会和 stdout 混在一起，模型会误判命令的输出通道。
  /^\[[a-z][^\]]*\]$/,
  /^\[(?:exit code|timed out|killed by signal|stopped|stderr|result truncated|output truncated|some output was dropped)[^\]]*\]/,
  /^Full (?:sorted |grep |formatted )?result stored at:/,
];

/** 明确的“零问题”措辞：出现这些词组的行不算可疑行（避免把汇总行当报错）。 */
const BENIGN_PATTERNS = [/\b(?:0|no|zero)\s+(?:errors?|failures?|warnings?|problems?)\b/i];

/**
 * 一行是否必须保留。
 *
 * @param line - 单行文本。
 * @returns 是否命中可疑行模式。
 */
export function isImportantLine(line) {
  if (line.length === 0) return false;
  for (const pattern of BENIGN_PATTERNS) {
    if (pattern.test(line)) return false;
  }
  for (const pattern of IMPORTANT_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

/**
 * 找出结果里已经存在的可恢复路径（DSH 自己写的 spill 提示）。
 *
 * 两种已知拼写都认：
 * - bash：`[output truncated; full output: /path]`
 * - 通用：`Full formatted result stored at: /path.`
 *
 * 路径后面可能紧跟句末标点（`spill-policy` 的提示是 `…at: LOCATOR. HINT`），因此
 * 这里刻意停在空白/右括号/右引号处，不把句号吞进路径。
 *
 * @param text - 结果全文。
 * @returns 路径字符串，或 null。
 */
export function findRecoveryPath(text) {
  const truncated = /\[output truncated; full output: ([^\]\n]+?)\s*\]/.exec(text);
  if (truncated !== null) return truncated[1];
  const stored = /Full formatted result stored at: ([^\s)\]]+)/.exec(text);
  if (stored !== null) return stored[1].replace(/[.,;:]$/, '');
  const grep = /Full grep result stored at: ([^\s)\]]+)/.exec(text);
  if (grep !== null) return grep[1].replace(/[.,;:]$/, '');
  return null;
}

/**
 * 构造省略说明行。
 *
 * 说明里必须同时给出：省掉了多少、为什么可以省、怎么取回。三者缺一，模型就会
 * 重跑工具（省下的 token 又被花回去）。
 *
 * @param options - `chars`（省掉的字符数）、`lines`（省掉的行数）、`total`（原文总字符数）、
 *   `important`（中段里的可疑行数量）、`recovery`（可恢复路径或提示，可为空）。
 * @returns 单行说明（不含首尾换行）。
 */
export function elisionNotice(options) {
  const parts = [`${ELISION_PREFIX} omitted ${options.chars} chars / ${options.lines} lines of ${options.total}`];
  if (options.important > 0) parts.push(`${options.important} error/warning lines were in the omitted middle`);
  if (options.importantDropped > 0) {
    parts.push(`${options.importantDropped} error/warning lines did NOT fit the reserve and are only in the full text`);
  }
  parts.push(options.recovery ?? 're-run this tool call to get the full text');
  return parts.join('; ');
}

/**
 * 抽掉一段文本的中段，保留头、尾与全部可疑行。
 *
 * 保留策略（按预算分配，全部以字符计）：
 * 1. 先按 `headRatio` 与 `tailRatio` 切出头部与尾部；尾部至少保留 `minTailChars`，
 *    这样 DSH 自己的可恢复路径与结论性报错不会被切掉。
 * 2. 中段里命中可疑行的行，按“越靠近尾部越重要”的顺序占用 `importantBudgetChars`。
 * 3. 说明行本身占用固定额度（`reserveChars`），保证最终长度不超过 `maxChars`。
 *
 * @param text - 原文。
 * @param options - `{ maxChars, headRatio, tailRatio, minTailChars, importantBudgetChars, reserveChars }`。
 * @returns `{ text, changed, omitted, omittedLines, importantKept, importantDropped }`。
 */
export function retainMiddle(text, options) {
  const maxChars = options.maxChars;
  const reserveChars = options.reserveChars ?? 200;
  if (typeof text !== 'string' || text.length <= maxChars) {
    return { text, changed: false, omitted: 0, omittedLines: 0, importantKept: 0, importantDropped: 0 };
  }
  const budget = Math.max(0, maxChars - reserveChars);
  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const minTailChars = options.minTailChars ?? 300;
  // 可疑行预算刻意给得较大（占总预算 40%，最小值 400 字符）：它们是“下一步该做什么”的
  // 直接依据，宁可少留几行普通枚举，也不能把报错行挤掉。
  const importantBudget = options.importantBudgetChars ?? Math.max(400, Math.floor(budget * 0.4));

  // ---- 1) 结构感知：按结果自身的分段边界切，绝不切开一个单元 ------------------
  const { units, kind } = sectionsOf(text, options.tool, Math.max(120, Math.floor(budget / 4)));
  const picked = pickSections(units, budget, { headRatio, tailRatio });
  // `lines` 也是**对齐**的结果（按整行切），只有 `empty` 才没有可对齐的结构。
  let aligned = kind !== 'empty' && picked.headUnits > 0 && picked.tailUnits > 0;

  // 结构对齐后尾部可能太短（例如 `[stderr]` 段本身很长）：用最小尾部额度补一次，
  // 仍按整单元取舍，绝不回到按字符切。
  if (aligned) {
    // 中段 = **实际没被保留**的那些单元（尾部按优先级挑选，可能分散在多处，不能按位置推）。
    // 统计口径与退化路径保持一致：`lines` = 被省略单元里的**行数**减去被补回的严重行数；
    // `chars` = 被省略单元的字符数。两者都是"原本在内联结果里、现在只在全文里"的量。
    const omittedUnits = picked.omittedUnitsList ?? [];
    const omittedLines = omittedUnits.reduce((sum, unit) => sum + unit.text.split('\n').length, 0);
    const important = [];
    for (const unit of omittedUnits) {
      for (const line of unit.text.split('\n')) if (isImportantLine(line)) important.push({ line });
    }
    const kept = [];
    let importantUsed = 0;
    for (let index = important.length - 1; index >= 0; index -= 1) {
      const candidate = important[index];
      if (importantUsed + candidate.line.length + 1 > importantBudget) break;
      importantUsed += candidate.line.length + 1;
      kept.push(candidate);
    }
    kept.reverse();
    const notice = elisionNotice({
      chars: picked.omittedChars,
      lines: Math.max(0, omittedLines - kept.length),
      total: text.length,
      important: kept.length,
      importantDropped: important.length - kept.length,
      recovery: options.recovery,
    });
    const blocks = [picked.head.trimEnd()];
    if (kept.length > 0) blocks.push(kept.map((item) => item.line).join('\n'));
    blocks.push(notice);
    blocks.push(picked.tail.trimStart());
    const next = blocks.filter((part) => part.length > 0).join('\n');
    if (next.length < text.length) {
      return {
        text: next,
        changed: true,
        omitted: picked.omittedChars,
        omittedLines: Math.max(0, omittedLines - kept.length),
        importantKept: kept.length,
        importantDropped: important.length - kept.length,
        units: kind,
      };
    }
  }

  // ---- 2) 退化路径：按字符切（结果没有可识别结构，或结构对齐无收益时）----------
  let headChars = Math.floor(budget * headRatio);
  let tailChars = Math.max(minTailChars, Math.floor(budget * tailRatio));
  if (headChars + tailChars > budget) {
    const overflow = headChars + tailChars - budget;
    if (headChars > overflow) headChars -= overflow;
    else {
      tailChars = Math.max(0, tailChars - (overflow - headChars));
      headChars = 0;
    }
  }

  // 即使退化到按字符切，也把边界**吸附到行首**：宁可少留半行，也不把一行劈成两半。
  // 这样"丢弃了多少行"才能被精确计数——说明行的数字必须是真话。
  const snappedHead = snapHeadToLine(text, headChars);
  const snappedTail = snapTailToLine(text, tailChars);
  const head = text.slice(0, snappedHead);
  const tail = text.slice(text.length - snappedTail);
  const middle = text.slice(snappedHead, text.length - snappedTail);

  // 可疑行：在中段里按行定位，保留最靠近尾部（通常是最终报错）的那些。
  const important = [];
  for (const line of middle.split('\n')) {
    if (isImportantLine(line)) important.push({ line });
  }
  const kept = [];
  let importantUsed = 0;
  for (let index = important.length - 1; index >= 0; index -= 1) {
    const candidate = important[index];
    if (importantUsed + candidate.line.length + 1 > importantBudget) break;
    importantUsed += candidate.line.length + 1;
    kept.push(candidate);
  }
  kept.reverse();

  const omittedChars = middle.length - kept.reduce((sum, item) => sum + item.line.length + 1, 0);
  const omittedLines = middle.split('\n').length - kept.length;
  if (omittedChars <= 0) {
    return { text, changed: false, omitted: 0, omittedLines: 0, importantKept: 0, importantDropped: 0 };
  }

  const notice = elisionNotice({
    chars: omittedChars,
    lines: omittedLines,
    total: text.length,
    important: kept.length,
    importantDropped: important.length - kept.length,
    recovery: options.recovery,
  });

  const blocks = [head.trimEnd()];
  if (kept.length > 0) blocks.push(kept.map((item) => item.line).join('\n'));
  blocks.push(notice);
  blocks.push(tail.trimStart());
  const next = blocks.filter((part) => part.length > 0).join('\n');
  if (next.length >= text.length) {
    return { text, changed: false, omitted: 0, omittedLines: 0, importantKept: 0, importantDropped: 0 };
  }
  return {
    text: next,
    changed: true,
    omitted: omittedChars,
    omittedLines,
    importantKept: kept.length,
    importantDropped: important.length - kept.length,
    units: 'chars',
  };
}

/**
 * 把头部切点吸附到行首：只吃完整行，宁可少留半行。
 *
 * @param text - 原文。
 * @param limit - 头部字符上限。
 * @returns 吸附后的切点。
 */
function snapHeadToLine(text, limit) {
  if (limit <= 0) return 0;
  if (limit >= text.length) return text.length;
  const nextBreak = text.indexOf('\n', limit);
  if (nextBreak === -1) return text.length;
  return nextBreak + 1;
}

/**
 * 把尾部切点吸附到行首（从后往前找最近的行首）。
 *
 * @param text - 原文。
 * @param limit - 尾部字符上限。
 * @returns 吸附后实际保留的尾部字符数。
 */
function snapTailToLine(text, limit) {
  if (limit <= 0) return 0;
  if (limit >= text.length) return text.length;
  const boundary = text.length - limit;
  const previousBreak = text.lastIndexOf('\n', boundary);
  if (previousBreak === -1) return text.length;
  return text.length - previousBreak - 1;
}

/**
 * 对一组内容块套用有界保留。
 *
 * 富内容块（图片等）原样保留且不占字符预算：它们不可能被文本裁剪“替代”，
 * 删掉就是真的丢信息。
 *
 * @param content - 内容块数组。
 * @param options - `retainMiddle` 的选项，外加 `minBlockChars`（多文本块时的单块最低预算）。
 * @returns `{ content, changed, omittedChars, importantKept, importantDropped }`。
 */
export function retainContent(content, options) {
  const blocks = content ?? [];
  const textBlocks = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string');
  const totalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  if (totalChars <= options.maxChars) return { content: blocks, changed: false, omittedChars: 0 };

  // 单文本块：直接按总预算裁。多文本块：按各自长度比例分配预算，
  // 保证每一块都“按贡献”让步，而不是把后面的块整个牺牲掉。
  const budgetFor = (block) =>
    textBlocks.length === 1
      ? options.maxChars
      : Math.max(options.minBlockChars ?? 400, Math.floor((options.maxChars * block.text.length) / totalChars));

  let changed = false;
  let omittedChars = 0;
  let importantKept = 0;
  let importantDropped = 0;
  let units = 'none';
  const next = [];
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      next.push(block);
      continue;
    }
    const result = retainMiddle(block.text, { ...options, maxChars: budgetFor(block) });
    if (result.changed) {
      changed = true;
      if (typeof result.units === 'string') units = result.units;
      omittedChars += result.omitted;
      importantKept += result.importantKept;
      importantDropped += result.importantDropped;
      next.push({ ...block, text: result.text });
    } else {
      next.push(block);
    }
  }
  return { content: next, changed, omittedChars, importantKept, importantDropped, units };
}
