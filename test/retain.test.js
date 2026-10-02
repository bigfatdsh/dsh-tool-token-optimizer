/**
 * 有界保留测试：证明「裁掉的中段一定可以按说明取回」，且头、尾、可疑行、富内容
 * 都不受损失。
 *
 * @module dsh-tool-token-optimizer/test/retain
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { ELISION_PREFIX, elisionNotice, findRecoveryPath, isImportantLine, retainContent, retainMiddle } from '../lib/retain.js';

test('isImportantLine 命中失败信号，不误伤普通行', () => {
  const important = [
    'Error: ENOENT no such file',
    'TypeError: x is not a function',
    '  at Object.<anonymous> (/tmp/a.js:1:1)',
    'FAIL src/a.test.js',
    'not ok 3 - should work',
    'warning: deprecated API',
    '[exit code: 1]',
    'Traceback (most recent call last):',
  ];
  for (const line of important) assert.equal(isImportantLine(line), true, line);
  const normal = [
    'errorRate: 0.5',
    '0 errors found',
    'no warnings',
    'successfully built 12 packages',
    'file.js:12 const x = 1',
    '',
  ];
  for (const line of normal) assert.equal(isImportantLine(line), false, line);
});

test('findRecoveryPath 认出 DSH 自己写的两种可恢复路径', () => {
  assert.equal(
    findRecoveryPath('body\n[output truncated; full output: /tmp/dsh-subprocess-1-stdout.log]'),
    '/tmp/dsh-subprocess-1-stdout.log',
  );
  assert.equal(
    findRecoveryPath('x\n\n(Full formatted result stored at: /var/folders/x/dsh-spill-a/s/1-query.txt. Use read with offset/limit.)'),
    '/var/folders/x/dsh-spill-a/s/1-query.txt',
  );
  assert.equal(findRecoveryPath('no path here'), null);
});

test('retainMiddle 保留头、尾与全部可疑行，且说明里给出精确省略量', () => {
  const head = Array.from({ length: 200 }, (_, index) => `head line ${index} ${'x'.repeat(40)}`).join('\n');
  const tail = Array.from({ length: 200 }, (_, index) => `tail line ${index} ${'y'.repeat(40)}`).join('\n');
  const middle = Array.from({ length: 400 }, (_, index) => `middle line ${index} ${'z'.repeat(40)}`).join('\n');
  const withError = `${middle}\nException: boom happened here`;
  const text = `${head}\n${withError}\n${tail}`;
  const result = retainMiddle(text, { maxChars: 3000, minTailChars: 300, recovery: 're-run bash' });
  assert.equal(result.changed, true);
  assert.ok(result.text.length <= 3000, `不得超出预算: ${result.text.length}`);
  assert.ok(result.text.startsWith('head line 0'), '头部保留');
  assert.ok(result.text.endsWith(tail.split('\n').pop()), '尾部保留');
  assert.equal(result.text.includes('re-run bash'), true, '取回提示必须出现');
  // 可疑行要么落在被保留的单元里（那就本来就在），要么被补回内联文本。
  // 两种情况都必须"看得见"——这是不变量的实质。
  assert.equal(result.text.includes('Exception: boom happened here'), true, '中段里的报错必须可见');
  assert.ok(result.importantKept >= 1 || result.text.includes('Exception: boom happened here'));
  const notice = new RegExp(`\\${ELISION_PREFIX} omitted (\\d+) chars / (\\d+) lines of ${text.length}`).exec(result.text);
  assert.ok(notice !== null, '说明必须给出省略字符数与行数');
  assert.ok(Number(notice[1]) > 0);
});

test('retainMiddle 只在超预算时动手，且永不放大', () => {
  const small = 'short text';
  assert.equal(retainMiddle(small, { maxChars: 100 }).changed, false);
  const text = 'a'.repeat(5000);
  const result = retainMiddle(text, { maxChars: 1000, recovery: 'x' });
  assert.equal(result.changed, true);
  assert.ok(result.text.length < text.length);
  // 极端预算：即使预算小到放不下说明，也不允许结果比原文更长。
  const tiny = retainMiddle(text, { maxChars: 1, recovery: 're-run bash' });
  assert.ok(tiny.text.length <= text.length);
});

test('retainMiddle 保留尾部里的 DSH 可恢复路径', () => {
  const body = Array.from({ length: 500 }, (_, index) => `line ${index} ${'q'.repeat(60)}`).join('\n');
  const text = `${body}\n[output truncated; full output: /tmp/dsh-subprocess-9-stdout.log]`;
  const path = findRecoveryPath(text);
  const result = retainMiddle(text, { maxChars: 2000, minTailChars: 300, recovery: `full text: ${path}` });
  assert.equal(result.changed, true);
  assert.equal(result.text.includes(path), true, '可恢复路径必须原样保留');
});

test('retainContent 不动富内容块，只按比例裁文本块', () => {
  const image = { type: 'image', attachment: { mediaId: 'a' } };
  const content = [
    { type: 'text', text: 'x'.repeat(4000) },
    image,
    { type: 'text', text: 'y'.repeat(4000) },
  ];
  const result = retainContent(content, { maxChars: 1200, minBlockChars: 300, recovery: 'hint' });
  assert.equal(result.changed, true);
  assert.equal(result.content.length, 3);
  assert.equal(result.content[1], image, '图片块必须原对象保留');
  for (const block of result.content.filter((item) => item.type === 'text')) {
    assert.ok(block.text.length <= 1200);
  }
});

test('retainContent 在总长未超预算时一个字节都不改', () => {
  const content = [{ type: 'text', text: 'small' }];
  const result = retainContent(content, { maxChars: 1000 });
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
});

test('elisionNotice 同时给出省略量、可疑行数与取回方式', () => {
  const notice = elisionNotice({ chars: 1234, lines: 56, total: 7890, important: 3, recovery: 're-run bash' });
  assert.equal(notice, '[…] omitted 1234 chars / 56 lines of 7890; 3 error/warning lines were in the omitted middle; re-run bash');
  const bare = elisionNotice({ chars: 1, lines: 1, total: 2, important: 0 });
  assert.equal(bare.includes('re-run this tool call to get the full text'), true);
});
