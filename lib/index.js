/**
 * dsh-tool-token-optimizer —— Host 半边。
 *
 * ## 这个插件只做一件事
 *
 * 在工具结果**落盘之前**把它改小：能无损压缩的无损压缩，压不动的按预算保留
 * 「头 + 尾 + 全部报错行」，中段给一行精确说明与取回路径。
 *
 * ## 为什么必须在这一刻做（而不是事后清理历史）
 *
 * DSH 的请求前缀完全依赖 provider 侧的前缀复用：`cacheReadTokens` 通常占总输入的
 * 七八成，且按缓存命中价计费。任何对**已经发出去过**的消息的改写，都会让从改动点
 * 往后的整段前缀作废——省下的那点 token 会以数十倍的重新计价还回去。所以：
 *
 * - 本插件只挂在 `tools/post-execute`，改的是尚未进入请求的那一条结果；
 * - 绝不触碰历史消息、绝不按轮次增删工具表、绝不改系统提示的静态部分；
 * - 不做跨结果的“引用前文”式压缩（前置结果被压缩或折叠后引用会失效）。
 *
 * ## 为什么是「每个 agent 装一次」而不是挂在根上
 *
 * `tools/post-execute` 由 `ToolRuntime` 用 **agent 作用域**派发
 * （`scopeTarget(this, exec.agent)`）。DSH 的 agent 作用域是 `ctx.isolate()` 出来的
 * **完全隔离**作用域，与 profile 根之间没有父子关系；作用域过滤器只放行
 * 「无标签」或「派发键自身及其祖先」的监听器。根上注册的监听器因此**收不到**
 * agent 作用域的事件（本机实测：挂在根的插件行始终 `fiberPhase: failed`，
 * 监听器从不触发）。
 *
 * 官方自己的做法也是**在预设里**注册（`dsh-tool-fs-search`、`dsh-spill-policy`、
 * `dsh-repeat-tool-reminder` 的注册行都写在 preset 内）。本插件为了让用户不必改任何
 * 预设，等价地自己完成这件事：
 *
 * 1. 根上等 `agents` 服务出现；
 * 2. 监听 `agent/created`，对每个 agent 在**它自己的 context** 上
 *    `inject(['tools'], …)`，并在该作用域注册同一个监听器
 *    （fiber 归属该 agent，agent 释放即自动卸载）；
 * 3. 根上另注册一份，覆盖非 agent 作用域的工具执行。
 *
 * 两处注册共用同一个处理器，用 `WeakSet` 按结果对象身份记账，保证一条结果只处理一次。
 *
 * ## 质量边界
 *
 * - `isError` 的结果一个字都不动；
 * - 富内容（图片/文件块）不参与裁剪，也不会被删除；
 * - 结果永远不会变大（净收益闸门）；
 * - 中段被省略时，说明里给出**这次调用参数里已经存在**的取回动作；
 * - 原文自带的可恢复路径（DSH 的 `[output truncated; full output: …]` /
 *   `Full formatted result stored at: …`）原样保留；
 * - 装配阶段永不抛错：失败只记一条 warn，宿主继续工作。
 *
 * @module dsh-tool-token-optimizer
 */

import { optimizeResult } from './policy.js';
import { array, boolean, number, object, record, string } from './schema.js';

/** Cordis 插件名。 */
export const name = 'tool-token-optimizer';

/** 入口依赖：先拿到 agents 注册表，再按 agent 注入 tools。 */
export const inject = ['agents'];

/**
 * 运行时配置。
 *
 * 用包内自带的 Standard Schema 实现（`./schema.js`）而不是 `zod`：profile 侧插件解析
 * 不到 `zod`（本机已核实，官方 `dsh-session-cost` 也因此自带 schema）。好处是配置校验
 * 的代码路径与单元测试完全一致，且装配失败时会给出确切的字段与原因。
 *
 * 默认值来自真实语料回放（`tools/sweep2.mjs`）：`inlineChars: 1600` 在 2596 条真实结果上
 * 省掉 62.8% 的工具结果 token，且只改动其中 26.1% 的结果。
 */
export const Config = object({
  /**
   * 总开关。`false` 时插件整体不生效（连监听器都不装），用于 A/B 对照或临时停用。
   * 这是**唯一**会让结果与优化前逐字节一致的方式，因此也用于“行为等价”对照实验。
   */
  enabled: boolean({ default: true }),
  /** 单条结果的文本内联预算（字符）。 */
  inlineChars: number({ default: 1600, integer: true, min: 0 }),
  /** 触发倍数：超过 `inlineChars × triggerRatio` 才裁剪。 */
  triggerRatio: number({ default: 1, min: 1 }),
  /** 裁剪时保留的头部占比。 */
  headRatio: number({ default: 0.55, min: 0, max: 1 }),
  /** 裁剪时保留的尾部占比（结论、报错、退出状态通常在尾部）。 */
  tailRatio: number({ default: 0.35, min: 0, max: 1 }),
  /** 尾部最少保留字符数，保证 DSH 自己的可恢复路径不会被切掉。 */
  minTailChars: number({ default: 300, integer: true, min: 0 }),
  /** 可疑行（错误/失败/警告/堆栈）预算占比；实际额度不低于 400 字符。 */
  importantBudgetRatio: number({ default: 0.4, min: 0, max: 1 }),
  /** 工具级预算覆盖（字符）。未列出的工具用 `inlineChars`。 */
  toolBudgets: record(number({ integer: true, min: 0 }), { default: {} }),
  /** 完全跳过的工具（连无损规范化都不做）。 */
  skipTools: array(string(), { default: [] }),
  /** 是否把省量写进 Host 日志。 */
  logSavings: boolean({ default: false }),
});

/**
 * 把任意来源的数值收敛成可用值。
 *
 * 配置理论上已经过 {@link Config} 校验，但插件不能把正确性押在“校验一定跑过”上：
 * 宿主版本差异、手工改写配置、字段被替换都可能让非法值抵达这里。非法值一律回落到
 * 默认值，因为一个 NaN 预算会让整条策略静默失效（比较永远为 false）。
 *
 * @param value - 候选值。
 * @param fallback - 默认值。
 * @param options - `{ integer, min, max }` 约束。
 * @returns 可用的数值。
 */
function numeric(value, fallback, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (options.integer === true && !Number.isInteger(value)) return fallback;
  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;
  return value;
}

/** 配置兜底：即使未经校验（或字段被写坏）也得到确定行为。 */
function resolveConfig(input) {
  const config = input ?? {};
  const budgets = config.toolBudgets;
  const toolBudgets = {};
  if (budgets !== null && typeof budgets === 'object' && !Array.isArray(budgets)) {
    for (const [tool, value] of Object.entries(budgets)) {
      const resolved = numeric(value, Number.NaN, { integer: true, min: 0 });
      if (Number.isFinite(resolved)) toolBudgets[tool] = resolved;
    }
  }
  return {
    enabled: config.enabled !== false,
    inlineChars: numeric(config.inlineChars, 1600, { integer: true, min: 0 }),
    triggerRatio: numeric(config.triggerRatio, 1, { min: 1 }),
    headRatio: numeric(config.headRatio, 0.55, { min: 0, max: 1 }),
    tailRatio: numeric(config.tailRatio, 0.35, { min: 0, max: 1 }),
    minTailChars: numeric(config.minTailChars, 300, { integer: true, min: 0 }),
    importantBudgetRatio: numeric(config.importantBudgetRatio, 0.4, { min: 0, max: 1 }),
    toolBudgets,
    skipTools: new Set(
      Array.isArray(config.skipTools) ? config.skipTools.filter((tool) => typeof tool === 'string') : [],
    ),
    logSavings: config.logSavings === true,
  };
}

/**
 * 创建共享处理器与统计。
 *
 * 处理器是**幂等**的：同一条结果（按结果对象身份记账）只会被压缩一次，
 * 因此根与 agent 两处注册同时命中时不会重复处理。
 *
 * @param ctx - Cordis 上下文（仅用于日志）。
 * @param cfg - 解析后的配置。
 * @returns `{ handler, stats }`。
 */
function createHandler(ctx, cfg) {
  const stats = { calls: 0, optimized: 0, tokensBefore: 0, tokensAfter: 0, elided: 0, lossless: 0 };
  const handled = new WeakSet();
  const options = {
    inlineChars: cfg.inlineChars,
    triggerRatio: cfg.triggerRatio,
    headRatio: cfg.headRatio,
    tailRatio: cfg.tailRatio,
    minTailChars: cfg.minTailChars,
    importantBudgetChars: Math.max(400, Math.floor(cfg.inlineChars * cfg.importantBudgetRatio)),
    toolBudgets: cfg.toolBudgets,
    minBlockChars: 400,
  };

  /**
   * `prepend: true` 让本监听器位于 waterfall 最外层，并在 `next()` 之后决策：
   * 因此看到的是所有下游转换器（官方 spill-policy、fs-search 的溢出替换等）
   * 处理完之后的**最终内容**，不会与它们互相覆盖。
   */
  const handler = async (exec, result, next) => {
    const decision = await next();
    // 下游监听器可能返回空值（本插件无权假定协议一定被遵守）：此时**原样放行**，
    // 绝不因为自己而把工具调用变成失败。
    if (decision === null || typeof decision !== 'object') return decision;
    if (decision.kind !== 'accept') return decision;
    // 下游已经换成了结构化 value：那不是文本结果，无权改动。
    if (Object.hasOwn(decision, 'value')) return decision;
    if (result === null || typeof result !== 'object') return decision;
    if (handled.has(result)) return decision;

    const tool = exec?.name ?? 'unknown';
    if (cfg.skipTools.has(tool)) return decision;
    const content = decision.content ?? result.content;
    if (!Array.isArray(content) || content.length === 0) return decision;

    stats.calls += 1;
    let optimized;
    try {
      optimized = optimizeResult({ tool, content, isError: result.isError === true }, options);
    } catch (error) {
      // 任何意外都不能影响工具调用本身：原样放行，并把原因写进日志。
      ctx?.logger?.warn?.(`tool-token-optimizer: skipped ${tool}: ${error?.message ?? error}`);
      return decision;
    }
    if (!optimized.changed) return decision;

    // 成功改写过才记账：这样万一同一个结果对象被派发两次，第二次会原样放行，
    // 而不是在已压缩的文本上再压一次。记账放在 try 之后，一次瞬时异常不会
    // 让这条结果**永久**失去优化机会。
    handled.add(result);
    stats.optimized += 1;
    stats.tokensBefore += optimized.before;
    stats.tokensAfter += optimized.after;
    if (optimized.steps.includes('retain-middle')) stats.elided += 1;
    else stats.lossless += 1;
    if (cfg.logSavings) {
      ctx?.logger?.info?.(
        `tool-token-optimizer: ${tool} ${optimized.before} -> ${optimized.after} tok ` +
          `(-${optimized.savedTokens}, ${optimized.steps.join('+')})`,
      );
    }
    return { ...decision, content: optimized.content };
  };
  return { handler, stats };
}

/**
 * 在一个作用域里注册监听器，并在该作用域释放时汇报累计省量。
 *
 * @param ctx - 注册所在的 Cordis 上下文（决定监听器归属与可见作用域）。
 * @param handler - 共享处理器。
 * @param stats - 共享统计。
 * @param label - 日志里标识注册位置。
 */
function registerScope(ctx, handler, stats, label) {
  ctx.on('tools/post-execute', handler, { prepend: true });
  ctx.effect(
    () => () => {
      if (stats.optimized === 0) return;
      ctx?.logger?.info?.(
        `tool-token-optimizer: released (${label}); optimized ${stats.optimized}/${stats.calls} results, ` +
          `${stats.tokensBefore} -> ${stats.tokensAfter} tok (saved ${stats.tokensBefore - stats.tokensAfter})`,
      );
    },
    `tool-token-optimizer.report.${label}`,
  );
}

/**
 * 安装结果策略。
 *
 * **装配阶段永不抛错**：插件的全部价值是“顺手把结果改小”，它没有资格因为任何
 * 环境差异（context 形状、字段只读、logger 缺失……）让宿主的一个插件行变成
 * failed、更不该影响工具调用本身。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置（可能未经校验）。
 */
export function apply(ctx, config) {
  try {
    install(ctx, config);
  } catch (error) {
    try {
      ctx?.logger?.warn?.(`tool-token-optimizer: install failed, plugin disabled: ${error?.stack ?? error}`);
    } catch {
      // 连日志都写不出去时也不能让异常冒泡。
    }
  }
}

/**
 * 真正的安装过程。
 *
 * @param ctx - Cordis 上下文（根作用域，`agents` 已就绪）。
 * @param config - 插件配置（可能未经校验）。
 */
function install(ctx, config) {
  const cfg = resolveConfig(config);
  // 每次装配（含 configEditor/reload 触发的重装）都重新读取，因此改配置即可即时生效。
  if (!cfg.enabled) {
    try {
      ctx?.logger?.info?.('tool-token-optimizer: disabled by config (enabled: false)');
    } catch {
      // 日志不可用时静默。
    }
    return;
  }
  const { handler, stats } = createHandler(ctx, cfg);

  // 1) 根作用域：覆盖非 agent 作用域的工具执行。
  registerScope(ctx, handler, stats, 'root');

  /** 已装过监听器的 agent（按对象身份记账，重复的 created 事件不会重复安装）。 */
  const installed = new WeakSet();

  /**
   * 2) 每个 agent 自己的作用域——这才是 `tools/post-execute` 真正派发的地方。
   *
   * `agent.ctx.inject(['tools'], …)` 会在**该 agent 作用域内**、`tools` 就绪时执行；
   * 生成的 fiber 归属该 agent，agent 释放时自动卸载。
   *
   * @param agent - `agent/created` 载荷里的 agent。
   */
  const installForAgent = (agent) => {
    if (agent === null || typeof agent !== 'object') return;
    if (installed.has(agent)) return;
    installed.add(agent);
    const agentCtx = agent.ctx;
    if (agentCtx === undefined || typeof agentCtx.inject !== 'function') return;
    agentCtx.inject(['tools'], (scoped) => {
      registerScope(scoped, handler, stats, `agent:${String(agent.id ?? '?').slice(0, 8)}`);
    });
  };

  if (typeof ctx.on === 'function') {
    ctx.on('agent/created', ({ agent }) => installForAgent(agent));
  }
  // 插件晚于 agent 启动时（例如热重载）也要补装已存在的 agent。
  const agents = ctx.agents;
  if (agents !== undefined && typeof agents.list === 'function') {
    for (const agent of agents.list()) installForAgent(agent);
  }

  /** 只读统计面：供测试与宿主诊断读取，不注册服务、不产生额外 token。 */
  try {
    ctx.toolTokenOptimizerStats = { snapshot: () => ({ ...stats }) };
  } catch {
    // 某些 context 形状拒绝写入自定义属性：统计不是必需品，忽略。
  }
}
