// 引擎竞速的回归测试。
//
// 背景：2026-09-16 用户报告搜索连续三次失败，每次恰好 30 秒。根因不是超时值太小，而是
// 串行回退——首选 Bing 的连接挂住后，插件对同一个地址重试 3 次（12s + 1.5s + 12s + 1.5s
// + 3s = 30.0s），把整条链的总预算全部烧光，排在后面的 9 个健康引擎一个请求都没发出去。
//
// 这些用例用假引擎跑，不碰网络。
import { strict as assert } from "node:assert";
import http from "node:http";
import test from "node:test";
import { hedgedRace } from "../lib/hedged-race.js";

const FAST = { hedgeMs: 60, staggerMs: 10 };
const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

// 造一个 runEngine：engines[name] 是返回 Promise 的函数，calls 记录调用顺序
function makeRunner(engines) {
  const calls = [];
  const runEngine = async (engine, raceSignal) => {
    calls.push(engine);
    const behavior = engines[engine];
    if (behavior === undefined) throw new Error(`no fake for ${engine}`);
    return { engine, result: await behavior(raceSignal) };
  };
  return { runEngine, calls };
}

test("首选在 hedge 窗口内返回时，全程只发一个请求", async () => {
  const { runEngine, calls } = makeRunner({
    bing: () => after(5, { sources: ["ok"] }),
    ddg: never,
  });
  const won = await hedgedRace("bing", ["ddg"], [], runEngine, FAST);
  assert.equal(won.engine, "bing");
  assert.deepEqual(calls, ["bing"], "补发不该被触发");
});

test("首选挂死时由竞速引擎秒级接管（旧实现在此处 30 秒报错）", async () => {
  const { runEngine, calls } = makeRunner({
    bing: never, // 连接挂住，永不返回——正是 2026-09-16 的故障形态
    ddg: () => after(20, { sources: ["from-ddg"] }),
    anysearch: never,
  });
  const started = Date.now();
  const won = await hedgedRace("bing", ["ddg", "anysearch"], [], runEngine, FAST);
  const elapsed = Date.now() - started;
  assert.equal(won.engine, "ddg");
  assert.deepEqual(won.result.sources, ["from-ddg"]);
  assert.ok(elapsed < 1000, `应在 1 秒内接管，实际 ${elapsed}ms`);
  assert.ok(calls.includes("bing") && calls.includes("ddg"), "补发应当发生");
});

test("胜出后落败与在途的请求被取消", async () => {
  let loserSignal;
  const { runEngine } = makeRunner({
    bing: never,
    ddg: () => after(20, { sources: ["win"] }),
    anysearch: (raceSignal) => {
      loserSignal = raceSignal;
      return never();
    },
  });
  await hedgedRace("bing", ["ddg", "anysearch"], [], runEngine, FAST);
  await after(30);
  assert.ok(loserSignal?.aborted, "落败引擎应收到 abort");
});

test("免费引擎全灭后才串行尝试兜底引擎", async () => {
  const { runEngine, calls } = makeRunner({
    bing: () => Promise.reject(new Error("boom")),
    ddg: () => Promise.reject(new Error("boom")),
    tavily: () => after(5, { sources: ["paid"] }),
  });
  const won = await hedgedRace("bing", ["ddg"], ["tavily"], runEngine, FAST);
  assert.equal(won.engine, "tavily");
  assert.equal(calls.indexOf("tavily"), 2, "兜底必须排在两个免费引擎之后");
});

test("全部失败返回 null（交由调用方组装带原因的错误）", async () => {
  const { runEngine } = makeRunner({
    bing: () => Promise.reject(new Error("boom")),
    ddg: () => Promise.reject(new Error("boom")),
  });
  assert.equal(await hedgedRace("bing", ["ddg"], [], runEngine, FAST), null);
});

test("首选比 hedge 窗口稍慢也不会被浪费", async () => {
  const { runEngine } = makeRunner({
    bing: () => after(120, { sources: ["slow-but-fine"] }),
    ddg: never,
  });
  const won = await hedgedRace("bing", ["ddg"], [], runEngine, FAST);
  assert.equal(won.engine, "bing", "leader 补发后仍应参与竞速");
});

test("没有补发引擎时，等首选跑完而不是立刻放弃", async () => {
  const { runEngine } = makeRunner({ bing: () => after(120, { sources: ["only"] }) });
  const won = await hedgedRace("bing", [], [], runEngine, FAST);
  assert.equal(won.engine, "bing");
});

// fetchHtml 的取消回归：旧实现用 signal.addEventListener("abort", ...)，
// 对一个"已经 abort 的 signal"不会触发，于是取消后发出的重试拿到一个全新的、
// 不受上游预算约束的 12 秒计时器——预算不只是被耗尽，是能被突破。
test("已 abort 的 signal 不会让请求继续跑（端到端）", async () => {
  const server = http.createServer(() => {}); // 永不响应
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    const aborted = AbortSignal.abort();
    const started = Date.now();
    await assert.rejects(
      fetch(url, { signal: AbortSignal.any([aborted, AbortSignal.timeout(8000)]) }),
      "AbortSignal.any 必须让已 abort 的源立即生效"
    );
    assert.ok(Date.now() - started < 500, "不得等待新计时器");
  } finally {
    server.close();
  }
});
