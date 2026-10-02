/**
 * 结构感知的结果切分：把一条工具结果按**它自己的分段边界**切成若干「单元」，
 * 供有界保留做**整单元**取舍，而不是按字符位置硬切。
 *
 * ## 为什么需要它
 *
 * DSH 的工具输出本身是有结构的：
 *
 * - `bash` / `pwsh`：`stdout` + `[stderr]` 段 + 状态标记行（`[exit code: N]`、
 *   `[timed out after …]`、`[killed by signal: …]`）。按字符切会把这三段**任意一段切开**，
 *   于是模型可能看到半行 stdout、或看到 `[stderr]` 标题却没有正文（反之亦然）。
 * - `grep`：`Found N matches` 头部 + 按文件分组的匹配行；按字符切会**整组丢掉**，
 *   而且丢掉的是"某个文件匹配了没有"这个离散信息，破坏力大于丢掉若干行。
 * - 其它：按行切（行是最小语义单元，不会把一行劈成两半）。
 *
 * ## 取舍规则
 *
 * 头部与尾部各按**整单元**累加直到预算用尽；单位必须放进预算里才会被选中，
 * 绝不出现半个单元。状态标记与 `[stderr]` 段在尾部优先级最高——它们是"这次调用
 * 到底成功没有"的直接答案。
 *
 * @module dsh-tool-token-optimizer/sections
 */

/** 状态标记行：尾部必须优先保留。 */
const STATUS_MARKER = /^\[(?:exit code:|timed out|killed by signal|stopped:|some output was dropped|result truncated|output truncated)[^\]]*\]$/;

/**
 * 把一个文本块切成结构单元。
 *
 * 关键点：**单元必须小到能装进预算**。`bash` 的 stdout 常常是几万字符的一整段，
 * 如果把它当成一个单元，预算里放不下任何一个单元，结构对齐就退化得比按字符切还差。
 * 因此这里做**递归切分**：
 *
 * 1. 先按工具的结构边界切（`[stderr]`、状态标记、`grep` 的文件分组）；
 * 2. 仍然过大的单元，在它内部继续找结构边界；
 * 3. 再无结构就按行切；
 * 4. 单行仍然超预算（例如一行 4 万字符的 JSON）才做硬切——这是唯一会切开内容的情形，
 *    而且只在"本来就没有行结构"的数据上发生。
 *
 * @param text - 结果全文。
 * @param tool - 工具名（决定切分策略）。
 * @param maxUnitChars - 单个单元的字符上限（通常取预算的 1/4）。
 * @param firstLineChars - 首行的字符数：首行（信封、`Fetched <url> (HTTP 200)`、
 *   命令回显）必须尽量整行留下，因此窗口不小于"首行长度 + 1"，避免把首行切成两片。
 * @returns `{ units, kind }`：`units` 为有序单元，`kind` 说明采用了哪种策略。
 */
export function sectionsOf(text, tool, maxUnitChars = 400, firstLineChars = 0) {
  if (typeof text !== 'string' || text.length === 0) return { units: [], kind: 'empty' };
  // 首行不可切：窗口至少容得下它（超过 maxUnitChars 的场景下，宁可窗口大一点）。
  const window = Math.max(maxUnitChars, Number.isFinite(firstLineChars) ? firstLineChars + 1 : 0);
  let kind = 'lines';
  let units = null;
  if (tool === 'bash' || tool === 'pwsh' || tool === 'job_output' || tool === 'job_kill') {
    const shell = shellSections(text);
    if (shell !== null) {
      units = shell.units;
      kind = 'shell';
    }
  }
  if (units === null && tool === 'grep' && /^Found \d/.test(text)) {
    const grep = grepSections(text);
    if (grep !== null) {
      units = grep.units;
      kind = 'grep-groups';
    }
  }
  if (units === null) units = lineUnits(text);
  return { units: refineUnits(units, window), kind };
}

/**
 * 把过大的单元继续切小：优先在内部找结构边界，其次按行，最后才硬切。
 *
 * @param units - 初切单元。
 * @param maxUnitChars - 单单元字符上限。
 * @returns 细化后的单元列表。
 */
export function refineUnits(units, maxUnitChars) {
  const out = [];
  for (const unit of units) {
    if (unit.text.length <= maxUnitChars) {
      out.push(unit);
      continue;
    }
    // 1) 单元内部还有结构边界吗？
    const inner = innerBreakpoints(unit.text);
    if (inner.length > 0) {
      let cursor = 0;
      for (const at of inner) {
        if (at > cursor) out.push({ text: unit.text.slice(cursor, at), priority: unit.priority });
        cursor = at;
      }
      if (cursor < unit.text.length) out.push({ text: unit.text.slice(cursor), priority: unit.priority });
      continue;
    }
    // 2) 按行打包成单元。**只在行边界断开**：除"单行本身就超长"这个唯一例外，
    //    绝不把一行劈成两半——劈开会让“丢弃了多少行”无法精确计数，也会让模型看到半行。
    const lines = unit.text.split('\n');
    if (lines.length > 1) {
      let buffer = [];
      let size = 0;
      const flush = () => {
        if (buffer.length === 0) return;
        out.push({ text: buffer.join('\n'), priority: unit.priority });
        buffer = [];
        size = 0;
      };
      for (const line of lines) {
        // 单行超长：它自己就是一个窗口，只能硬切（否则这一行会撑爆整个预算，
        // 把首行/末行的保证一起拖垮）。切出来的片段带上 `firstPiece/lastPiece`，
        // 让尾部选择可以优先保住这一行的**开头**（结论与失败原因都在开头）。
        if (line.length > maxUnitChars) {
          flush();
          const pieces = [];
          for (let at = 0; at < line.length; at += maxUnitChars) {
            pieces.push({ text: line.slice(at, at + maxUnitChars), priority: unit.priority });
          }
          pieces[0].firstPiece = true;
          pieces[pieces.length - 1].lastPiece = true;
          for (const piece of pieces) out.push(piece);
          continue;
        }
        if (buffer.length > 0 && size + line.length + 1 > maxUnitChars) flush();
        buffer.push(line);
        size += line.length + 1;
      }
      flush();
      continue;
    }
    // 3) 单行超长（没有行结构的机器输出）：按固定窗口硬切，这是唯一会切开内容的情形
    const pieces = [];
    for (let at = 0; at < unit.text.length; at += maxUnitChars) {
      pieces.push({ text: unit.text.slice(at, at + maxUnitChars), priority: unit.priority });
    }
    pieces[0].firstPiece = true;
    pieces[pieces.length - 1].lastPiece = true;
    for (const piece of pieces) out.push(piece);  }
  return out;
}

/**
 * 单元内部的结构断点：`[stderr]` 行与状态标记行的起始下标。
 *
 * @param text - 单元文本。
 * @returns 升序断点数组（不含 0）。
 */
function innerBreakpoints(text) {
  const points = [];
  let at = 0;
  for (const line of text.split('\n')) {
    if (at > 0 && (line === '[stderr]' || STATUS_MARKER.test(line))) points.push(at);
    at += line.length + 1;
  }
  return points;
}

/**
 * `bash`/`job` 类输出：按 `[stderr]` 分节，并把尾部状态标记单独成单元。
 *
 * @param text - 结果全文。
 * @returns 单元列表，或 null（没有可识别的结构，交给上层退化处理）。
 */
function shellSections(text) {
  const lines = text.split('\n');
  const units = [];
  let buffer = [];
  let sawStructure = false;
  const flush = () => {
    if (buffer.length === 0) return;
    units.push({ text: buffer.join('\n'), priority: 0 });
    buffer = [];
  };
  for (const line of lines) {
    if (line === '[stderr]') {
      sawStructure = true;
      flush();
      units.push({ text: line, priority: 1 });
      continue;
    }
    if (STATUS_MARKER.test(line)) {
      sawStructure = true;
      flush();
      units.push({ text: line, priority: 2 });
      continue;
    }
    buffer.push(line);
  }
  flush();
  if (!sawStructure) return null;
  return { units, kind: 'shell' };
}

/**
 * `grep` 输出：头部 + 每个文件一组（组内是"路径行 + `Line N: …` 匹配行"）。
 *
 * @param text - 结果全文。
 * @returns 单元列表。
 */
function grepSections(text) {
  const parts = text.split('\n\n');
  if (parts.length < 2) return null;
  const units = [{ text: parts[0], priority: 2 }];
  for (const part of parts.slice(1)) {
    // 尾部可能挂着 `(Full grep result stored at: …)` 这类取回提示
    const lines = part.split('\n');
    if (lines.length === 1 && /^\(.*(?:stored at|narrow pattern|complete result)/.test(lines[0])) {
      units.push({ text: part, priority: 2 });
      continue;
    }
    units.push({ text: part, priority: 0 });
  }
  return { units, kind: 'grep-groups' };
}

/**
 * 通用策略：一行一个单元（超长行会被单独视为一个单元）。
 *
 * @param text - 结果全文。
 * @returns 单元列表。
 */
function lineUnits(text) {
  const lines = text.split('\n');
  const units = lines.map((line) => ({ text: line, priority: 0 }));
  return units;
}

/**
 * 在预算内挑选「头部若干整单元 + 尾部若干整单元」，保证不切开任何单元。
 *
 * 尾部挑选会**优先吃下高优先级单元**（状态标记、`[stderr]`、`grep` 头部/取回提示）：
 * 先按优先级挑，再按从后往前的顺序补齐剩余预算。**最后一个单元无条件占位**
 * （见 `keepLast`），因为结论与退出状态永远在那里。
 *
 * @param units - `sectionsOf` 产出的单元。
 * @param budget - 可用于内容的字符预算（已扣除说明行等保留量）。
 * @param options - `{ headRatio, tailRatio, keepLast }`。
 * @returns `{ head, tail, headUnits, tailUnits, omittedUnits, omittedChars, clippedLast }`。
 */
export function pickSections(units, budget, options = {}) {
  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const keepLast = options.keepLast ?? true;
  const minTailChars = options.minTailChars ?? 0;
  let headBudget = Math.floor(budget * headRatio);
  // 尾部下限（结论与取回路径都在尾部）：先给尾部保底，再从头部扣，总量不越过 budget。
  let tailBudget = Math.min(budget, Math.max(minTailChars, Math.floor(budget * tailRatio)));
  if (headBudget + tailBudget > budget) headBudget = Math.max(0, budget - tailBudget);
  tailBudget = Math.max(0, tailBudget);

  // 头部：从头开始整单元累加。**第一个单元同样无条件占位**——它是格式与接口
  // （`<path>` 信封、`Found N matches`、命令回显、minified JSON 的开头），
  // 丢掉它等于把"这是什么结果"一起丢掉；自身超预算时退化为截断行。
  //
  // 记账口径 = `head.join('\n').length`：单元之间加一个换行，**末尾不加**
  // （拼接方 `join` 不会再补一个）。多算一个换行会让头部整体超出预算，
  // 实测曾导致 143 个块越过 inlineChars 上界。
  const head = [];
  let headChars = 0;
  let headCount = 0;
  // "首单元特权"的上限：最多占内容预算的 45%，给尾部（结论、退出状态、取回路径）
  // 留下至少 55%。没有这个上限时，一个长首行会把尾部挤到预算之外。
  const headCap = Math.floor(budget * 0.45);
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    // 第一个单元享受"整体保留"的特权：只要它没超过上面那个上限，就整块留下，
    // 不按 headRatio 切。理由：它是格式与接口（`Fetched <长URL> (HTTP 200)`、
    // `<path>` 信封、命令回显），按比例切会把它切断（实测 252 字符的抓取头会被
    // 切成两片）。
    const privileged = headCount === 0 && unit.text.length <= Math.max(headCap, headBudget);
    const size = unit.text.length + (headCount === 0 ? 0 : 1);
    if (!privileged && headChars + size > headBudget) {
      if (headCount === 0 && headBudget > 0) {
        // 首行跨多个窗口（它自己就超过上限）：把属于首行的那些窗口接回去，
        // 再按字符截断——否则会出现"257:const FILE_REFERENCE_PROMPT = …"这种半行。
        const firstLine = firstLineOf(units, index);
        const clipped = clipLine(firstLine, Math.max(headBudget, headCap));
        head.push({ ...unit, text: clipped.text });
        headChars += clipped.text.length;
        headCount = 1;
      }
      break;
    }
    head.push(unit);
    headChars += size;
    headCount += 1;
  }

  // 尾部：**最后一个单元（结论/退出状态所在处）无条件先占**
  //
  // 这里曾经是 `continue`：放不下的单元被跳过、继续往更早的小单元里填，于是当真正的
  // 末行很长时，它会被一堆中段填充物挤出尾部——"尾部留下结论"这个立身之本当场失效
  // （实测 30/677 条真实结果丢掉原文最后一行）。现在改为：
  //   1. 末单元先占预算，若它自己就超预算，退化为「头部截断 + 省略标记」，绝不消失；
  //   2. 其余单元按优先级 + 从后往前补齐。
  const tail = [];
  const taken = new Set();
  let tailChars = 0;
  const candidates = units
    .map((unit, index) => ({ unit, index }))
    .slice(headCount)
    .sort((left, right) => right.unit.priority - left.unit.priority || right.index - left.index);

  const lastIndex = units.length - 1;
  const lastUnit = keepLast && lastIndex >= headCount ? units[lastIndex] : null;
  if (lastUnit !== null) {
    // 末单元若是"超长行的一个窗口"，真正该留的是这一行的**开头**：结论、失败原因、
    // 断言表达式都在开头；末尾那截窗口通常只是重复填充。找到它的首片来占位。
    let seedIndex = lastIndex;
    let seedUnit = lastUnit;
    if (lastUnit.lastPiece === true) {
      let at = lastIndex;
      while (at > 0 && units[at].firstPiece !== true) at -= 1;
      if (units[at].firstPiece === true && units[at].text.length <= tailBudget) {
        seedIndex = at;
        seedUnit = units[at];
      }
    }
    const size = seedUnit.text.length + (tail.length === 0 ? 0 : 1);
    if (size <= tailBudget) {
      tail.push({ unit: seedUnit, index: seedIndex });
      taken.add(seedIndex);
      tailChars += size;
    } else if (tailBudget > 0) {
      // 首片本身都放不下（预算极小）：截断它，也不让结论整行消失。
      const clipped = clipLine(seedUnit.text, Math.max(40, tailBudget - 24));
      tail.push({ unit: { ...seedUnit, text: clipped.text }, index: seedIndex, clipped: clipped.dropped });
      taken.add(seedIndex);
      tailChars += clipped.text.length;
    }
  }

  for (const { unit, index } of candidates) {
    if (taken.has(index)) continue;
    const size = unit.text.length + 1;
    if (tailChars + size > tailBudget) continue;
    tail.push({ unit, index });
    taken.add(index);
    tailChars += size;
  }
  tail.sort((left, right) => left.index - right.index);

  // 被略去的单元 = 不在 head 也不在 tail 里的单元。**不能**用
  // `units.slice(headCount, len - tailUnits)` 推——尾部是按优先级挑的，可能分散在多处。
  const kept = new Set([...Array(headCount).keys(), ...taken]);
  const omitted = units.filter((unit, index) => !kept.has(index));
  const clippedLast = tail.find((item) => item.clipped !== undefined)?.clipped ?? 0;
  // 末尾单元（结论与退出状态所在处）：调用方需要知道"哪一个不许被摘掉"。
  const lastEntry = tail.reduce((best, item) => (best === null || item.index > best.index ? item : best), null);
  return {
    head: head.map((unit) => unit.text).join('\n'),
    tail: tail.map((item) => item.unit.text).join('\n'),
    headUnits: headCount,
    tailUnits: taken.size,
    omittedUnits: omitted.length,
    omittedChars: omitted.reduce((sum, unit) => sum + unit.text.length + 1, 0),
    omittedUnitsList: omitted,
    tailUnitsList: tail.map((item) => ({ unit: item.unit, index: item.index })),
    lastUnitText: lastEntry === null ? '' : lastEntry.unit.text,
    clippedLast,
  };
}

/**
 * 把一行截断到 `limit` 字符以内，并在结尾留下可见的截断标记。
 *
 * 只用于「末单元自身超过整个尾部预算」这一种情形：宁可给模型一个被截断的结论，
 * 也不给它一堆中段填充物。返回的 `dropped` 是这一行还有多少字符没显示。
 *
 * @param line - 原始行。
 * @param limit - 允许的最大字符数（含截断标记）。
 * @returns `{ text, dropped }`。
 */
function clipLine(line, limit) {
  const marker = ' …[line clipped]';
  if (line.length <= limit) return { text: line, dropped: 0 };
  const keep = Math.max(0, limit - marker.length);
  return { text: line.slice(0, keep) + marker, dropped: line.length - keep };
}

/**
 * 把从 `start` 开始的若干单元接回成它们的**第一条逻辑行**。
 *
 * 超长行会被窗口切成多个单元，窗口边界与行边界无关；要按行语义处理首行，
 * 就必须先把这些窗口接回去。
 *
 * @param units - 单元数组。
 * @param start - 起始下标（该单元必须是 `firstPiece`）。
 * @returns 第一条逻辑行的文本。
 */
function firstLineOf(units, start) {
  // 用数组收集再 join：逐片 `+=` 在"首行 = 4 万个窗口"时是平方级开销
  // （实测 40k 行输入上贡献了约 100 ms）。
  const pieces = [];
  for (let index = start; index < units.length; index += 1) {
    pieces.push(units[index].text);
    if (units[index].lastPiece === true) break;
    // 没有窗口标记（普通单元）：它自己就是完整的一行。
    if (units[index].firstPiece !== true) break;
  }
  return pieces.join('');
}
