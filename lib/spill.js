/**
 * 可恢复性存储：把**被裁掉的中段**写成一个普通文本文件，说明行里给出路径。
 *
 * 为什么值得做：实测 3,648 次裁剪里 95.5% 没有任何取回路径，模型想看一眼中段
 * 只能重跑整条命令（`read` 的返工率 51.7%，基线 33.1%）。把中段落成文件之后，
 * 「重跑一条命令」变成「read 一个几十行的文件」——同样的信息，成本差一个数量级。
 *
 * 三条硬约束：
 * 1. **任何失败都不抛**：落盘失败只意味着这条结果退回「重跑」提示。
 * 2. **有界**：目录按 TTL + 总字节上限自清，不会把磁盘吃满。
 * 3. **路径短**：路径本身要进上下文，每多一个字都是钱。
 *
 * @module dsh-tool-token-optimizer/spill
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 每写多少次触发一次清理。 */
const SWEEP_EVERY = 200;

/** 两次清理之间的最小间隔。 */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 建一个可恢复性存储。
 *
 * @param options - `{ dir, ttlHours, maxBytes, now, logger }`。
 * @returns `{ record, sweep, root }`。
 */
export function createRecoveryStore(options = {}) {
  const root = typeof options.dir === 'string' && options.dir !== ''
    ? options.dir
    : join(homedir(), '.dsh', 'tto');
  const ttlMs = Math.max(0, Number.isFinite(options.ttlHours) ? options.ttlHours : 168) * 3600 * 1000;
  const maxBytes = Math.max(0, Number.isFinite(options.maxBytes) ? options.maxBytes : 200 * 1024 * 1024);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let lastSweep = 0;
  let writes = 0;

  const sweep = () => {
    try {
      const names = readdirSync(root);
      const files = [];
      let total = 0;
      for (const name of names) {
        const full = join(root, name);
        try {
          const info = statSync(full);
          if (!info.isFile()) continue;
          files.push({ full, size: info.size, mtime: info.mtimeMs });
          total += info.size;
        } catch {
          // 并发删除/权限问题：跳过。
        }
      }
      const cutoff = now() - ttlMs;
      for (const file of files) {
        if (ttlMs > 0 && file.mtime < cutoff) {
          try {
            unlinkSync(file.full);
            total -= file.size;
          } catch {
            // 忽略。
          }
        }
      }
      if (total > maxBytes) {
        files.sort((left, right) => left.mtime - right.mtime);
        for (const file of files) {
          if (total <= maxBytes) break;
          try {
            unlinkSync(file.full);
            total -= file.size;
          } catch {
            // 忽略。
          }
        }
      }
    } catch {
      // 目录还不存在 / 无权限：下次再说。
    }
    lastSweep = now();
  };

  const record = (text) => {
    try {
      if (typeof text !== 'string' || text.length === 0) return null;
      mkdirSync(root, { recursive: true });
      // 内容寻址：同一段中段永远得到同一个路径。既保证"重复处理逐字节相同"，
      // 也让重复裁剪天然去重。文件名 16 位十六进制（64 bit）足够。
      const digest = createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 16);
      const name = `${digest}.txt`;
      const full = join(root, name);
      writeFileSync(full, text, 'utf8');
      writes += 1;
      if (writes % SWEEP_EVERY === 0 || lastSweep === 0) sweep();
      return full;
    } catch {
      return null;
    }
  };

  return { record, sweep, root };
}
