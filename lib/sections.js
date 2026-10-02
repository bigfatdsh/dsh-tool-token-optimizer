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
 * @returns `{ units, kind }`：`units` 为有序单元，`kind` 说明采用了哪种策略。
 */
export function sectionsOf(text, tool, maxUnitChars = 400) {
  if (typeof text !== 'string' || text.length === 0) return { units: [], kind: 'empty' };
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
  return { units: refineUnits(units, maxUnitChars), kind };
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
    // 2) 按行打包成单元。**只在行边界断开**：单个单元可以略超 maxUnitChars（宁可超一点，
    //    也不把一行劈成两半——劈开会让“丢弃了多少行”无法精确计数，也会让模型看到半行）。
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
        if (buffer.length > 0 && size + line.length + 1 > maxUnitChars) flush();
        buffer.push(line);
        size += line.length + 1;
      }
      flush();
      continue;
    }
    // 3) 单行超长（没有行结构的机器输出）：按固定窗口硬切，这是唯一会切开内容的情形
    for (let at = 0; at < unit.text.length; at += maxUnitChars) {
      out.push({ text: unit.text.slice(at, at + maxUnitChars), priority: unit.priority });
    }
  }
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
 * 先按优先级挑，再按从后往前的顺序补齐剩余预算。
 *
 * @param units - `sectionsOf` 产出的单元。
 * @param budget - 可用于内容的字符预算（已扣除说明行等保留量）。
 * @param options - `{ headRatio, tailRatio }`。
 * @returns `{ head, tail, headUnits, tailUnits, omittedUnits, omittedChars }`。
 */
export function pickSections(units, budget, options = {}) {
  const headRatio = options.headRatio ?? 0.55;
  const tailRatio = options.tailRatio ?? 0.35;
  const headBudget = Math.floor(budget * headRatio);
  const tailBudget = Math.max(0, Math.floor(budget * tailRatio));

  // 头部：从头开始整单元累加
  const head = [];
  let headChars = 0;
  let headCount = 0;
  for (const unit of units) {
    const size = unit.text.length + 1;
    if (headChars + size > headBudget) break;
    head.push(unit);
    headChars += size;
    headCount += 1;
  }

  // 尾部：先吃高优先级单元（从后往前），再按原顺序补齐
  const tail = [];
  const taken = new Set();
  let tailChars = 0;
  const candidates = units
    .map((unit, index) => ({ unit, index }))
    .slice(headCount)
    .sort((left, right) => right.unit.priority - left.unit.priority || right.index - left.index);
  for (const { unit, index } of candidates) {
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
  return {
    head: head.map((unit) => unit.text).join('\n'),
    tail: tail.map((item) => item.unit.text).join('\n'),
    headUnits: headCount,
    tailUnits: taken.size,
    omittedUnits: omitted.length,
    omittedChars: omitted.reduce((sum, unit) => sum + unit.text.length + 1, 0),
    omittedUnitsList: omitted,
  };
}
