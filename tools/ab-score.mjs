/**
 * 行为对照实验的自动判分：把每组的 session id 对号入座，用 `answer-key.json`
 * 逐题判对错，并汇总 token / 工具调用 / 裁剪次数。
 *
 * 用法：
 *   node tools/ab-score.mjs <control.json> <treatment.json> [--fixtures .ab-fixtures]
 *
 * 两个输入都是 `{ "<taskId>": "<sessionId>" }` 的 JSON。判分规则：
 * - 数字型答案：解析后与标准答案数值相等；
 * - 列表型答案：集合完全相等（顺序无关，但不得多、不得少）；
 * - 标记型答案：字符串去空白后相等。
 *
 * @module dsh-tool-token-optimizer/tools/ab-score
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metricsOf } from './session-metrics.mjs';

const args = process.argv.slice(2);
const fixturesAt = args.indexOf('--fixtures');
const fixturesDir = fixturesAt === -1 ? '.ab-fixtures' : args[fixturesAt + 1];
// 位置参数 = 去掉标志位与其取值后的前两个
const positional = args.filter((value, index) => !value.startsWith('--') && index !== fixturesAt + 1);
const controlPath = positional[0];
const treatmentPath = positional[1];
if (controlPath === undefined || treatmentPath === undefined) {
  console.error('usage: node tools/ab-score.mjs <control.json> <treatment.json> [--fixtures .ab-fixtures]');
  process.exit(2);
}

const key = JSON.parse(readFileSync(join(fixturesDir, 'answer-key.json'), 'utf8'));
const control = JSON.parse(readFileSync(controlPath, 'utf8'));
const treatment = JSON.parse(readFileSync(treatmentPath, 'utf8'));

/** 会话日志目录（复用 session-metrics 的读取逻辑，这里直接内联一份最小实现）。 */
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function load(sessionId) {
  // 只接受形如 session id 的取值，避免把路径误当 id
  if (typeof sessionId !== 'string' || !/^[0-9a-zA-Z-]{8,}$/.test(sessionId)) return null;
  const root = join(homedir(), '.dsh', 'sessions');
  for (const workspace of readdirSync(root)) {
    const file = join(root, workspace, sessionId, 'session.v4.jsonl.zstd');
    try {
      statSync(file);
    } catch {
      continue;
    }
    const buffer = readFileSync(file);
    const starts = [];
    let at = buffer.indexOf(MAGIC, 0);
    while (at !== -1) {
      starts.push(at);
      at = buffer.indexOf(MAGIC, at + 4);
    }
    const parts = [];
    for (let index = 0; index < starts.length; index += 1) {
      const end = index + 1 < starts.length ? starts[index + 1] : buffer.length;
      try {
        parts.push(zstdDecompressSync(buffer.subarray(starts[index], end)));
      } catch {
        // 帧内假魔数
      }
    }
    return metricsOf(Buffer.concat(parts).toString('utf8'));
  }
  return null;
}

/**
 * 判分。
 *
 * @param taskId - 任务 id（决定比较方式）。
 * @param expected - 标准答案。
 * @param actual - 模型给出的 ANSWER 文本。
 * @returns `{ pass, note }`。
 */
function score(taskId, expected, actual) {
  if (actual === null || actual === undefined || actual.trim() === '') return { pass: false, note: '无答案' };
  const text = actual.trim();
  if (Array.isArray(expected)) {
    const got = text.split(/\s+/).filter((token) => token !== '');
    const want = new Set(expected);
    const has = new Set(got);
    const missing = [...want].filter((item) => !has.has(item));
    const extra = [...has].filter((item) => !want.has(item));
    return {
      pass: missing.length === 0 && extra.length === 0,
      note: `期望 ${want.size} 项，得到 ${has.size} 项${missing.length > 0 ? `，缺 ${missing.length}` : ''}${extra.length > 0 ? `，多 ${extra.length}` : ''}`,
    };
  }
  if (typeof expected === 'number') {
    const numeric = Number(text.replace(/[^0-9.-]/g, ''));
    return { pass: numeric === expected, note: `期望 ${expected}，得到 ${text.slice(0, 40)}` };
  }
  return { pass: text === expected, note: `期望 ${expected}，得到 ${text.slice(0, 40)}` };
}

const groups = [
  { label: '对照（插件关闭）', map: control },
  { label: '实验（插件启用）', map: treatment },
];
const rows = [];
const summary = new Map();
for (const group of groups) {
  let pass = 0;
  let prompt = 0;
  let requests = 0;
  let elided = 0;
  let bashCalls = 0;
  let readCalls = 0;
  let grepCalls = 0;
  for (const [taskId, expected] of Object.entries(key.answerKey)) {
    const sessionId = group.map[taskId];
    if (sessionId === undefined) {
      rows.push({ group: group.label, taskId, pass: false, note: '缺少 sessionId', prompt: 0, requests: 0, tools: {} });
      continue;
    }
    const metrics = load(sessionId);
    if (metrics === null) {
      rows.push({ group: group.label, taskId, pass: false, note: '日志缺失', prompt: 0, requests: 0, tools: {} });
      continue;
    }
    const verdict = score(taskId, expected, metrics.answer);
    if (verdict.pass) pass += 1;
    prompt += metrics.prompt;
    requests += metrics.requests;
    elided += metrics.elided;
    bashCalls += metrics.toolCalls.bash ?? 0;
    readCalls += metrics.toolCalls.read ?? 0;
    grepCalls += metrics.toolCalls.grep ?? 0;
    rows.push({
      group: group.label,
      taskId,
      pass: verdict.pass,
      note: verdict.note,
      prompt: metrics.prompt,
      requests: metrics.requests,
      tools: metrics.toolCalls,
      elided: metrics.elided,
      answer: metrics.answer,
    });
  }
  summary.set(group.label, { pass, total: Object.keys(key.answerKey).length, prompt, requests, elided, bashCalls, readCalls, grepCalls });
}

console.log('逐题结果：');
console.log('task                       对照    实验   对照prompt  实验prompt  对照裁剪  实验裁剪');
for (const taskId of Object.keys(key.answerKey)) {
  const controlRow = rows.find((row) => row.group.startsWith('对照') && row.taskId === taskId);
  const treatmentRow = rows.find((row) => row.group.startsWith('实验') && row.taskId === taskId);
  const mark = (row) => (row === undefined ? '?' : row.pass ? '✔' : '✖');
  console.log(
    `${taskId.padEnd(26)} ${mark(controlRow).padEnd(6)} ${mark(treatmentRow).padEnd(6)} ` +
      `${String(controlRow?.prompt ?? 0).padStart(11)} ${String(treatmentRow?.prompt ?? 0).padStart(11)} ` +
      `${String(controlRow?.elided ?? 0).padStart(9)} ${String(treatmentRow?.elided ?? 0).padStart(9)}`,
  );
}
console.log('\n汇总：');
for (const [label, item] of summary) {
  console.log(
    `  ${label}：正确 ${item.pass}/${item.total}（${((100 * item.pass) / item.total).toFixed(0)}%）　` +
      `prompt 合计 ${item.prompt.toLocaleString()}　请求 ${item.requests}　` +
      `工具调用 bash=${item.bashCalls} read=${item.readCalls} grep=${item.grepCalls}　裁剪 ${item.elided} 条`,
  );
}
const marks = [];
for (const taskId of Object.keys(key.answerKey)) {
  const controlRow = rows.find((row) => row.group.startsWith('对照') && row.taskId === taskId);
  const treatmentRow = rows.find((row) => row.group.startsWith('实验') && row.taskId === taskId);
  if (controlRow?.pass !== treatmentRow?.pass && treatmentRow !== undefined) {
    marks.push(`  ⚠ ${taskId}: 对照 ${controlRow?.pass ? '正确' : '错误'} / 实验 ${treatmentRow.pass ? '正确' : '错误'} — ${treatmentRow.note}`);
  }
}
console.log(marks.length === 0 ? '\n两条件逐题判定完全一致：无质量差异。' : `\n两条件出现差异：\n${marks.join('\n')}`);
