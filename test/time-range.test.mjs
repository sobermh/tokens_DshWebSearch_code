import { strict as assert } from "node:assert";
import test from "node:test";

import { approximateTimeRange, formatKeenableRelative, parseTimeRange } from "../lib/index.js";

test("固定时间范围映射为约定天数", () => {
  assert.deepEqual(parseTimeRange("day"), { days: 1 });
  assert.deepEqual(parseTimeRange("week"), { days: 7 });
  assert.deepEqual(parseTimeRange("month"), { days: 30 });
  assert.deepEqual(parseTimeRange("year"), { days: 365 });
});

test("相对时间和绝对日期被正确解析，无效值不产生时间范围", () => {
  assert.deepEqual(parseTimeRange("12h"), { days: 0.5 });
  assert.deepEqual(parseTimeRange("3d"), { days: 3 });
  assert.deepEqual(parseTimeRange("3w"), { days: 21 });
  assert.deepEqual(parseTimeRange("2mo"), { days: 60 });
  assert.deepEqual(parseTimeRange("1.5y"), { days: 547.5 });
  assert.deepEqual(parseTimeRange("2026-07-01"), { after: "2026-07-01" });
  assert.equal(parseTimeRange("recent-ish"), undefined);
  assert.equal(parseTimeRange({ days: Number.NaN }), undefined);
});

test("固定档引擎选择最近时间档且 Keenable 使用相对格式", () => {
  assert.equal(approximateTimeRange(2), "day");
  assert.equal(approximateTimeRange(14), "week");
  assert.equal(approximateTimeRange(90), "month");
  assert.equal(approximateTimeRange(91), "year");
  assert.equal(formatKeenableRelative(0.5), "12h");
  assert.equal(formatKeenableRelative(7), "7d");
  assert.equal(formatKeenableRelative(60), "2mo");
  assert.equal(formatKeenableRelative(365), "1y");
});
