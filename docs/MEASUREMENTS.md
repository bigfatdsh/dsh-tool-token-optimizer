# 省量实测记录（可复现）

生成时间：2026-10-02　插件版本：1.0.14（含硬约束修复：上界、首末行、失败信号覆盖、说明行自洽、行号单调）

语料：本机 DSH 会话日志解压后的 25 个会话（`node tools/extract-corpus.mjs .corpus/raw`），共 2596 条真实工具结果。

## 0. 真实 Cordis 装配与作用域复现（`node tools/repro-load.mjs`）

```
✔ 真实 Cordis 上装配完成（fiber 无错误） — fiber.state=2
✔ 装配过程没有 warn/error 日志
✔ 隔离的 agent 作用域里监听器被调用并改写了结果 — 27889 -> 1339 chars
✔ 结果里带精确省略说明
✔ 结果里带取回路径
✔ 结果永远不变大
✔ 根作用域派发也命中监听器 — 27889 -> 1339 chars
✔ 失败结果逐字节放行
✔ 结构化 value 决策放行
✔ 缺 agents 服务时不抛错（fiber 停在 pending） — fiber.state=0

10/10 项通过
```

## 0.2 性能基准（`node tools/bench.mjs .corpus/raw --runs 3`）

```
语料：2596 条真实工具结果，3 轮

【真实语料】
  总耗时        193.1 ms（3 轮合计见下）
  单条 平均     0.074 ms
  单条 P50      0.005 ms
  单条 P95      0.219 ms
  单条 P99      0.923 ms
  单条 最大     14.100 ms（cordis_inspect_query，49931 字符）

【按结果大小分档】（每档取平均值，确认线性、无二次爆炸）
  字符区间         条数     平均字符     平均耗时      每 KB 耗时
  0–512             1390          202      0.004 ms         0.0209 ms
  512–2048           674         1072      0.016 ms         0.0149 ms
  2048–8192          435         3852      0.185 ms         0.0492 ms
  8192–32768          76        15558      0.501 ms         0.0330 ms
  32768–∞             21        47185      2.774 ms         0.0602 ms

【最坏情况】（单条结果）
  40k 字符单行（minified JSON）           23 KB      0.22 ms  省 22,279 字符量级
```

## 0.5 缓存命中率审计（`node tools/cache-audit.mjs .corpus/raw`）

```
会话数 22　请求数 2136
整体命中率 99.1%　（cacheRead 409,195,776 / 未命中输入 3,857,664）
未命中构成：每会话首请求 70,082（1.8%）、前缀作废 1,443,274（37.4%）
达到 95% 的会话：15/22

会话                                    请求    命中率   首请求miss  作废miss  作废次数
session-c778d3c6-abe5-4bba-b354-062094     2    46.5%        8267         0         0
session-4e3b5517-03e7-48a7-adae-202bbc    35    87.7%        7988    146920         2
```

## 1. 工具结果级（`node tools/replay.mjs .corpus/raw --step`）

```
会话文件        : 25
工具结果条数    : 2596
基线 token      : 1,234,957
压缩后 token    : 388,740
省下 token      : 846,217  (68.5%)
被改动的结果条数: 678  (26.1%)
  其中预算裁剪  : 625，纯无损规范化: 53
预算            : inlineChars=1600

按工具（省量降序）：
  tool                          calls      base     saved   saved%  trimmed
  bash                          1624    606504    344046   56.7%      413
  cordis_inspect_query            46    196373    184259   93.8%       38
  read                           145    158328    122117   77.1%      113
  web_fetch                       43    103637     98038   94.6%       21
  plugin_manager                  66     91945     80026   87.0%       23
  cordis_inspect_list              8     15736     13912   88.4%        8
  univer_api                       1      1458      1307   89.6%        1
  web_search                      45     14812      1278    8.6%        5
  job_output                      19      2857       823   28.8%        2
  job_list                         2       639       411   49.3%        1

按变换步骤（单步归因，降序）：
  retain-middle           773351 tok   99.8% of savings
  trailing-spaces           1127 tok    0.1% of savings
  duplicate-runs             600 tok    0.1% of savings
```

## 2. 全表面反事实回放（`node tools/replay-surface.mjs .corpus/raw --inline 1600`）

```
inlineChars=1600
会话数 22，请求数 2138
基线表面 token 369,596,573 -> 268,860,426，省 100,736,147 (27.3%)
单会话省量中位数 36.4%，p25 7.6%，p75 41.8%

会话                                 请求     基线     压缩后    省%
session-824dc0dc-021c-4fd8-ab3f-8316    18    864931    362594    58.1%
```

## 3. 行为对照实验（详见 docs/AB-EXPERIMENT.md）

```
第二轮 8 任务×2 条件：对照 8/8、实验 8/8，逐题判定一致（含 2 道中段针任务）
  未命中/请求 322 → 222（−31%）　按价成本 ￥0.0221 → ￥0.0205（−7.1%）
第三轮 规模 12.4× 对照 5×2：未命中/请求 344 → 245（−29%）　成本 ￥0.00286 → ￥0.00245（−14%）　正确率 5/5 vs 5/5
```

## 4. 测试套件（`node --test "test/*.test.js"`）

```
    invalidation re-pricing surface: 1,234,957 -> 388,740 tok (68.5% smaller on every prefix miss)
✔ 前缀不变性：插件从不改写系统提示与工具表 (1.187209ms)
✔ 确定性：同一内容重复处理 N 次，输出逐字节相同 (19.805459ms)
✔ 确定性：与调用顺序、其它结果、时间无关 (3.652041ms)
✔ 确定性：多个并发的相同输入互不干扰 (3.457709ms)
✔ 前缀作废时重新计价的 token 只减不增 (518.383208ms)
✔ 插件不引入任何额外的模型请求或提示内容 (0.136375ms)
    lossless results decoded back exactly: 54/54
    corpus: 2596 results, 678 optimized, 1234957 -> 388740 tok (68.5% saved)
    read results: 18 identical, 10 exactly reversible, 113 elided (footer kept)
    elided results checked for line integrity: 623 (single-line blocks exempt: 23)
    rich-content results checked: 157
    failures checked: 51
    recovery paths checked: 18
    results with error/warning lines: 532, lines not kept inline: 258 (worst: bash 22 lines of a 17331-char result)
    structural markers checked: 118 (kept 118, lost 0)
    read envelopes checked: 141
    grep results checked: 1
    retained results checked: 623
✔ 真实语料：无损层可精确还原（逐条解码比对） (521.641875ms)
✔ 真实语料：结果永不放大、块结构永不改变 (395.281333ms)
✔ 真实语料：read 结果要么逐字节不变，要么可精确还原，且续读 footer 永不丢 (282.893958ms)
✔ 真实语料：被裁剪的结果绝不切进行中间（保留部分都是完整行） (435.618542ms)
✔ 真实语料：图片等富内容块逐字节保留 (277.4875ms)
✔ 真实语料：失败结果逐字节不变 (275.97ms)
✔ 真实语料：DSH 自己的可恢复路径必须保留 (299.606333ms)
✔ 真实语料：可疑行要么原样保留，要么被精确计数说明 (396.180458ms)
✔ 真实语料：DSH 的结构标记行（[stderr]/[exit code: N]/截断提示）必须保留 (265.123792ms)
✔ 真实语料：read 的结构（path/type/content/footer）必须保留 (277.2725ms)
✔ 真实语料：grep 的头部与文件路径必须保留 (258.533584ms)
✔ 真实语料：被裁剪的结果必须给出取回提示 (367.821542ms)
    read results through the hook: 141
    bash results: stderr sections 68, exit markers 48
    web_fetch results through the hook: 43
    inspect/manager results: 120 total, 69 trimmed
    end-to-end through the hook: 2596 results, 678 changed, 1234957 -> 388740 tok (68.5% saved)
✔ 真实 read 结果：信封、行号、续读 footer 在插件挂载后仍完整 (415.503958ms)
✔ 真实 bash 结果：stderr 分节、退出码标记、截断提示在插件挂载后仍完整 (353.895292ms)
✔ 真实 web_fetch 结果：不可信内容声明与 URL/状态头必须保留 (277.410542ms)
✔ 真实 plugin_manager / cordis_inspect 结果：大 JSON 被裁剪后仍是可解析片段 (855.117458ms)
✔ 真实语料整体：经插件处理后，模型读到的 token 不超过原文 (404.954625ms)
✔ 插件不改变决策对象的其它字段 (1.98325ms)
✔ 插件只声明 agents 依赖，不依赖 tools 服务 (0.87925ms)
✔ 根与 agent 作用域都会注册 post-execute，且都是 prepend (0.449416ms)
✔ 插件晚于 agent 启动时，也会补装已存在的 agent (0.100209ms)
✔ 同一 agent 收到多次 created 事件只装一次 (0.089167ms)
✔ agent 作用域处理器裁剪大结果，并给出取回路径 (8.262ms)
✔ 小结果完全不动，且不产生任何决策变更 (0.301417ms)
✔ 同一条结果被根与 agent 两处注册同时命中时只处理一次 (4.540167ms)
✔ 失败结果一个字都不动 (1.237667ms)
✔ 下游已经改成结构化 value 时放手 (0.459708ms)
✔ 下游 block 决策不被改写 (2.125166ms)
✔ 下游替换过的 content 是在其之上继续处理（prepend 语义） (0.536791ms)
✔ 图片等富内容块不会被删除或改写 (0.464334ms)
✔ skipTools 让指定工具完全不被触碰 (0.169459ms)
✔ toolBudgets 覆盖单工具预算 (0.754542ms)
✔ 未列入 toolBudgets 的工具走全局预算 (0.5475ms)
✔ 累计统计可读，且 token 只减不增 (0.73125ms)
✔ 异常被吞掉：插件出错也不影响工具调用 (0.068416ms)
✔ 装配阶段永不抛错：坏 context / 缺字段都只是记一条 warn (0.195916ms)
✔ effects 在释放时汇报累计省量 (0.833416ms)
✔ 配置完全缺省时仍使用默认预算工作 (2.504042ms)
✔ 非法配置值被兜底而不是让策略静默失效 (4.496708ms)
✔ isImportantLine 命中失败信号，不误伤普通行 (6.595709ms)
✔ findRecoveryPath 认出 DSH 自己写的两种可恢复路径 (0.286666ms)
✔ retainMiddle 保留头、尾与全部可疑行，且说明里给出精确省略量 (2.861208ms)
✔ retainMiddle 只在超预算时动手，且永不放大 (1.720042ms)
✔ retainMiddle 保留尾部里的 DSH 可恢复路径 (4.865167ms)
✔ retainContent 不动富内容块，只按比例裁文本块 (0.409667ms)
✔ retainContent 在总长未超预算时一个字节都不改 (0.074833ms)
✔ elisionNotice 同时给出省略量、可疑行数与取回方式 (0.070375ms)
✔ Config 暴露 Standard Schema v1 契约 (0.516ms)
✔ 空配置得到全部默认值 (0.645167ms)
✔ 未知键被拒绝并列出允许的键 (0.163333ms)
✔ 越界与类型错误被拒绝并给出字段名 (0.239167ms)
✔ 合法覆盖被保留，未给出的字段补默认值 (0.105584ms)
✔ 默认值返回的是副本：改一次不会污染下一次 (0.081125ms)
✔ 即使配置未经校验，apply 也能用兜底默认值工作 (5.857208ms)
✔ enabled: false 是唯一能让插件完全不生效的开关 (1.007125ms)
✔ 基础字段构造器行为正确 (0.616334ms)
✔ bash 结果按 [stderr] 与状态标记分节 (0.872875ms)
✔ grep 结果按文件分组切分，头部与取回提示是独立单元 (0.168667ms)
✔ 没有结构的结果退化为按行切 (0.428625ms)
✔ refineUnits 只在行边界断开（单行超长是唯一例外） (0.200583ms)
✔ pickSections 只取整单元，且省略集合与实际未保留的单元一致 (1.142333ms)
✔ 端到端不变量：被裁剪的结果里，保留部分永远是完整行 (8.520042ms)
✔ 被裁剪的结果永不放大，且说明里的省略量为正 (2.888416ms)
✔ normalizeNewlines 去掉 CRLF 与裸 CR (0.493ms)
✔ collapseBlankRuns 只折叠 4 个以上连续换行，且可反推 (0.146667ms)
✔ collapseDuplicateRuns 保留首末锚点，且可精确还原 (1.033792ms)
✔ decodeText 精确还原全部无损变换（除排版噪声） (0.273916ms)
✔ compactText 结果与原文在规范化口径下等价 (0.154625ms)
✔ compactText 对已经最简的文本不做任何改动 (0.378917ms)
✔ 压缩是幂等的：对已压缩文本再压一次不再变化 (0.12625ms)
✔ 属性测试：随机“日志”文本永不放大、永不改变规范化语义 (10.930708ms)
✔ 常量与官方一致 (0.51575ms)
✔ estimateText 用 UTF-16 长度除以 4 向上取整 (0.095084ms)
✔ estimateBlock 对 text/reasoning 加 4 的块开销 (0.084291ms)
✔ estimateBlock 对 tool-call 按 name + arguments 计价 (0.077ms)
✔ estimateBlock 对未知块类型退化为 JSON 长度 (0.075917ms)
✔ estimateContent 逐块累加 (0.075917ms)
✔ estimateMessage：system 按纯字符串，其余加角色开销 (0.108208ms)
✔ estimateToolsTokens 按工具表 JSON 长度计价 (0.075292ms)
✔ 中文按 UTF-16 码元计数（与官方同口径，不做码点换算） (0.072458ms)
ℹ tests 86
ℹ pass 86
ℹ fail 0
```

## 5. 硬约束复核（v1.0.14 修复后）

四项曾经被违反、现在由 `test/invariants.test.js` 与 `test/corpus.test.js` 逐条钉死的性质：

```
上界（inlineChars=1600）：625 条被裁剪结果里，超过上界的文本块 0 个
                          （修复前 143/625 超标，最大 1.31 倍）
首行/末行可定位        ：602 条多行结果里，首行不可定位 0 条、末行不可定位 0 条
                          （修复前末行丢失 30/677；预算性截断会带 `…[line clipped]` 标记）
失败信号覆盖           ：AssertionError / npm ERR! / Expected: received / ✗ / ✘ / ✖
                          / ELIFECYCLE / panic: / fatal: 全部命中
说明行自洽             ：omitted chars + 成品长度 == of N，且 of N 为无损层之前的原文长度
行号单调               ：read 结果保留行的行号非递减（不再出现 121 排在 55 之前）
```

性能（`node tools/bench.mjs .corpus/raw --runs 2`）：

```
单条 平均 0.059 ms | P50 0.004 ms | P95 0.242 ms | P99 0.778 ms
最坏情况：1.2 MB / 4 万行多行文本 30 ms；2.5 MB / 10 万行重复行 6.3 ms
每 KB 耗时在各档位持平（0.013–0.043 ms/KB），无二次爆炸
```
