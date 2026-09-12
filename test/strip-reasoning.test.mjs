/**
 * stripReasoning 单元测试：推理块剥离与"只有推理、没有答案"的识别。
 * 运行：node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripReasoning } from "../src/tool.js";

test("剥掉成对的 <think> 推理块，保留答案", () => {
  const r = stripReasoning("<think>先想一想</think>答案是铜。");
  assert.equal(r.text, "答案是铜。");
  assert.equal(r.hadReasoning, true);
});

test("剥掉未闭合的推理块（达到 token 上限时的典型形态），答案为空", () => {
  const r = stripReasoning("<think>好的，我需要帮用户概括这段内容，先看关键词……");
  assert.equal(r.text, "");
  assert.equal(r.hadReasoning, true);
  assert.equal(r.truncatedReasoning, true);
});

test("没有推理标记时原样返回（仅 trim）", () => {
  const r = stripReasoning("  直接给出的答案  ");
  assert.equal(r.text, "直接给出的答案");
  assert.equal(r.hadReasoning, false);
  assert.equal(r.truncatedReasoning, false);
});

test("同时存在成对与未闭合推理时，两者都清掉", () => {
  const r = stripReasoning("<think>a</think>答案<think>b");
  assert.equal(r.text, "答案");
  assert.equal(r.hadReasoning, true);
});

test("空输入安全", () => {
  const r = stripReasoning(undefined);
  assert.equal(r.text, "");
  assert.equal(r.hadReasoning, false);
});
