/**
 * 零依赖配置校验：实现 Standard Schema v1（`~standard`）契约。
 *
 * 为什么不直接 `import z from 'zod'`：profile 侧插件由 `pnpm` 安装，能确定解析到的
 * 只有 `node:*` 与包内文件（本机已核实：连 `dsh-session-cost` 这么写的插件也解析不到
 * `zod`）。官方 `dsh-session-cost` 因此自己实现了 Standard Schema，这里沿用同一套做法。
 *
 * 行为要点：
 * - 校验失败返回 `issues`（Cordis 会带着原因拒绝装配，而不是静默用错配置）；
 * - 校验成功返回**补全默认值后**的副本；未知键一律拒绝（能早发现拼错的配置项）；
 * - 没有外部依赖，因此单元测试与宿主内运行是同一段代码。
 *
 * @module dsh-tool-token-optimizer/schema
 */

/** 一个字段的定义：类型、默认值与取值范围。 */
class Field {
  /**
   * @param options - `{ kind, default, min, max, integer, items, shape, optional }`。
   */
  constructor(options) {
    this.kind = options.kind;
    this.default = options.default;
    this.min = options.min;
    this.max = options.max;
    this.integer = options.integer === true;
    this.items = options.items;
    this.shape = options.shape;
    this.optional = options.optional === true;
    this.present = Object.hasOwn(options, 'default');
  }

  /**
   * 校验一个值。
   *
   * @param value - 待校验值。
   * @param path - 报错用的字段路径。
   * @returns `{ value }` 或 `{ issues }`。
   */
  validate(value, path) {
    if (value === undefined) {
      // 有默认值时用默认值继续走一遍校验：嵌套对象的默认值本身也需要补全
      // 内层字段，直接返回 clone(default) 会让内层默认值整块丢失。
      if (this.present) return this.validate(clone(this.default), path);
      if (this.optional) return { value: undefined };
      return { issues: [{ message: `${path} is required`, path: [path] }] };
    }
    if (this.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { issues: [{ message: `${path} must be a finite number`, path: [path] }] };
      }
      if (this.integer && !Number.isInteger(value)) {
        return { issues: [{ message: `${path} must be an integer`, path: [path] }] };
      }
      if (this.min !== undefined && value < this.min) {
        return { issues: [{ message: `${path} must be ≥ ${this.min}`, path: [path] }] };
      }
      if (this.max !== undefined && value > this.max) {
        return { issues: [{ message: `${path} must be ≤ ${this.max}`, path: [path] }] };
      }
      return { value };
    }
    if (this.kind === 'boolean') {
      if (typeof value !== 'boolean') return { issues: [{ message: `${path} must be a boolean`, path: [path] }] };
      return { value };
    }
    if (this.kind === 'string') {
      if (typeof value !== 'string') return { issues: [{ message: `${path} must be a string`, path: [path] }] };
      return { value };
    }
    if (this.kind === 'array') {
      if (!Array.isArray(value)) return { issues: [{ message: `${path} must be an array`, path: [path] }] };
      const out = [];
      for (const [index, item] of value.entries()) {
        const result = this.items.validate(item, `${path}[${index}]`);
        if (result.issues !== undefined) return result;
        out.push(result.value);
      }
      return { value: out };
    }
    if (this.kind === 'record') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: `${path} must be an object`, path: [path] }] };
      }
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        const result = this.items.validate(item, `${path}.${key}`);
        if (result.issues !== undefined) return result;
        out[key] = result.value;
      }
      return { value: out };
    }
    if (this.kind === 'object') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: `${path} must be an object`, path: [path] }] };
      }
      const unknown = Object.keys(value).filter((key) => !Object.hasOwn(this.shape, key));
      if (unknown.length > 0) {
        return {
          issues: [
            {
              message: `${path} has unknown keys: ${unknown.join(', ')} (allowed: ${Object.keys(this.shape).join(', ')})`,
              path: [path],
            },
          ],
        };
      }
      const out = {};
      const issues = [];
      for (const [key, field] of Object.entries(this.shape)) {
        // 字段给出默认值且配置里省略时，用默认值——这一层在对象字段（如嵌套对象）上
        // 同样成立，否则嵌套默认值会被整块丢掉。
        const given = value[key] === undefined && field.present ? field.default : value[key];
        const result = field.validate(given, `${path}.${key}`);
        if (result.issues !== undefined) issues.push(...result.issues);
        else if (result.value !== undefined) out[key] = result.value;
      }
      if (issues.length > 0) return { issues };
      return { value: out };
    }
    return { issues: [{ message: `${path} has an unsupported schema kind`, path: [path] }] };
  }
}

/** 深拷贝默认值（默认值里含对象/数组，直接共享会在多次装配间串味）。 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

/**
 * 建一个对象 schema。
 *
 * @param shape - 字段表。
 * @param options - `{ default }`；给出默认值时该字段可省略。
 * @returns 带 `~standard` 的 Field，可直接交给 Cordis 当 `Config` 用。
 */
export function object(shape, options = {}) {
  const field = new Field({ kind: 'object', shape, default: options.default });
  field['~standard'] = {
    version: 1,
    vendor: 'dsh-tool-token-optimizer',
    /**
     * 校验并补全默认值。
     *
     * @param value - 待校验的配置。
     * @returns `{ value }` 或 `{ issues }`。
     */
    validate(value) {
      if (value === undefined) value = {};
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }
      const result = field.validate(value, 'config');
      return result.issues !== undefined ? { issues: result.issues } : { value: result.value };
    },
  };
  return field;
}

/** 数字字段。 */
export const number = (options = {}) => new Field({ kind: 'number', ...options });
/** 布尔字段。 */
export const boolean = (options = {}) => new Field({ kind: 'boolean', ...options });
/** 字符串字段。 */
export const string = (options = {}) => new Field({ kind: 'string', ...options });
/** 数组字段。 */
export const array = (items, options = {}) => new Field({ kind: 'array', items, ...options });
/** 映射字段（键任意、值同类型）。 */
export const record = (items, options = {}) => new Field({ kind: 'record', items, ...options });
