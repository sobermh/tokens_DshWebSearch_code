// 引擎竞速：把"串行回退"换成"并发竞速"的核心算法。
//
// 刻意不依赖本插件的其余部分，也不依赖 harness——它只跟 Promise 和 AbortSignal 打交道，
// 因此可以脱离 node_modules 单测。
//
// FETCH_TIMEOUT_MS 由 lib/index.js 的 fetchHtml 使用，其余三个常量由竞速本身使用。

// 单次 HTTP 抓取上限。竞速下不需要给单个引擎留重试余量，8s 足以区分"慢"和"挂住"。
const FETCH_TIMEOUT_MS = 8000;
// 单个引擎的总上限（含解析）。超过即判负，由竞速中的其他引擎接管。
const PER_ENGINE_MS = 8000;
// 首选引擎的独占窗口：这段时间内出结果就直接用它，全程只发一个请求。
const HEDGE_MS = 1200;
// 补发时引擎之间的错峰间隔，避免同时打到同一批站点触发限流。
const STAGGER_MS = 250;

// 引擎竞速（hedged request）。
//
// 旧的串行回退有个致命点：一个引擎挂住就吃光整条链的总预算，排在后面的引擎一个请求都发不
// 出去——十个引擎的冗余等于零。竞速把总延迟从"所有失败者耗时之和"变成"最快那个健康引擎"，
// 挂住的引擎只是一个永远不会赢的 promise，代价归零。
//
// leader 先独占 hedgeMs：赢了就全程只发一个请求（正常情况下根本触发不到补发）。超时或失败
// 才并发补发 racers，彼此错峰 staggerMs 避免同时打到同一批站点触发限流。免费引擎全灭之后，
// 才串行尝试 lastResort（付费/带 key 的引擎并发打会产生费用）。
//
// runEngine(engine, raceSignal) 需返回 { engine, result } 或抛错；raceSignal 在胜负已分时
// abort，用于取消落败与在途的请求。全部失败返回 null，由调用方组装错误信息。
async function hedgedRace(leader, racers, lastResort, runEngine, options = {}) {
  const hedgeMs = options.hedgeMs ?? HEDGE_MS;
  const staggerMs = options.staggerMs ?? STAGGER_MS;
  const outerSignal = options.signal;
  const ctrl = new AbortController();
  const HEDGE = Symbol("hedge");
  try {
    const leaderRun = runEngine(leader, ctrl.signal);
    let won = await Promise.race([
      leaderRun.catch(() => HEDGE),
      new Promise((resolve) => setTimeout(() => resolve(HEDGE), hedgeMs)),
    ]);
    if (won === HEDGE && racers.length > 0) {
      const staggered = racers.map((engine, index) =>
        (async () => {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, index * staggerMs));
          if (ctrl.signal.aborted) throw new Error("superseded");
          return await runEngine(engine, ctrl.signal);
        })()
      );
      // leaderRun 仍在跑，一并参与——它可能只是比 hedgeMs 稍慢，没必要浪费。
      won = await Promise.any([leaderRun, ...staggered]).catch(() => HEDGE);
    } else if (won === HEDGE) {
      won = await leaderRun.catch(() => HEDGE);
    }
    if (won === HEDGE) {
      for (const engine of lastResort) {
        if (outerSignal?.aborted) throw new Error("search aborted");
        try {
          return await runEngine(engine, ctrl.signal);
        } catch {
          // 失败原因由 runEngine 自行记录，继续下一个
        }
      }
      return null;
    }
    return won;
  } finally {
    // 胜负已分：取消落败与在途的请求，不留悬挂连接。
    ctrl.abort();
  }
}

export { FETCH_TIMEOUT_MS, HEDGE_MS, PER_ENGINE_MS, STAGGER_MS, hedgedRace };
