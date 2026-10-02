/**
 * 与 DSH 官方 token 计量完全同构的估算器。
 *
 * 复刻 `@deepseek-ai/dsh-token-meter/lib/types/estimate.js`：整个插件内部所有
 * “省了多少”的判定都用**同一个**函数，因此插件自己的决策、单元测试和实测
 * 报告三者口径一致，不存在“测试里省了、线上没省”的偏差。
 *
 * 硬约束（来自官方估计器）：
 * - 文本按 **UTF-16 code unit 数 / 4 向上取整**，再加 4 的块开销；
 * - 工具表按 `JSON.stringify(tools)` 的长度 / 4 向上取整，再加 4。
 *
 * 这里不 import 官方包：插件按 `link:` 装进 profile，只能确定解析到
 * `zod`/`node:*`，不保证解析到 `@deepseek-ai/*`。数值口径靠测试锁定。
 *
 * @module dsh-tool-token-optimizer/tokens
 */

/** 官方估计器使用的换算系数。 */
export const CHARS_PER_TOKEN = 4;

/** 每个内容块固定开销。 */
export const BLOCK_OVERHEAD = 4;

/**
 * 一段文本的估算 token 数（不含块开销）。
 *
 * @param text - 任意文本。
 * @returns 估算 token 数；非字符串按空串处理。
 */
export function estimateText(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * 一个内容块的估算 token 数。
 *
 * 只覆盖插件会遇到的两种块：`text` 与 `tool-call`；其余类型按
 * `JSON.stringify` 长度估算（与官方 `estimateBlock` 一致）。
 *
 * @param block - 内容块。
 * @returns 估算 token 数。
 */
export function estimateBlock(block) {
  if (block === null || typeof block !== 'object') return 0;
  if (block.type === 'text' || block.type === 'reasoning') {
    return estimateText(String(block.text ?? '')) + BLOCK_OVERHEAD;
  }
  if (block.type === 'tool-call') {
    return (
      estimateText(String(block.name ?? '')) +
      estimateText(JSON.stringify(block.arguments ?? {})) +
      BLOCK_OVERHEAD
    );
  }
  return BLOCK_OVERHEAD + estimateText(JSON.stringify(block));
}

/**
 * 一组内容块的估算 token 数。
 *
 * @param content - 内容块数组。
 * @returns 估算 token 数；非数组返回 0。
 */
export function estimateContent(content) {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) total += estimateBlock(block);
  return total;
}
