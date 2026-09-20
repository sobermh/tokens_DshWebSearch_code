// fetchHtml 取消语义的回归测试，走真实的 searchBing / searchDdgHtml 代码路径。
//
// 旧实现用 signal.addEventListener("abort", ...) 桥接外部取消。对一个"已经 abort 的
// signal"，规范规定 addEventListener 不会补发事件——于是取消之后发起的重试拿到一个全新的、
// 不受上游预算约束的 12 秒计时器。总预算不只是会被耗尽，是能被突破。
//
// 这些用例在连接建立前就已中止，不依赖网络可达性。
import { strict as assert } from "node:assert";
import test from "node:test";
import { searchBing, searchDdgHtml } from "../lib/index.js";

const engines = [
  ["searchBing", (signal) => searchBing("cancel probe", 3, {}, signal)],
  ["searchDdgHtml", (signal) => searchDdgHtml("cancel probe", 3, {}, signal)],
];

for (const [name, call] of engines) {
  test(`${name}: 已经 abort 的 signal 立即失败`, async () => {
    const started = Date.now();
    await assert.rejects(call(AbortSignal.abort()));
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `应立即失败，实际 ${elapsed}ms`);
  });

  test(`${name}: 传入的超时 signal 会真正掐断请求`, async () => {
    const started = Date.now();
    await assert.rejects(call(AbortSignal.timeout(50)));
    const elapsed = Date.now() - started;
    // 旧实现里单次请求自带 12s 计时器，掐不断 -> 这里必须远小于 12s
    assert.ok(elapsed < 2000, `应在超时后立即失败，实际 ${elapsed}ms`);
  });
}
