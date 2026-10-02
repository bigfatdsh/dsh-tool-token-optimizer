/**
 * 会话度量内核：从一份会话日志（JSONL 文本）里聚合出请求数、prompt token 构成、
 * 工具调用分布、结果被裁剪情况与末尾 ANSWER。CLI 与实验判分脚本共用。
 *
 * @module dsh-tool-token-optimizer/metrics
 */

export function metricsOf(text) {
  const toolCalls = new Map();
  let requests = 0;
  let cacheRead = 0;
  let uncached = 0;
  let output = 0;
  let toolResults = 0;
  let toolResultChars = 0;
  let elided = 0;
  let elidedChars = 0;
  let answers = [];
  const steps = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'tool/call') {
      const call = event.data?.call ?? event.data;
      const name = call?.name ?? 'unknown';
      toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
      continue;
    }
    if (event.type === 'tool/result') {
      toolResults += 1;
      const content = event.data?.message?.content ?? [];
      const text2 = content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      toolResultChars += text2.length;
      const notice = /\[…\] omitted (\d+) chars/.exec(text2);
      if (notice !== null) {
        elided += 1;
        elidedChars += Number(notice[1]);
      }
      continue;
    }
    if (event.type === 'assistant/message') {
      if (event.data?.usage !== undefined) {
        requests += 1;
        cacheRead += event.data.usage.cacheReadTokens ?? 0;
        uncached += event.data.usage.inputTokens ?? 0;
        output += event.data.usage.outputTokens ?? 0;
      }
      const text2 = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const answer = /ANSWER=([^\n]*)/.exec(text2);
      if (answer !== null) answers.push(answer[1].trim());
    }
  }
  const prompt = cacheRead + uncached;
  return {
    requests,
    cacheRead,
    uncached,
    prompt,
    output,
    hitPct: prompt === 0 ? 0 : (100 * cacheRead) / prompt,
    toolResults,
    toolResultChars,
    elided,
    elidedChars,
    toolCalls: Object.fromEntries([...toolCalls].sort((a, b) => b[1] - a[1])),
    answer: answers.length > 0 ? answers[answers.length - 1] : null,
  };
}
