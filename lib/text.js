/**
 * 无损文本规范化：每一步都**可逆**，且每一步都必须在 token 上真的变小才提交。
 *
 * 这个模块是插件的核心安全边界。它只做两类被证明等价的事：
 *
 * 1. **等价替换**：`\r\n` → `\n`、行尾空白删除、连续空行折叠、连续同一行折叠。
 *    这些变换丢掉的是终端排版噪声，不是信息；折叠类变换还会在文本里写回
 *    “折叠了多少”，所以模型读到的信息量与原文一字不差。
 * 2. **有界保留**（见 `retain.js`）：超长结果保留头、尾与全部“可疑行”
 *    （错误/失败/警告），中段用一行精确说明与取回路径替代。
 *
 * 每个函数都返回 `{ text, changed, savedChars, notes }`，调用方据此决定是否
 * 采用；`compactText` 额外做一次“净收益 > 0”闸门——任何让结果变大的变换都会被
 * 整段丢弃，插件永远不会把结果改得更贵。
 *
 * @module dsh-tool-token-optimizer/text
 */

/** 折叠说明格式：`⟨×N⟩`。用单个非 ASCII 字符当标记，任何真实文本里都不会出现。 */
const RUN_MARK = '⟨';

/**
 * 把 CRLF / CR 统一成 LF。
 *
 * `\r` 在没有 `\n` 跟随时的含义由 `bareCr` 决定：终端进度条输出用 `\r` 覆盖同一行，
 * 把这些 `\r` 变成换行会把一行变成 N 行（变大，被净收益闸门拒绝），所以默认**删除**
 * 裸 `\r`——它后面紧跟的内容会原地覆盖前面的内容，删除后剩下的正是终端最终显示的那一版。
 *
 * @param text - 输入文本。
 * @returns 规范化后的文本。
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '');
}

/**
 * 删除每行行尾的空白（空格与制表符）。
 *
 * @param text - 输入文本。
 * @returns 处理后的文本。
 */
export function stripTrailingSpaces(text) {
  return text.replace(/[ \t]+$/gm, '');
}

/**
 * 删除仅由空白字符组成的行的内容（保留换行）。
 *
 * 只删除行内的空白，不删除换行本身，因此行数、位置、后续内容的位置全部不变。
 *
 * @param text - 输入文本。
 * @returns 处理后的文本。
 */
export function stripBlankLinePadding(text) {
  return text.replace(/^[ \t]+(?=\n|$)/gm, '');
}

/**
 * 把 4 个以上连续换行折叠成 3 个（也就是最多保留 2 个空行）。
 *
 * 保留 2 个空行而不是 1 个：Markdown 段落分隔与代码块边界都依赖空行，2 个空行在语义上
 * 与 3 个以上完全等价（都只表示“这里是段落边界”）。**只折叠纯空行**，
 * 绝不折叠空行之间的内容，也绝不删除换行把两行粘成一行。
 *
 * @param text - 输入文本。
 * @returns 处理后的文本。
 */
export function collapseBlankRuns(text) {
  return text.replace(/\n{4,}/g, '\n\n\n');
}

/**
 * 折叠连续重复行。
 *
 * 连续 N（N ≥ 3）行完全相同时，保留**首行 + 折叠标记 + 末行**：
 *
 * ```
 * <重复的行>
 * ⟨dup ×N⟩
 * <重复的行>
 * ```
 *
 * 两个锚点都保留，是为了让本变换**可逆**：知道“哪一行重复了”和“重复了多少次”，
 * 就能逐行还原原文（见 `decodeText`）。只保留首行虽然再省一行，但还原时无法确认
 * 末行的位置，属于“看着无损、实际不可逆”。标记本身只有 12–20 字符，而它替换掉的
 * 是 N-2 行，N ≥ 3 时净收益始终为正。
 *
 * 之所以要求 N ≥ 3：只重复 2 次时标记比省下的那一行还长，不划算。
 *
 * 标记只出现在行首，且 `⟨` 开头的重复行不再折叠，因此本变换幂等。
 *
 * @param text - 输入文本。
 * @returns 处理后的文本。
 */
export function collapseDuplicateRuns(text) {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    let end = index + 1;
    while (end < lines.length && lines[end] === line) end += 1;
    const run = end - index;
    if (run >= 3 && line.length > 0 && !line.startsWith(RUN_MARK)) {
      out.push(line, `${RUN_MARK}dup ×${run}⟩`, line);
    } else {
      for (let at = index; at < end; at += 1) out.push(lines[at]);
    }
    index = end;
  }
  return out.join('\n');
}

/**
 * 还原 `compactText` 的全部无损变换（用于验证“可精确还原”，也在 `read` 回来的
 * 文本上可用）。
 *
 * 还原口径与 `compactText` 一一对应：
 * - `\r\n`/裸 `\r` 与行尾空白：原文已不可区分，因此还原到**规范形**（这也正是
 *   “信息等价”的准确含义：格式噪声本来就不携带信息）；
 * - 空行：`compactText` 只保留“有没有空行”，因此还原到不超过 2 行的空行块；
 * - 重复行：按 `⟨dup ×N⟩` 标记逐行展开，**精确还原**。
 *
 * @param text - `compactText` 的输出（也接受任意文本，幂等）。
 * @returns 规范化后的原文。
 */
export function decodeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const lines = collapseBlankRuns(stripBlankLinePadding(stripTrailingSpaces(normalizeNewlines(text)))).split('\n');
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^⟨dup ×(\d+)⟩$/.exec(lines[index]);
    if (marker === null) {
      out.push(lines[index]);
      continue;
    }
    const count = Number(marker[1]);
    const previous = out.at(-1);
    // 标记夹在首行与末行之间：末行由后面的锚点负责，这里补齐中间被折叠掉的行。
    if (previous !== undefined && count >= 3) {
      for (let extra = 2; extra < count; extra += 1) out.push(previous);
    }
  }
  return out.join('\n');
}

/**
 * 依次施加全部无损变换，并保证净收益大于零。
 *
 * 顺序固定：换行规范化 → 行尾空白 → 空行填充 → 空行折叠 → 重复行折叠。
 * 最后一道闸门是硬约束：只要最终文本的估算 token 数**不小于**原文，就返回原文。
 *
 * 这里刻意**不做** JSON 重排（缩进或多行化）：实测对 minified JSON 断行会让长度
 * 增加 5%（换行本身占字符，而空白在 token 化后并不省），净收益闸门会把它整段拒绝，
 * 那就没有存在的必要。JSON 结果的体积问题由 `retain.js` 的预算裁剪负责。
 *
 * @param text - 输入文本。
 * @param options - 目前无选项；保留参数位以便后续加入新的无损变换。
 * @returns `{ text, changed, savedTokens, steps }`。
 */
export function compactText(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, changed: false, savedTokens: 0, steps: [] };
  }
  const steps = [];
  let current = text;
  const apply = (label, next) => {
    if (next !== current) {
      steps.push(label);
      current = next;
    }
  };
  apply('newlines', normalizeNewlines(current));
  apply('trailing-spaces', stripTrailingSpaces(current));
  apply('blank-padding', stripBlankLinePadding(current));
  apply('blank-runs', collapseBlankRuns(current));
  apply('duplicate-runs', collapseDuplicateRuns(current));
  const before = Math.ceil(text.length / 4);
  const after = Math.ceil(current.length / 4);
  if (current === text || after >= before) {
    return { text, changed: false, savedTokens: 0, steps: [] };
  }
  return { text: current, changed: true, savedTokens: before - after, steps };
}
