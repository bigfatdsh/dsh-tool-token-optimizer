# 重启后如何确认插件真的生效

插件在**结果落盘那一刻**压缩，所以证据就在工具结果本身。任选一条：

## 1. 一条大输出（最直接）

让我跑 `seq 1 3000`（或任何输出超过 1600 字符的命令）。生效时你会看到：

```
1
2
…
[… ]  ← 说明行，形如：
[…] omitted 13894 chars / 2712 lines of 14995; re-run this command (optionally piped) to see any range
…
2998
2999
3000
```

**没生效**时输出是完整 3000 行、且没有这行说明。

## 2. 一条报错的大输出（验证“报错行必定保留”）

```bash
seq 1 3000 > /tmp/big.txt; cat /tmp/big.txt; echo "ERROR: something failed" >&2; exit 1
```

生效时中段被省略，但 `[stderr]` 段、`ERROR: something failed` 与 `[exit code: 1]`
都会在结果里（它们分别属于尾部与“可疑行”预算）。

## 3. 一次 `read`（验证结构完整）

让我读一个几千行的文件。生效时 `<path>/<type>file</type>/<content>` 信封、
开头若干行、结尾若干行与 `(Showing lines A-B of N. Use offset=…)` footer 都在，
中间有一段说明行。

## 4. 从会话日志里核对（可量化）

```bash
cd /Users/yangletian/Documents/deepseek-harness/default-workspace/dsh-tool-token-optimizer
node tools/extract-corpus.mjs .corpus/raw          # 重新解压（含重启后的新会话）
node tools/replay.mjs .corpus/raw --inline 1600    # 看省量百分比
```

`[…] omitted` 这个标记只由本插件产生；在 `tool/result` 事件里 `grep` 一下它的
出现次数，就等于“被压缩的结果条数”。
