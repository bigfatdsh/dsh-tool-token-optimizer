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
 * ## 四条不可交易的硬约束（改动本模块前先读这一段）
 *
 * 1. **绝不放大**：输出字符数永远 ≤ `maxChars`。这是**上界**，不是"大概齐"——
 *    `maxChars` 曾经只是个软目标，实测 17% 的结果超出它（最大 1.31 倍），
 *    于是"插件把结果压到 N 字以内"这句话在运行时是假的。现在所有预算
 *    （头/尾/可疑行/说明行/摘要）都在**同一个上界里**分配。
 * 2. **首行与末行必须留下**：开头是格式与接口，末行是结论与退出状态。
 *    末单元即使自己就超过整个尾部预算，也退化为「截断后的末行」而不是消失。
 * 3. **报错信息不许被静默挤掉**：可疑行按优先级（状态标记 > stderr > 报错 > 警告）排序，
 *    放不下的部分必须以**带上限的摘要**形式点名，而不是只报一个数字。
 * 4. **说明行的数字必须是真的**：字符数取自最终成品的实际差值，而不是中间估计；
 *    行数、原文总长（无损规范化之前）同理。
 *
 * @module dsh-tool-token-optimizer/retain
 */

import { pickSections, sectionsOf } from './sections.js';

/** 省略说明行的前缀，测试与其它工具按它检索。 */
export const ELISION_PREFIX = '[…]';

/** 堆栈帧：形态明确，值得在关键词预筛之前单独判一次。 */
const STACK_FRAME = /^\s+at\s+\S+/;

/** 状态标记行：这次调用到底成功没有，优先级最高。 */
const STATUS_PATTERNS = [
  /^\[(?:exit code|timed out|killed by signal|stopped|stderr|result truncated|output truncated|some output was dropped)[^\]]*\]/,
  /\[exit code:\s*-?\d+\]/,
  /\bexit code\b/i,
];

/** 失败信号：词边界避免误报（`errorRate`、`0 errors` 不算）。 */
const ERROR_PATTERNS = [
  /\b(?:error|failed|failure|fatal|panic|exception|traceback)\b/i,
  // `AssertionError` / `TypeError` 这类**驼峰复合词**里 `\berror\b` 匹配不到，
  // 而它们恰恰是最常见的失败形态（实测：真实语料里 106 行因此漏检）。
  /\w*(?:Error|Exception)\b/,
  /\bnpm ERR!/,
  /\b(?:ELIFECYCLE|MODULE_NOT_FOUND|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|ERR_[A-Z_]+)\b/,
  /^\s*at\s+\S+\s*\(/,
  /^\s*(?:FAIL|FAILED|not ok|panic:|fatal:)\b/,
  // `✗ ✘ ✖` 不是 `\w` 字符，`\b` 在它们和空格之间**不成立**（曾经因此漏检整片
  // 失败清单），所以这类符号单独匹配、不加词边界。
  /^\s*[✗✘✖×]/,
  /^\s*Expected:.*(?:received|actual)/i,
  /^\s*(?:AssertionError|Assertion failed)\b/,
];

/** 警告信号：优先级低于失败信号。 */
const WARN_PATTERNS = [/\b(?:warn|warning|deprecated)\b/i];

/**
 * 便宜的关键词预筛：只有命中它的行才值得去跑上面那十几条正则。
 *
 * 这条预筛决定的是**数量级**：一条 4 万行的结果必须逐行判可疑，12 条正则 × 4 万行
 * 实测约 58 ms；先用一条正则挡掉绝大多数普通行，整体降到几毫秒。
 * 预筛口径是"宁可多放行、绝不漏"——所有可能命中的词根都在里面，
 * 一旦漏词，`test/invariants.test.js` 的信号覆盖用例会立刻失败。
 */
const IMPORTANT_HINT =
  /error|fail|fatal|panic|exception|traceback|warn|deprecat|exit code|stderr|assert|expected|ENOENT|EACCES|EPERM|EEXIST|EISDIR|ENOTDIR|ETIMEDOUT|ECONNREFUSED|MODULE_NOT_FOUND|ELIFECYCLE|ERR_|npm ERR|timed out|killed by signal|stopped|truncated|some output was dropped|not ok|FAIL|✗|✘|✖|×/i;

/**
 * 一行是否“可疑”（需要优先保留）。
 *
 * @param line - 单行文本。
 * @returns `true` 表示这行属于状态标记、stderr、报错或警告。
 */
export function isImportantLine(line) {
  return importantPriority(line) > 0;
}

/**
 * 可疑行的优先级：3 = 状态标记/stderr 头，2 = 报错/堆栈，1 = 警告，0 = 普通行。
 *
 * 预算不够时**先扔警告、后扔报错**——原来只按出现位置（从后往前）取舍，
 * 于是"最后一条 deprecated 警告"会挤掉"最早的 AssertionError"。
 *
 * @param line - 单行文本。
 * @returns 优先级数值。
 */
export function importantPriority(line) {
  if (typeof line !== 'string' || line === '') return 0;
  // 堆栈帧（`  at foo (x.js:1:1)`）不含任何关键词，但它自身形态就足够明确，
  // 单独先判——否则它会被下面的关键词预筛挡掉。
  if (STACK_FRAME.test(line)) return 2;
  // 便宜的关键词预筛：普通行（占绝大多数）在这里就被挡掉。
  if (!IMPORTANT_HINT.test(line)) return 0;
  if (STATUS_PATTERNS.some((pattern) => pattern.test(line))) return 3;
  if (ERROR_PATTERNS.some((pattern) => pattern.test(line))) return 2;
  if (WARN_PATTERNS.some((pattern) => pattern.test(line))) return 1;
  return 0;
}

/**
 * 从中段里挑出要整行保留的可疑行。
 *
 * 与旧实现的区别：不再遇到"第一行放不下"就 `break` 掉整轮（那会让一行超大报错
 * 把**全部**更早的报错一起清零），而是跳过放不下的那一行继续看别的；
 * 排序口径是「优先级降序 + 从后往前」，因此最终报错仍然优先于早期警告。
 *
 * @param middle - 被省略的中段。
 * @param budget - 可疑行总预算（字符）。
 * @returns `{ kept, dropped }`，都是 `{ line, priority, index }`。
 */
function selectImportantLines(middle, budget, alreadyVisible) {
  const candidates = [];
  const lines = middle.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const priority = importantPriority(line);
    if (priority === 0) continue;
    // 头部/尾部已经原样展示了这一行（<content> 信封、命令回显里常出现同一条报错），
    // 再"捞"一次纯属重复计入预算——实测这会让成品超出上界 40%。
    if (alreadyVisible !== undefined && alreadyVisible.has(line)) continue;
    candidates.push({ line, priority, index });
  }
  // 优先级高的先拿预算；同级按“越靠后越是最终结论”排序。
  candidates.sort((left, right) => right.priority - left.priority || right.index - left.index);

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
  // 输出顺序还原为原文顺序，避免出现“第 121 行排在第 55 行前面”这种非单调行号。
  kept.sort((left, right) => left.index - right.index);
  return { kept, dropped };
}

/**
 * 抽出 DSH 自己写在结果里的可恢复路径（中段被裁掉后，这条路径是模型的救命绳）。
 *
 * @param text - 结果全文。
 * @returns 路径字符串，或 `null`。
 */
export function findRecoveryPath(text) {
  if (typeof text !== 'string') return null;
  const truncated = /\[output truncated;\s*full output:\s*([^\]\s]+)\s*\]/.exec(text);
  if (truncated !== null) return truncated[1];
  const stored = /Full formatted result stored at: ([^\s)\]]+)/.exec(text);
  if (stored !== null) return stored[1].replace(/[.,;:]$/, '');
  const grep = /Full grep result stored at: ([^\s)\]]+)/.exec(text);
  if (grep !== null) return grep[1].replace(/[.,;:]$/, '');
  return null;
}

/**
 * 把若干条被挤掉的可疑行压成一行**带上限**的摘要。
 *
 * 只给前几条的名字（截断到约 80 字符），因为其作用不是代替原文，而是让模型知道
 * "中段里还有哪几类失败"，从而决定要不要按取回路径回读。这是把原来只报一个数字的
 * `N error/warning lines … only in the full text` 升级成可判断的信息。
 *
 * @param dropped - `selectImportantLines` 的 `dropped`。
 * @param limit - 摘要行的字符上限。
 * @returns 单行摘要；没有可写内容时返回空串。
 */
function importantDigest(dropped, limit) {
  if (dropped.length === 0 || limit < 24) return '';
  const head = `first dropped: `;
  let out = head;
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

/**
 * 构造省略说明行。
 *
 * 说明里必须同时给出：省掉了多少、为什么可以省、怎么取回。三者缺一，模型就会
 * 重跑工具（省下的 token 又被花回去）。
 *
 * @param options - `chars`（省掉的字符数）、`lines`（省掉的行数）、`total`（原文总字符数）、
 *   `important`（保留下来的可疑行数量）、`importantDropped`（没放下的数量）、
 *   `digest`（没放下的可疑行摘要，可空）、`recovery`（可恢复路径或提示，可为空）。
 * @returns 单行说明（不含首尾换行）。
 */
export function elisionNotice(options) {
  const parts = [`${ELISION_PREFIX} omitted ${options.chars} chars / ${options.lines} lines of ${options.total}`];
  const present = options.importantPresent ?? options.important ?? 0;
  if (present > 0) {
    parts.push(`${present} error/warning lines were in the omitted middle`);
    if (present > (options.important ?? 0)) parts.push(`${options.important} of them kept inline`);
  }
  if (options.importantDropped > 0) {
    parts.push(`${options.importantDropped} error/warning lines did NOT fit the reserve and are only in the full text`);
    if (typeof options.digest === 'string' && options.digest !== '') parts.push(options.digest);
  }
  parts.push(options.recovery ?? 're-run this tool call to get the full text');
  return parts.join('; ');
}

/**
 * 说明行的保守长度上界。
 *
 * 说明文本在选定保留内容**之后**才写得准，而保留内容又受预算约束——直接算会绕成
 * 死循环。这里用"最大位数"估一个上界先扣掉，装配完成后再用真值改写。
 *
 * @param textLength - 原文长度。
 * @returns 预留字符数。
 */
function noticeReserve(textLength) {
  return 200 + String(textLength).length * 3;
}

/**
 * 有界保留正文。
 *
 * @param text - 原文。
 * @param options - `{ maxChars, headRatio, tailRatio, minTailChars, importantBudgetChars, recovery }`。
 * @returns `{ text, changed, omitted, omittedLines, importantKept, importantDropped }`；
 *   `omitted*` 以**最终成品**为准，`omittedLines` 的基准是原文行数。
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

  const originalLines = text.split('\n').length;
  // 说明行里的“of N”必须是**模型看到无损层之前**的原文长度，否则模型按它估算
  // "还剩多少没看"时会低报（实测 4011 字符的原文被写成 4004）。
  const originalChars = options.originalChars ?? text.length;
  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const minTailChars = options.minTailChars ?? 300;

  // 先扣掉说明行（与摘要）的保守上界：剩下的才是真正可以分配给内容的部分。
  const contentBudget = Math.max(0, maxChars - noticeReserve(text.length));
  if (contentBudget < 64) return unchanged;
  // 可疑行预算：占总预算 40%（下限 400、上限三分之一）——它们是"下一步该做什么"的
  // 直接依据，宁可少留几行普通枚举，也不能把报错行整体挤掉。
  //
  // 关键：这 40% 是**从内容预算里扣出来的**，不是加在头部/尾部之上的额外额度。
  // 旧实现把三者相加，于是"预算"变成软目标：实测 143/625 个块越过上界（最大 1.22 倍）。
  const importantBudget = Math.min(
    Math.floor(contentBudget / 3),
    options.importantBudgetChars ?? Math.max(400, Math.floor(contentBudget * 0.4)),
  );
  const sectionBudget = Math.max(0, contentBudget - importantBudget);

  // ---- 1) 结构感知：按结果自身的分段边界切，绝不切开一个单元 ------------------
  const headBudget = Math.max(0, Math.floor(sectionBudget * headRatio));
  const firstLineChars = text.indexOf('\n') === -1 ? text.length : text.indexOf('\n');
  const { units, kind } = sectionsOf(
    text,
    options.tool,
    Math.max(120, Math.floor(sectionBudget / 4)),
    firstLineChars,
  );
  const picked = pickSections(units, sectionBudget, {
    headRatio,
    tailRatio,
    minTailChars,
    keepLast: true,
  });

  // ---- 2) 中段里的可疑行：整行保留，按优先级和预算取舍 ------------------------
  // 中段文本 = 被略去的单元拼接（尾部单元可能因优先级分散在多处，不能按位置推断）。
  const middle = picked.omittedUnitsList.map((unit) => unit.text).join('\n');
  // 头部与尾部已经逐字出现的行不再重复保留。
  const alreadyVisible = new Set();
  for (const line of picked.head.split('\n')) alreadyVisible.add(line);
  for (const line of picked.tail.split('\n')) alreadyVisible.add(line);
  const { kept, dropped } = selectImportantLines(middle, importantBudget, alreadyVisible);

  // ---- 3) 装配 + 真值说明 ----------------------------------------------------
  const head = picked.head.trimEnd();
  const keptText = kept.map((item) => item.line).join('\n');
  const tail = picked.tail.trimStart();
  // 摘要行的额度 = 生成说明行之后**真正剩下**的空间，而不是"总预算减去内容"。
  // 旧算法让摘要顶着预留额写，说明行本身长到 363~457 字符，直接把成品顶出上界。
  const skeleton = [head, keptText, tail].filter((part) => part !== '').join('\n');
  const noticeOverhead = originalChars > 9999 ? 420 : 380;
  const digestLimit = Math.min(160, Math.max(0, maxChars - skeleton.length - noticeOverhead));
  const digest = importantDigest(dropped, digestLimit);

  // 说明行的数字必须自洽：模型真正能核对的是 `omitted chars + 成品长度 == of N`。
  // 但说明文本自身也占字符——"说省了多少"与"成品多长"互为因果。做法是迭代到不动点：
  // 先按骨架估一次 chars，生成说明行、装配、再按**实际**成品长度回填，直到稳定。
  const join = (blocks) => blocks.map((block) => block.text).filter((text) => text !== '').join('\n');
  const noticeBlock = { index: 1.5, text: '' };
  let content = [
    { index: 0, text: head },
    { index: 1, text: keptText },
    noticeBlock,
    { index: 2, text: tail },
  ];
  // 骨架（不含说明行）的长度先量准：`chars = of N - 成品长度` 才是模型能核对的恒等式，
  // 而说明行自己又参与"成品长度"，所以先把说明行抠掉量骨架、再回填。
  const skeletonText = join([content[0], content[1], content[3]]);
  // 说明行的三个数字都要遍扫全文（原文行数、原文长度），一次算好、全程复用；
  // 定型循环里只对**长度做算术**，不重复拼字符串也不重复扫行——实测这两件事
  // 曾占掉一条 1.3 MB 结果 45% 的时间。
  const linesMissing = countMissingLines(text, skeletonText);
  const buildNotice = (chars, keptCount = kept.length, droppedCount = dropped.length) =>
    elisionNotice({
      chars: Math.max(0, chars),
      lines: linesMissing,
      total: originalChars,
      importantPresent: keptCount + droppedCount,
      important: keptCount,
      importantDropped: droppedCount,
      digest,
      recovery: options.recovery,
    });

  // 骨架（不含说明行）长度已知，插回说明行只多出一个换行分隔符。
  let next = '';
  noticeBlock.text = buildNotice(originalChars - skeletonText.length - 1);
  for (let round = 0; round < 3; round += 1) {
    const settled = skeletonText.length + 1;
    const notice = buildNotice(originalChars - settled - noticeBlock.text.length);
    if (notice === noticeBlock.text) break;
    noticeBlock.text = notice;
  }
  next = join(content);

  // 硬上界：真超了就从**尾部里优先级最低的单元**开始摘，绝不牺牲末单元
  // （结论与退出状态比中段枚举重要得多）。
  const tailOrder = [...picked.tailUnitsList].sort(
    (left, right) => left.unit.priority - right.unit.priority || right.index - left.index,
  );
  const tailBlocks = tailOrder.map((entry) => ({ index: 1000 + entry.index, text: entry.unit.text }));
  // 尾部按**原文顺序**重建：状态标记、`[stderr]` 段与结论在原文里的相对次序必须保留
  // （否则模型会看到"第 300 行排在 299 行之前"这种非单调输出）。末单元永远最后。
  const lastBlock = { index: 2, text: picked.lastUnitText };
  const orderedTail = tailBlocks
    .filter((block) => block.text !== picked.lastUnitText)
    .sort((left, right) => left.index - right.index);
  content = [{ index: 0, text: head }, { index: 1, text: keptText }, noticeBlock, ...orderedTail, lastBlock];
  next = join(content);
  // 超界时摘除顺序：**靠前的尾部单元先走**（它们离结论最远，信息密度最低）。
  // 一次性算出要摘多少个，避免"删一个 → 重新 join 全文"的平方级开销
  // （实测曾是 25 秒/条的最坏情形）。
  if (next.length > maxChars) {
    let excess = next.length - maxChars;
    const droppedTail = new Set();
    for (const block of orderedTail) {
      if (excess <= 0) break;
      droppedTail.add(block);
      excess -= block.text.length + 1;
    }
    if (droppedTail.size > 0) {
      content = content.filter((block) => !droppedTail.has(block));
      next = join(content);
    }
  }
  // 仍然超界（说明行 + 末单元就撑满了）：先从说明行里撤掉摘要，再退到逐行裁剪。
  if (next.length > maxChars && noticeBlock.text !== '') {
    const lean = elisionNotice({
      chars: Math.max(0, originalChars - next.length),
      lines: countMissingLines(text, join(content.filter((block) => block !== noticeBlock))),
      total: originalChars,
      importantPresent: kept.length + dropped.length,
      important: kept.length,
      importantDropped: dropped.length,
      recovery: options.recovery,
    });
    if (lean.length < noticeBlock.text.length) {
      noticeBlock.text = lean;
      next = join(content);
    }
  }
  let keptNow = kept;
  if (next.length > maxChars && kept.length > 0) {
    // 极端情形：连"骨架 + 说明行"都放不下。从**优先级最低**的可疑行开始撤，
    // 直到放得下（报错优先于警告的老规矩在这里同样成立）。
    const byPriority = [...kept].sort(
      (left, right) => left.priority - right.priority || left.index - right.index,
    );
    for (const victim of byPriority) {
      if (next.length <= maxChars) break;
      keptNow = keptNow.filter((item) => item !== victim);
      content[1].text = keptNow.map((item) => item.line).join('\n');
      next = join(content);
    }
  }
  // 收尾：修剪过尾部/可疑行之后，说明行的数字要按**最终**成品重算一次，
  // 保证 `omitted chars + 成品长度 == of N` 在最终交付的文本上成立。
  const finalNotice = buildNotice(
    originalChars - next.length,
    keptNow.length,
    dropped.length + (kept.length - keptNow.length),
  );
  if (finalNotice.length <= noticeBlock.text.length) {
    noticeBlock.text = finalNotice;
    next = join(content);
  }

  if (next.length >= text.length) return unchanged;

  return {
    text: next,
    changed: true,
    omitted: text.length - next.length,
    omittedLines: countMissingLines(text, next),
    importantKept: keptNow.length,
    importantDropped: dropped.length + (kept.length - keptNow.length),
    units: kind,
  };
}

/**
 * 数一段文本的行数（空串算 0 行）。
 *
 * @param text - 文本。
 * @returns 行数。
 */
function countLines(text) {
  return text === '' ? 0 : text.split('\n').length;
}

/**
 * 原文里有多少行**没有以完整行的形式**出现在成品中。
 *
 * 这是说明行 `omitted N lines` 的口径：它必须涵盖"整行消失"与"只留下被截断的半行"
 * 两种情形，否则模型按这个数字判断要不要回读时会被低报误导。不做行内容去重，
 * 因为无损层本身会用 `⟨dup ×N⟩` 复原重复。
 *
 * @param originalText - 原文。
 * @param resultText - 成品。
 * @returns 未完整保留的行数。
 */
function countMissingLines(originalText, resultText) {
  const present = new Set(resultText.split('\n'));
  let missing = 0;
  for (const line of originalText.split('\n')) {
    if (!present.has(line)) missing += 1;
  }
  return missing;
}

/**
 * 对一组内容块套用有界保留。
 *
 * 富内容块（图片等）原样保留且不占字符预算：它们不可能被文本裁剪“替代”，
 * 删掉就是真的丢信息。
 *
 * **总预算在块之间分配而不是各自取一份**：每个文本块的输出都不超过分给它的份额，
 * 份额之和 ≤ `maxChars`，所以"插件把一条结果压到 N 字以内"对多块结果同样成立。
 * （旧实现给每块独立取 `max(400, …)`，50 个文本块能产出 6 倍于预算的结果。）
 *
 * @param content - 内容块数组。
 * @param options - `retainMiddle` 的选项，外加 `minBlockChars`（多文本块时的单块最低预算）。
 * @returns `{ content, changed, omittedChars, importantKept, importantDropped }`。
 */
export function retainContent(content, options) {
  const blocks = content ?? [];
  const textBlocks = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string');
  const totalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
  if (totalChars <= options.maxChars) {
    return { content: blocks, changed: false, omittedChars: 0, importantKept: 0, importantDropped: 0 };
  }

  const minBlockChars = options.minBlockChars ?? 400;
  // 先按长度比例分配，再把"够用不完"的份额的余量让给还没分配完的块。
  const budgets = new Map();
  let remaining = options.maxChars;
  for (const block of textBlocks) budgets.set(block, Math.floor((options.maxChars * block.text.length) / totalChars));
  // 份额低于下限的块按比例从其它块匀（只匀一次，避免循环）。
  const share = (block) => budgets.get(block) ?? 0;
  const deficit = textBlocks.reduce((sum, block) => sum + Math.max(0, minBlockChars - share(block)), 0);
  if (deficit > 0) {
    const surplus = textBlocks.reduce((sum, block) => sum + Math.max(0, share(block) - minBlockChars), 0);
    for (const block of textBlocks) {
      if (share(block) >= minBlockChars) continue;
      budgets.set(block, Math.min(minBlockChars, share(block) + Math.floor((deficit * share(block)) / Math.max(1, surplus || 1))));
    }
  }
  const assigned = textBlocks.reduce((sum, block) => sum + budgets.get(block), 0);
  remaining = Math.max(0, options.maxChars - assigned);
  // 把没用完的份额补给最大的块（它最可能有内容被裁掉）。
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
    const result = retainMiddle(block.text, {
      ...options,
      maxChars: Math.max(minBlockChars, budgets.get(block) ?? 0),
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
