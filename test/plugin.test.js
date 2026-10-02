/**
 * 插件集成测试：把 `apply` 装到一个最小的 Cordis 风格上下文上，验证
 * `tools/post-execute` 监听器的真实行为——包括最关键的“绝不伤害工具调用本身”。
 *
 * 这里刻意复刻宿主的**作用域结构**：根上一个处理器，每个 agent 一个作用域处理器，
 * 二者共享同一个处理器实例。DSH 的 agent 作用域是隔离的，`tools/post-execute` 只在
 * agent 作用域派发，所以“每 agent 装一次”是必需的，而不是可选优化。
 *
 * @module dsh-tool-token-optimizer/test/plugin
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject } from '../lib/index.js';

/**
 * 最小上下文：只实现本插件用到的东西（`on`、`effect`、`inject`、`agents`、`logger`）。
 *
 * `inject(['tools'], cb)` 把回调挂起，直到测试主动触发——与 Cordis 在服务就绪前
 * 不执行回调的语义一致。
 */
function createContext({ agents = [] } = {}) {
  const listeners = [];
  const logs = [];
  const disposers = [];
  const injected = [];
  return {
    listeners,
    logs,
    injected,
    agents: { list: () => agents },
    on(event, handler, options) {
      listeners.push({ event, handler, options });
      return () => {};
    },
    inject(services, callback) {
      injected.push({ services, callback });
      return { dispose: async () => {} };
    },
    effect(register, label) {
      disposers.push({ label, dispose: register() });
      return () => {};
    },
    logger: {
      info: (message) => logs.push({ level: 'info', message }),
      warn: (message) => logs.push({ level: 'warn', message }),
    },
    /** 触发一次 `agent/created`，返回该 agent 自己的作用域上下文。 */
    createAgent(agent) {
      for (const item of listeners.filter((entry) => entry.event === 'agent/created')) item.handler({ agent });
      return agent.ctx;
    },
    /** 取根作用域的 `tools/post-execute` 处理器。 */
    rootHandler() {
      return listeners.find((item) => item.event === 'tools/post-execute')?.handler;
    },
    /** 取某个 agent 作用域已装好的 `tools/post-execute` 处理器。 */
    scopedHandler(agentCtx) {
      return agentCtx.listeners.find((item) => item.event === 'tools/post-execute')?.handler;
    },
    dispose() {
      for (const item of disposers) item.dispose();
    },
  };
}

/** 造一个 agent 作用域上下文（`inject(['tools'], …)` 被立刻兑现）。 */
function createAgentContext(id) {
  const listeners = [];
  const logs = [];
  return {
    id,
    listeners,
    logs,
    on(event, handler, options) {
      listeners.push({ event, handler, options });
    },
    effect(register) {
      register();
    },
    inject(services, callback) {
      callback(this);
      return { dispose: async () => {} };
    },
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
  };
}

/** 造一个 agent 对象（宿主的 agent 上暴露 `ctx` 与 `id`）。 */
function createAgent(id) {
  return { id, ctx: createAgentContext(id) };
}

/** 构造一个成功结果。 */
function okResult(text, extra = {}) {
  return { isError: false, content: [{ type: 'text', text }], ...extra };
}

const bigText = (label, lines) =>
  Array.from({ length: lines }, (_, index) => `${label} line ${index} ${'x'.repeat(60)}`).join('\n');

/** 复刻 waterfall 调用：`next()` 是下游（默认“原样接受”）。 */
const run = (handler, exec, result, nextDecision = { kind: 'accept' }) =>
  handler(exec, result, async () => nextDecision);

test('插件只声明 agents 依赖，不依赖 tools 服务', () => {
  assert.deepEqual(inject, ['agents']);
});

test('根与 agent 作用域都会注册 post-execute，且都是 prepend', () => {
  const ctx = createContext();
  apply(ctx, {});
  const rootListeners = ctx.listeners.filter((item) => item.event === 'tools/post-execute');
  assert.equal(rootListeners.length, 1);
  assert.equal(rootListeners[0].options.prepend, true);

  const agent = createAgent('session-abcdef12');
  const agentCtx = ctx.createAgent(agent);
  const scoped = agentCtx.listeners.filter((item) => item.event === 'tools/post-execute');
  assert.equal(scoped.length, 1, 'agent 作用域必须装一份');
  assert.equal(scoped[0].options.prepend, true);
});

test('插件晚于 agent 启动时，也会补装已存在的 agent', () => {
  const agent = createAgent('session-existing');
  const ctx = createContext({ agents: [agent] });
  apply(ctx, {});
  assert.equal(agent.ctx.listeners.filter((item) => item.event === 'tools/post-execute').length, 1);
});

test('同一 agent 收到多次 created 事件只装一次', () => {
  const ctx = createContext();
  apply(ctx, {});
  const agent = createAgent('session-once');
  ctx.createAgent(agent);
  ctx.createAgent(agent);
  assert.equal(agent.ctx.listeners.filter((item) => item.event === 'tools/post-execute').length, 1);
});

test('agent 作用域处理器裁剪大结果，并给出取回路径', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 1200 });
  const agent = createAgent('session-trim');
  const handler = ctx.scopedHandler(ctx.createAgent(agent));
  const result = okResult(bigText('body', 400));
  const decision = await run(handler, { name: 'bash' }, result);
  assert.equal(decision.kind, 'accept');
  const text = decision.content.map((block) => block.text).join('');
  assert.ok(text.length < result.content[0].text.length);
  assert.equal(text.includes('[…] omitted'), true);
  assert.equal(text.includes('re-run this command'), true);
});

test('小结果完全不动，且不产生任何决策变更', async () => {
  const ctx = createContext();
  apply(ctx, {});
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult('hello\nworld'));
  assert.deepEqual(decision, { kind: 'accept' });
});

test('同一条结果被根与 agent 两处注册同时命中时只处理一次', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 1200 });
  const agent = createAgent('session-both');
  const scoped = ctx.scopedHandler(ctx.createAgent(agent));
  const root = ctx.rootHandler();
  const result = okResult(bigText('body', 400));
  const first = await run(root, { name: 'bash' }, result);
  const second = await run(scoped, { name: 'bash' }, result);
  assert.equal(first.content[0].text.includes('[…] omitted'), true);
  assert.deepEqual(second, { kind: 'accept' }, '第二次必须放行，不能二次压缩');
  assert.equal(ctx.toolTokenOptimizerStats.snapshot().optimized, 1);
});

test('失败结果一个字都不动', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 200 });
  const text = bigText('error', 400);
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, { isError: true, content: [{ type: 'text', text }] });
  assert.deepEqual(decision, { kind: 'accept' });
});

test('下游已经改成结构化 value 时放手', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 200 });
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult(bigText('x', 400)), {
    kind: 'accept',
    value: { structured: true },
  });
  assert.deepEqual(decision, { kind: 'accept', value: { structured: true } });
});

test('下游 block 决策不被改写', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 200 });
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult(bigText('x', 400)), {
    kind: 'block',
    feedback: [{ type: 'text', text: 'denied' }],
  });
  assert.deepEqual(decision, { kind: 'block', feedback: [{ type: 'text', text: 'denied' }] });
});

test('下游替换过的 content 是在其之上继续处理（prepend 语义）', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 600 });
  const replaced = { kind: 'accept', content: [{ type: 'text', text: bigText('replaced', 200) }] };
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult('tiny'), replaced);
  const text = decision.content.map((block) => block.text).join('');
  assert.ok(text.length < replaced.content[0].text.length, '必须以下游替换后的内容为输入');
  assert.equal(text.includes('[…] omitted'), true);
});

test('图片等富内容块不会被删除或改写', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 400 });
  const image = { type: 'image', attachment: { mediaId: 'm1' } };
  const decision = await run(ctx.rootHandler(), { name: 'read_image' }, {
    isError: false,
    content: [{ type: 'text', text: bigText('caption', 200) }, image],
  });
  assert.equal(decision.content.length, 2);
  assert.equal(decision.content[1], image);
});

test('skipTools 让指定工具完全不被触碰', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 200, skipTools: ['read'] });
  const result = okResult(bigText('read', 400));
  const decision = await run(ctx.rootHandler(), { name: 'read' }, result);
  assert.deepEqual(decision, { kind: 'accept' });
});

test('toolBudgets 覆盖单工具预算', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 8000, toolBudgets: { bash: 500 } });
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult(bigText('bash', 300)));
  const text = decision.content.map((block) => block.text).join('');
  assert.ok(text.length < 1000, `bash 走 500 字符预算，实际 ${text.length}`);
});

test('未列入 toolBudgets 的工具走全局预算', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 500, toolBudgets: { bash: 100 } });
  const decision = await run(ctx.rootHandler(), { name: 'grep' }, okResult(bigText('grep', 300)));
  const text = decision.content.map((block) => block.text).join('');
  assert.ok(text.length <= 500, `grep 走全局预算，实际 ${text.length}`);
});

test('累计统计可读，且 token 只减不增', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 1000, logSavings: true });
  const handler = ctx.rootHandler();
  await run(handler, { name: 'bash' }, okResult(bigText('x', 400)));
  await run(handler, { name: 'bash' }, okResult('tiny'));
  const stats = ctx.toolTokenOptimizerStats.snapshot();
  assert.equal(stats.calls, 2);
  assert.equal(stats.optimized, 1);
  assert.ok(stats.tokensAfter < stats.tokensBefore);
  assert.equal(stats.elided, 1);
  assert.equal(ctx.logs.some((entry) => entry.message.includes('->')), true);
});

test('异常被吞掉：插件出错也不影响工具调用', async () => {
  const ctx = createContext();
  apply(ctx, {});
  // content 不是数组：内部提前返回，绝不抛错。
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, { isError: false, content: 'not-an-array' });
  assert.deepEqual(decision, { kind: 'accept' });
});

test('装配阶段永不抛错：坏 context / 缺字段都只是记一条 warn', () => {
  assert.doesNotThrow(() => apply(undefined, {}));
  assert.doesNotThrow(() => apply({}, {}));
  assert.doesNotThrow(() => apply({ on() { throw new Error('no listeners here'); } }, {}));
  assert.doesNotThrow(() => apply({ on() {}, inject() { throw new Error('nope'); }, effect() {} }, {}));
});

test('effects 在释放时汇报累计省量', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 1000 });
  await run(ctx.rootHandler(), { name: 'bash' }, okResult(bigText('x', 400)));
  ctx.dispose();
  assert.equal(ctx.logs.some((entry) => entry.message.includes('released')), true);
});

test('配置完全缺省时仍使用默认预算工作', async () => {
  const ctx = createContext();
  apply(ctx, undefined);
  const text = bigText('x', 400);
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult(text));
  assert.equal(decision.kind, 'accept');
  assert.ok(decision.content[0].text.length < text.length, '默认配置必须生效');
});

test('非法配置值被兜底而不是让策略静默失效', async () => {
  const ctx = createContext();
  apply(ctx, { inlineChars: 'not-a-number', triggerRatio: Number.NaN, toolBudgets: { bash: 'x' } });
  const text = bigText('x', 400);
  const decision = await run(ctx.rootHandler(), { name: 'bash' }, okResult(text));
  assert.ok(decision.content[0].text.length < text.length, 'NaN 预算必须回落到默认值');
});
