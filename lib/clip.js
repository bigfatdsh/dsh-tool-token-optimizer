/**
 * 边界安全的截断：只在"码点边界"落刀，并留下**可看见**的省略标记。
 *
 * 两条硬约束：
 * 1. 绝不把一行切成两半却不说话 —— 任何被切的文本都带 `⟨…⟩` 标记，
 *    模型能一眼看出"这里少了多少"，不会把片段当完整内容读。
 * 2. 绝不切断代理对 —— 从中间切 emoji 会产生孤立代理符，落进 JSON 就是替换符。
 *
 * @module dsh-tool-token-optimizer/clip
 */

/** 省略标记的前缀字符；`⟨` 不会被任何工具输出当成结构。 */
export const CLIP_OPEN = '⟨';
export const CLIP_CLOSE = '⟩';

/**
 * 把索引退到安全的码点边界（不切开代理对）。
 *
 * @param text - 文本。
 * @param index - 期望切点。
 * @returns 安全切点。
 */
export function safeIndex(text, index) {
  if (index <= 0) return 0;
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  // 低位代理 = 切点落在代理对中间，退一格。
  if (code >= 0xdc00 && code <= 0xdfff) return index - 1;
  return index;
}

/**
 * 保留开头，末尾加 `⟨…+N⟩` 标记。
 *
 * @param text - 原文。
 * @param budget - 成品最大长度（含标记）。小于标记长度时只返回标记。
 * @returns `{ text, clipped }`，`clipped` 是被丢掉的字符数。
 */
export function clipHead(text, budget) {
  if (budget <= 0) return { text: '', clipped: text.length };
  if (text.length <= budget) return { text, clipped: 0 };
  let keep = Math.max(0, budget - 14);
  for (let round = 0; round < 3; round += 1) {
    const dropped = text.length - keep;
    const marker = ` ${CLIP_OPEN}…+${dropped}${CLIP_CLOSE}`;
    const next = Math.max(0, budget - marker.length);
    if (next === keep) break;
    keep = next;
  }
  const cut = safeIndex(text, Math.min(keep, text.length));
  const dropped = text.length - cut;
  if (dropped <= 0) return { text: text.slice(0, cut), clipped: 0 };
  const marker = ` ${CLIP_OPEN}…+${dropped}${CLIP_CLOSE}`;
  return { text: text.slice(0, cut) + marker, clipped: dropped };
}

/**
 * 保留结尾，开头加 `⟨N…⟩` 标记。
 *
 * @param text - 原文。
 * @param budget - 成品最大长度（含标记）。
 * @returns `{ text, clipped }`。
 */
export function clipTail(text, budget) {
  if (budget <= 0) return { text: '', clipped: text.length };
  if (text.length <= budget) return { text, clipped: 0 };
  let keep = Math.max(0, budget - 14);
  for (let round = 0; round < 3; round += 1) {
    const dropped = text.length - keep;
    const marker = `${CLIP_OPEN}+${dropped}…${CLIP_CLOSE} `;
    const next = Math.max(0, budget - marker.length);
    if (next === keep) break;
    keep = next;
  }
  const cut = safeIndex(text, Math.max(0, text.length - keep));
  const dropped = cut;
  if (dropped <= 0) return { text: text.slice(cut), clipped: 0 };
  const marker = `${CLIP_OPEN}+${dropped}…${CLIP_CLOSE} `;
  return { text: marker + text.slice(cut), clipped: dropped };
}

/**
 * 检测文本里是否已经有本插件写的省略标记（幂等保护）。
 *
 * @param text - 文本。
 * @returns 是否已裁剪过。
 */
export function hasElisionMark(text) {
  return typeof text === 'string' && text.includes('[…] omitted ');
}

/**
 * 一道预算同时保住「开头」和「结尾」：中间用 `⟨…+N…⟩` 标记。
 *
 * 用在"最后一行自己就超过尾部预算"的场合——结论通常写在行首，而行尾又必须是真的结尾。
 *
 * @param text - 原文。
 * @param budget - 成品最大长度（含标记）。
 * @param prefixShare - 开头占比。
 * @returns `{ text, clipped }`。
 */
export function clipBoth(text, budget, prefixShare = 0.55) {
  if (budget <= 0) return { text: '', clipped: text.length };
  if (text.length <= budget) return { text, clipped: 0 };
  const room = Math.max(8, budget - 16);
  let prefix = Math.floor(room * prefixShare);
  let suffix = room - prefix;
  for (let round = 0; round < 3; round += 1) {
    const dropped = text.length - prefix - suffix;
    const marker = `${CLIP_OPEN}…+${dropped}…${CLIP_CLOSE}`;
    const next = Math.max(8, budget - marker.length);
    if (next === room) break;
    prefix = Math.floor(next * prefixShare);
    suffix = next - prefix;
  }
  const headEnd = safeIndex(text, Math.max(0, prefix));
  const tailStart = safeIndex(text, Math.min(text.length, text.length - Math.max(0, suffix)));
  if (tailStart <= headEnd) return clipHead(text, budget);
  const dropped = tailStart - headEnd;
  const marker = `${CLIP_OPEN}…+${dropped}…${CLIP_CLOSE}`;
  return { text: text.slice(0, headEnd) + marker + text.slice(tailStart), clipped: dropped };
}
