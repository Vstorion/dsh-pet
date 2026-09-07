// renderMarkdown 冒烟测试：任务框内回答的轻量 Markdown 渲染（零依赖，两端共用）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown } from './task.ts';

test('加粗与斜体', () => {
  assert.equal(renderMarkdown('**你好**'), '<p><strong>你好</strong></p>');
  assert.equal(renderMarkdown('中*斜体*文'), '<p>中<em>斜体</em>文</p>');
});

test('行内代码不受加粗影响', () => {
  assert.equal(renderMarkdown('`a**b`'), '<p><code>a**b</code></p>');
});

test('围栏代码块原样保留', () => {
  assert.equal(renderMarkdown('```\n**不渲染**\n```'), '<pre><code>**不渲染**</code></pre>');
});

test('标题/列表/引用/分隔线', () => {
  const out = renderMarkdown('# 标题\n- 甲\n- 乙\n> 引用\n---');
  assert.ok(out.includes('<h1>标题</h1>'));
  assert.ok(out.includes('<ul><li>甲</li><li>乙</li></ul>'));
  assert.ok(out.includes('<blockquote>引用</blockquote>'));
  assert.ok(out.includes('<hr>'));
});

test('链接仅放行 http/https', () => {
  const good = renderMarkdown('[官网](https://example.com)');
  assert.ok(good.includes('<a href="https://example.com"'));
  const bad = renderMarkdown('[x](javascript:alert(1))');
  assert.ok(!bad.includes('<a'));
});

test('HTML 先转义防注入', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('连续行合并为段落', () => {
  assert.equal(renderMarkdown('第一行\n第二行'), '<p>第一行<br>第二行</p>');
});
