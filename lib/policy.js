/**
 * 结果策略：把「无损文本规范化」与「有界保留」合成一条管线，并给出每个工具的
 * 取回提示。
 *
 * 管线顺序（顺序本身是有理由的，不要交换）：
 *
 * 1. **无变换**：`isError` 的结果一个字都不动——失败结果正是模型自我纠错的唯一依据。
 * 2. **无损规范化**（`text.js`）：换行/行尾空白/空行/重复行，全部可逆。
 * 3. **有界保留**（`retain.js`）：超过内联预算时保留头 + 尾 + 可疑行。
 *
 * 每一步之后都有净收益闸门：结果永远不会变大。
 *
 * @module dsh-tool-token-optimizer/policy
 */

import { estimateContent } from './tokens.js';
import { compactText } from './text.js';
import { findRecoveryPath, retainContent } from './retain.js';

/**
 * 每个工具的取回提示。提示要短（它会随每一条被裁剪的结果反复出现在上下文里），
 * 但必须给出**这次调用参数里已经存在**的取回动作，模型才不会为了中段重跑整个工具。
 */
const RECOVERY_HINTS = {
  read: 're-read with offset/limit to see any range',
  bash: 're-run this command (optionally piped) to see any range',
  pwsh: 're-run this command (optionally piped) to see any range',
  grep: 'narrow the pattern or path to see any range',
  glob: 'narrow the pattern to see any range',
  web_fetch: 'fetch a more specific URL to see any range',
  web_search: 'repeat the search with a narrower query',
  cordis_inspect_query: 'query the exact Service/Event/entry to see any range',
  cordis_inspect_list: 'query one exact target to see any range',
  plugin_manager: 'repeat with a narrower action/target',
  job_output: 're-read the job output with a range',
  skill: 're-load the skill to see any range',
  workflow: 're-run the workflow to see any range',
};

/**
 * 单个工具的取回提示。
 *
 * @param tool - 工具名。
 * @returns 提示文本（不含句末标点）。
 */
export function recoveryHint(tool) {
  return RECOVERY_HINTS[tool] ?? `re-run ${tool} to see any range`;
}

/**
 * @typedef {object} PolicyOptions
 * @property {number} inlineChars 单条结果的文本内联预算（字符）。
 * @property {number} triggerRatio 触发倍数：超过 `inlineChars × triggerRatio` 才裁剪。
 * @property {number} headRatio 头部占比。
 * @property {number} tailRatio 尾部占比。
 * @property {number} minTailChars 尾部最少字符数。
 * @property {number} importantBudgetChars 可疑行预算（字符）。未给出时取总预算的 40%。
 * @property {Record<string, number>} toolBudgets 工具级预算覆盖（字符）。
 * @property {number} minBlockChars 多文本块时的单块最少预算（字符）。
 */

/**
 * 对一条工具结果套用策略。
 *
 * @param input - `{ tool, content, isError }`。
 * @param options - 见 {@link PolicyOptions}。
 * @returns `{ content, changed, before, after, savedTokens, steps }`；
 *   `steps` 含 `retain-middle` 表示发生了预算裁剪，含 `important-dropped` 表示有可疑行
 *   没能挤进保留额度（此时说明行里已写明数量与取回方式）。
 */
export function optimizeResult(input, options) {
  const content = Array.isArray(input.content) ? input.content : [];
  const before = estimateContent(content);
  const unchanged = { content, changed: false, before, after: before, savedTokens: 0, steps: [], units: 'none' };
  if (input.isError === true) return unchanged;
  if (content.length === 0) return unchanged;
  const hasText = content.some((block) => block?.type === 'text' && typeof block.text === 'string');
  if (!hasText) return unchanged;

  const steps = new Set();
  let units = 'none';
  let working = [];
  // 无损层会把 CRLF、多余空行、重复行折掉；说明行要报的是**折掉之前**的原文长度，
  // 所以按块记下原始字符数，随新块对象一起传递。
  const originalChars = new WeakMap();
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      working.push(block);
      continue;
    }
    const lossless = compactText(block.text, options.text);
    if (lossless.changed) {
      for (const step of lossless.steps) steps.add(step);
      const next = { ...block, text: lossless.text };
      originalChars.set(next, block.text.length);
      working.push(next);
    } else {
      working.push(block);
    }
  }

  const budget = options.toolBudgets?.[input.tool] ?? options.inlineChars;
  const triggerRatio = options.triggerRatio ?? 1;
  const totalChars = working
    .filter((block) => block?.type === 'text')
    .reduce((sum, block) => sum + block.text.length, 0);
  if (totalChars > budget * triggerRatio && budget > 0) {
    const recovery = findRecoveryPath(
      working.map((block) => (block?.type === 'text' ? block.text : '')).join('\n'),
    );
    const retained = retainContent(working, {
      // 工具名决定按哪套结构边界切分（bash 的 [stderr]/状态标记、grep 的文件分组）
      tool: input.tool,
      maxChars: budget,
      headRatio: options.headRatio,
      tailRatio: options.tailRatio,
      minTailChars: options.minTailChars,
      importantBudgetChars: options.importantBudgetChars,
      minBlockChars: options.minBlockChars,
      // 说明行的数字统一用**无损层之前**的原文长度，模型据此判断"还剩多少没看"。
      originalChars,
      recovery: recovery === null ? recoveryHint(input.tool) : `full text: ${recovery}`,
    });
    if (retained.changed) {
      steps.add('retain-middle');
      if (retained.importantDropped > 0) steps.add('important-dropped');
      if (typeof retained.units === 'string') units = retained.units;
      working = retained.content;
    }
  }

  const after = estimateContent(working);
  if (after >= before) return unchanged;
  return { content: working, changed: true, before, after, savedTokens: before - after, steps: [...steps], units };
}

/**
 * 估算一条文本在给定预算下的最终 token 数（用于回放与调参，不参与运行时决策）。
 *
 * @param text - 文本。
 * @param tool - 工具名。
 * @param options - 见 {@link PolicyOptions}。
 * @returns `{ before, after, saved }`。
 */
export function priceText(text, tool, options) {
  const before = estimateContent([{ type: 'text', text }]);
  const result = optimizeResult({ tool, content: [{ type: 'text', text }], isError: false }, options);
  const after = estimateContent(result.content);
  return { before, after, saved: before - after };
}
