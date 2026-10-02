/**
 * 配置 schema 测试：插件自带 Standard Schema 实现，因此它在**没有 zod 的环境里**
 * （profile 侧安装的真实情况）也必须给出确定、可诊断的校验结果。
 *
 * @module dsh-tool-token-optimizer/test/schema
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Config, apply } from '../lib/index.js';
import { array, boolean, number, object, record, string } from '../lib/schema.js';

const validate = (value) => Config['~standard'].validate(value);

test('Config 暴露 Standard Schema v1 契约', () => {
  const standard = Config['~standard'];
  assert.equal(standard.version, 1);
  assert.equal(typeof standard.validate, 'function');
  assert.equal(typeof standard.vendor, 'string');
});

test('空配置得到全部默认值', () => {
  const result = validate(undefined);
  assert.equal(result.issues, undefined);
  assert.deepEqual(result.value, {
    enabled: true,
    inlineChars: 1600,
    triggerRatio: 1,
    headRatio: 0.55,
    tailRatio: 0.35,
    minTailChars: 300,
    importantBudgetRatio: 0.4,
    toolBudgets: {},
    skipTools: [],
    logSavings: false,
  });
});

test('未知键被拒绝并列出允许的键', () => {
  const result = validate({ inlineChars: 800, oops: 1 });
  assert.ok(Array.isArray(result.issues));
  assert.match(result.issues[0].message, /unknown keys: oops/);
  assert.match(result.issues[0].message, /inlineChars/);
});

test('越界与类型错误被拒绝并给出字段名', () => {
  assert.match(validate({ inlineChars: -1 }).issues[0].message, /inlineChars must be ≥ 0/);
  assert.match(validate({ inlineChars: 1.5 }).issues[0].message, /must be an integer/);
  assert.match(validate({ triggerRatio: 0.5 }).issues[0].message, /triggerRatio must be ≥ 1/);
  assert.match(validate({ headRatio: 2 }).issues[0].message, /headRatio must be ≤ 1/);
  assert.match(validate({ logSavings: 'yes' }).issues[0].message, /logSavings must be a boolean/);
  assert.match(validate({ skipTools: [1] }).issues[0].message, /skipTools\[0\] must be a string/);
  assert.match(validate({ toolBudgets: { read: 'big' } }).issues[0].message, /toolBudgets\.read/);
  assert.match(validate('nope').issues[0].message, /config must be an object/);
});

test('合法覆盖被保留，未给出的字段补默认值', () => {
  const result = validate({ inlineChars: 800, toolBudgets: { read: 4000 }, skipTools: ['present'] });
  assert.equal(result.issues, undefined);
  assert.equal(result.value.inlineChars, 800);
  assert.deepEqual(result.value.toolBudgets, { read: 4000 });
  assert.deepEqual(result.value.skipTools, ['present']);
  assert.equal(result.value.headRatio, 0.55, '未给出的字段必须补默认值');
});

test('默认值返回的是副本：改一次不会污染下一次', () => {
  const first = validate(undefined).value;
  first.toolBudgets.read = 999;
  first.skipTools.push('read');
  const second = validate(undefined).value;
  assert.deepEqual(second.toolBudgets, {});
  assert.deepEqual(second.skipTools, []);
});

test('即使配置未经校验，apply 也能用兜底默认值工作', async () => {
  const listeners = [];
  const ctx = {
    on: (event, handler) => listeners.push({ event, handler }),
    effect() {},
    inject() {},
    logger: {},
  };
  apply(ctx, undefined);
  apply(ctx, { inlineChars: 'not-a-number' });
  const handlers = listeners.filter((item) => item.event === 'tools/post-execute');
  assert.equal(handlers.length, 2, '两次装配各注册一份 post-execute');
  const text = 'x'.repeat(20000);
  for (const { handler } of handlers) {
    const decision = await handler({ name: 'bash' }, { isError: false, content: [{ type: 'text', text }] }, async () => ({
      kind: 'accept',
    }));
    assert.equal(decision.kind, 'accept');
    assert.ok(decision.content[0].text.length < text.length, '兜底默认值必须仍然生效');
  }
});

test('enabled: false 是唯一能让插件完全不生效的开关', async () => {
  const listeners = [];
  const ctx = {
    on: (event, handler) => listeners.push({ event, handler }),
    inject() {},
    effect() {},
    logger: {},
    agents: { list: () => [] },
  };
  apply(ctx, { enabled: false });
  assert.equal(listeners.length, 0, '关闭时不得注册任何监听器');
  const text = 'x'.repeat(20000);
  apply(ctx, {});
  const handler = listeners.find((item) => item.event === 'tools/post-execute').handler;
  const decision = await handler({ name: 'bash' }, { isError: false, content: [{ type: 'text', text }] }, async () => ({
    kind: 'accept',
  }));
  assert.ok(decision.content[0].text.length < text.length);
});

test('基础字段构造器行为正确', () => {
  assert.equal(number({ default: 3 }).validate(undefined, 'f').value, 3);
  assert.equal(boolean({ default: true }).validate(undefined, 'f').value, true);
  assert.equal(string().validate('a', 'f').value, 'a');
  assert.deepEqual(array(string(), { default: [] }).validate(undefined, 'f').value, []);
  assert.deepEqual(record(number(), { default: {} }).validate({ a: 1 }, 'f').value, { a: 1 });
  assert.deepEqual(object({ a: number({ default: 1 }) }, { default: {} }).validate(undefined, 'f').value, { a: 1 });
  assert.ok(number({ default: 1 }).validate('x', 'f').issues !== undefined);
});
