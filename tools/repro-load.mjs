/**
 * 装配复现：用**真实的 Cordis 运行时**复刻宿主装载本插件的过程，验证两件在单元
 * 测试里无法证明的事：
 *
 * 1. `apply(ctx, config)` 在真实 Cordis 上能装成功（fiber 不因装配而失败）；
 * 2. 在**隔离的 agent 作用域**里派发 `tools/post-execute` 时，本插件的监听器**确实
 *    会被调用**并裁剪结果——这是设计上最关键的一条：agent 作用域与 profile 根
 *    完全隔离，官方 `scopeTarget(this, exec.agent)` 的过滤器只放行「无标签」或
 *    「派发键自身及其祖先」的监听器。
 *
 * 依赖真实的 `@deepseek-ai/cordis`：从 `app.asar` 解出（含 `@deepseek-ai/cosmokit`
 * 与 `@standard-schema/spec`）。用法：
 *
 *   node tools/repro-load.mjs <cordis-package-dir> <plugin-lib-dir>
 *
 * 例：
 *   node tools/repro-load.mjs /tmp/repro/node_modules /Users/…/dsh-tool-token-optimizer/lib
 *
 * @module dsh-tool-token-optimizer/tools/repro-load
 */

const [cordisRoot, pluginLibDir] = process.argv.slice(2);
if (cordisRoot === undefined || pluginLibDir === undefined) {
  console.error('usage: node tools/repro-load.mjs <node_modules-dir-with-@deepseek-ai/cordis> <plugin-lib-dir>');
  process.exit(2);
}

const { Context, Service } = await import(`${cordisRoot}/@deepseek-ai/cordis/lib/index.js`);
const plugin = await import(`${pluginLibDir}/index.js`);

/** 断言并累计结果。 */
const checks = [];
const check = (label, ok, detail = '') => {
  checks.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? '✔' : '✖'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** 造一个带 logger 的根上下文，并挂上 agents 服务（与宿主一致）。 */
function createRoot() {
  const logs = [];
  const ctx = new Context();
  ctx.logger = {
    info: (message) => logs.push(['info', String(message)]),
    warn: (message) => logs.push(['warn', String(message)]),
    error: (message) => logs.push(['error', String(message)]),
    debug: () => {},
  };
  class Agents extends Service {
    constructor(owner) {
      super(owner, 'agents');
      this.entries = [];
    }
    list() {
      return this.entries;
    }
  }
  const agents = new Agents(ctx);
  return { ctx, agents, logs };
}

const bigText = Array.from({ length: 400 }, (_, index) => `line ${index} ${'x'.repeat(60)}`).join('\n');
const bigResult = { isError: false, content: [{ type: 'text', text: bigText }] };

// ---- 1) 装配：真实 Cordis 上 apply 必须成功 -------------------------------------
{
  const { ctx, logs } = createRoot();
  const fiber = ctx.plugin(plugin, { inlineChars: 1600 });
  await fiber;
  check('真实 Cordis 上装配完成（fiber 无错误）', fiber._error === undefined, `fiber.state=${fiber.state}`);
  check('装配过程没有 warn/error 日志', logs.filter(([level]) => level !== 'info').length === 0);
}

// ---- 2) agent 作用域：隔离作用域内派发必须命中监听器 ------------------------------
{
  const { ctx, agents } = createRoot();
  await ctx.plugin(plugin, { inlineChars: 1600 });

  // 复刻宿主：agent 有一个 isolate 出来的作用域，作用域内才有 tools 服务
  const agentCtx = ctx.isolate('agent-scope');
  class Tools extends Service {
    constructor(owner) {
      super(owner, 'tools');
    }
  }
  agentCtx.plugin(Tools);

  const agent = { id: 'session-repro', ctx: agentCtx };
  agents.entries.push(agent);
  ctx.emit('agent/created', { agent });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const decision = await ctx.events.waterfall(agentCtx, 'tools/post-execute', { name: 'bash' }, bigResult, async () => ({
    kind: 'accept',
  }));
  const text = decision.content?.[0]?.text ?? bigText;
  check('隔离的 agent 作用域里监听器被调用并改写了结果', text.length < bigText.length, `${bigText.length} -> ${text.length} chars`);
  check('结果里带精确省略说明', /\[…\] omitted \d+ chars \/ \d+ lines of \d+/.test(text));
  check('结果里带取回路径', /re-run this command/.test(text));
  check('结果永远不变大', text.length <= bigText.length);
}

// ---- 3) 根作用域派发（无 agent）也必须命中 ---------------------------------------
{
  const { ctx } = createRoot();
  await ctx.plugin(plugin, { inlineChars: 1600 });
  const decision = await ctx.events.waterfall(ctx, 'tools/post-execute', { name: 'bash' }, bigResult, async () => ({
    kind: 'accept',
  }));
  const text = decision.content?.[0]?.text ?? bigText;
  check('根作用域派发也命中监听器', text.length < bigText.length, `${bigText.length} -> ${text.length} chars`);
}

// ---- 4) 失败结果 / 结构化 value 一律放行 -----------------------------------------
{
  const { ctx } = createRoot();
  await ctx.plugin(plugin, { inlineChars: 200 });
  const failed = await ctx.events.waterfall(ctx, 'tools/post-execute', { name: 'bash' }, { isError: true, content: bigResult.content }, async () => ({ kind: 'accept' }));
  check('失败结果逐字节放行', failed.content === undefined);
  const valued = await ctx.events.waterfall(ctx, 'tools/post-execute', { name: 'bash' }, bigResult, async () => ({ kind: 'accept', value: 1 }));
  check('结构化 value 决策放行', valued.value === 1 && valued.content === undefined);
}

// ---- 5) 缺 agents 服务时只是不装，不抛错 -----------------------------------------
{
  const ctx = new Context();
  ctx.logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const fiber = ctx.plugin(plugin, {});
  await fiber;
  check('缺 agents 服务时不抛错（fiber 停在 pending）', fiber._error === undefined, `fiber.state=${fiber.state}`);
}

const failed = checks.filter((item) => !item.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
