/**
 * 消息级计价：官方 `dsh-token-meter` 估计器的同构实现。
 *
 * 与 `tokens.js` 的分工：`tokens.js` 只算内容块，本模块算“一次请求里的一条消息”
 * 与“整张工具表”，口径逐行对齐官方实现（message + 4、system 不加块开销、
 * 工具表 JSON 长度 / 4 + 4）。
 *
 * @module dsh-tool-token-optimizer/message
 */

import { BLOCK_OVERHEAD, CHARS_PER_TOKEN, estimateBlock } from './tokens.js';

/** 每条消息的固定开销（官方 `ROLE_OVERHEAD`）。 */
export const ROLE_OVERHEAD = 4;

/**
 * 一组内容块的估算 token 数（官方 `estimateContent` 同构）。
 *
 * @param content - 内容块数组。
 * @returns 估算 token 数。
 */
export function estimateContent(content) {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) total += estimateBlock(block);
  return total;
}

/**
 * 一条消息的估算 token 数。
 *
 * system 消息按纯字符串计价（不加块开销），其余消息 = 内容 + {@link ROLE_OVERHEAD}。
 *
 * @param message - `{ role, content }`。
 * @returns 估算 token 数。
 */
export function estimateMessage(message) {
  if (message === null || typeof message !== 'object') return 0;
  const content = message.content ?? [];
  if (message.role === 'system') {
    let chars = 0;
    for (const block of content) {
      if (block?.type === 'text') chars += block.text.length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN) + ROLE_OVERHEAD;
  }
  return estimateContent(content) + ROLE_OVERHEAD;
}

/**
 * 工具表的估算 token 数。
 *
 * @param header - `{ tools }`。
 * @returns 估算 token 数。
 */
export function estimateToolsTokens(header) {
  const tools = header?.tools;
  if (!Array.isArray(tools) || tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}
