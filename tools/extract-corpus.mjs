/**
 * 从本机 DSH 会话日志解压出回放语料。
 *
 * DSH 把每个会话写成 zstd 分帧的 append-only 日志
 * （`~/.dsh/sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`）。本工具按
 * 帧魔数切分、逐帧 `zstdDecompressSync`，拼成可直接解析的 `.jsonl`。
 *
 * 用法：
 *   node tools/extract-corpus.mjs [输出目录] [sessions 根目录]
 *
 * 默认：输出 `.corpus/raw`，源 `~/.dsh/sessions`。
 *
 * @module dsh-tool-token-optimizer/tools/extract-corpus
 */

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 按 zstd 帧魔数切分一个 append-only 日志。
 *
 * @param buffer - 原始文件内容。
 * @returns 帧数组。
 */
function splitFrames(buffer) {
  const starts = [];
  let at = buffer.indexOf(MAGIC, 0);
  while (at !== -1) {
    starts.push(at);
    at = buffer.indexOf(MAGIC, at + 4);
  }
  const frames = [];
  for (let index = 0; index < starts.length; index += 1) {
    frames.push(buffer.subarray(starts[index], index + 1 < starts.length ? starts[index + 1] : buffer.length));
  }
  return frames;
}

const outDir = process.argv[2] ?? '.corpus/raw';
const root = process.argv[3] ?? join(homedir(), '.dsh', 'sessions');
mkdirSync(outDir, { recursive: true });

let sessions = 0;
let bytes = 0;
for (const workspace of readdirSync(root)) {
  const workspaceDir = join(root, workspace);
  if (!statSync(workspaceDir).isDirectory()) continue;
  for (const id of readdirSync(workspaceDir)) {
    const file = join(workspaceDir, id, 'session.v4.jsonl.zstd');
    let raw;
    try {
      raw = readFileSync(file);
    } catch {
      continue;
    }
    const parts = [];
    for (const frame of splitFrames(raw)) {
      try {
        parts.push(zstdDecompressSync(frame));
      } catch {
        // 帧内出现魔数假阳性：该区间已被上一帧覆盖，跳过。
      }
    }
    const data = Buffer.concat(parts);
    writeFileSync(join(outDir, `${id}.jsonl`), data);
    sessions += 1;
    bytes += data.length;
  }
}
console.log(`${sessions} sessions, ${(bytes / 1e6).toFixed(1)} MB -> ${outDir}`);
