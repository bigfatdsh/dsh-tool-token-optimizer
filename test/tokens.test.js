/**
 * 计价口径测试：锁定与官方 `@deepseek-ai/dsh-token-meter` 完全一致的换算规则。
 *
 * 这些断言是整套“省量报告”的可信度基础——如果这里与官方口径偏离，回放报告里的
 * 百分比就只是另一套算法的自说自话。规则取自官方 `lib/types/estimate.js`：
 * 文本 = `ceil(UTF-16 length / 4) + 4`，system 消息不加块开销，
 * 工具表 = `ceil(JSON.stringify(tools).length / 4) + 4`。
 *
 * @module dsh-tool-token-optimizer/test/tokens
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { BLOCK_OVERHEAD, CHARS_PER_TOKEN, estimateBlock, estimateContent, estimateText } from '../lib/tokens.js';
import { ROLE_OVERHEAD, estimateMessage, estimateToolsTokens } from '../lib/message.js';

test('常量与官方一致', () => {
  assert.equal(CHARS_PER_TOKEN, 4);
  assert.equal(BLOCK_OVERHEAD, 4);
  assert.equal(ROLE_OVERHEAD, 4);
});

test('estimateText 用 UTF-16 长度除以 4 向上取整', () => {
  assert.equal(estimateText(''), 0);
  assert.equal(estimateText('abc'), 1);
  assert.equal(estimateText('abcd'), 1);
  assert.equal(estimateText('abcde'), 2);
  // 非字符串按空处理，绝不抛错（插件路径上不能因为脏数据中断工具调用）。
  assert.equal(estimateText(undefined), 0);
  assert.equal(estimateText(123), 0);
});

test('estimateBlock 对 text/reasoning 加 4 的块开销', () => {
  assert.equal(estimateBlock({ type: 'text', text: 'abcdefgh' }), 2 + BLOCK_OVERHEAD);
  assert.equal(estimateBlock({ type: 'reasoning', text: 'abcdefgh' }), 2 + BLOCK_OVERHEAD);
  assert.equal(estimateBlock({ type: 'text' }), BLOCK_OVERHEAD);
});

test('estimateBlock 对 tool-call 按 name + arguments 计价', () => {
  const block = { type: 'tool-call', name: 'bash', arguments: { command: 'ls' } };
  const expected = Math.ceil(4 / 4) + Math.ceil(JSON.stringify({ command: 'ls' }).length / 4) + BLOCK_OVERHEAD;
  assert.equal(estimateBlock(block), expected);
});

test('estimateBlock 对未知块类型退化为 JSON 长度', () => {
  const block = { type: 'image', attachment: { id: 'x' } };
  assert.equal(estimateBlock(block), BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / 4));
});

test('estimateContent 逐块累加', () => {
  const content = [
    { type: 'text', text: 'abcdefgh' },
    { type: 'text', text: 'abcdefgh' },
  ];
  assert.equal(estimateContent(content), 2 * (2 + BLOCK_OVERHEAD));
  assert.equal(estimateContent([]), 0);
  assert.equal(estimateContent(undefined), 0);
});

test('estimateMessage：system 按纯字符串，其余加角色开销', () => {
  const content = [{ type: 'text', text: 'x'.repeat(40) }];
  assert.equal(estimateMessage({ role: 'system', content }), 10 + ROLE_OVERHEAD);
  assert.equal(estimateMessage({ role: 'user', content }), 10 + BLOCK_OVERHEAD + ROLE_OVERHEAD);
  assert.equal(estimateMessage(null), 0);
});

test('estimateToolsTokens 按工具表 JSON 长度计价', () => {
  const tools = [{ name: 'bash', description: 'run', parameters: { type: 'object' } }];
  assert.equal(estimateToolsTokens({ tools }), Math.ceil(JSON.stringify(tools).length / 4) + BLOCK_OVERHEAD);
  assert.equal(estimateToolsTokens({ tools: [] }), 0);
  assert.equal(estimateToolsTokens({}), 0);
});

test('中文按 UTF-16 码元计数（与官方同口径，不做码点换算）', () => {
  // 官方实现直接用 String.length，因此一个汉字算 1 个码元、一个 emoji 算 2 个。
  assert.equal(estimateText('中文四字'), 1);
  assert.equal(estimateText('😀'), 1);
});
