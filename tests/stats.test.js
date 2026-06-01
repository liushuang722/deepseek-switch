import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { estimateCost, getStats, normalizeUsage, recordUsage, resetStats, setStatsPathForTests } from "../lib/stats.js";

function useTempStats() {
  const file = path.join(os.tmpdir(), `deepseek-switch-stats-${Date.now()}-${Math.random()}.json`);
  setStatsPathForTests(file);
  resetStats();
  return file;
}

test("normalizeUsage maps token and cache fields", () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 100, completion_tokens: 25, total_tokens: 125, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 }), {
    input: 100,
    output: 25,
    total: 125,
    cacheHit: 40,
    cacheMiss: 60,
    cacheReported: true,
  });
});

test("estimateCost uses cache split when reported", () => {
  const cost = estimateCost(
    { input: 100, output: 50, total: 150, cacheHit: 40, cacheMiss: 60, cacheReported: true },
    { currency: "USD", inputPerMTok: 2, cacheHitInputPerMTok: 0.5, outputPerMTok: 8 }
  );
  assert.equal(cost.configured, true);
  assert.equal(cost.currency, "USD");
  assert.equal(cost.estimated, 0.00054);
});

test("recordUsage aggregates cache hit rate and reset clears stats", () => {
  useTempStats();
  recordUsage({
    model: "deepseek-v4-pro",
    stream: true,
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 25, prompt_cache_miss_tokens: 75 },
    pricing: { currency: "USD", inputPerMTok: 1, cacheHitInputPerMTok: 0.1, outputPerMTok: 2 },
  });

  const stats = getStats({ pricing: { currency: "USD", inputPerMTok: 1, cacheHitInputPerMTok: 0.1, outputPerMTok: 2 } });
  assert.equal(stats.requests, 1);
  assert.equal(stats.tokens.total, 150);
  assert.equal(stats.cache.reported, true);
  assert.equal(stats.cache.hitRate, 0.25);
  assert.equal(stats.lastRequest.stream, true);

  resetStats();
  assert.equal(getStats().requests, 0);
});

test("getStats filters today month and all ranges", () => {
  useTempStats();
  const pricing = { currency: "USD", inputPerMTok: 1, cacheHitInputPerMTok: 0.1, outputPerMTok: 2 };
  recordUsage({ model: "deepseek-v4-pro", createdAt: "2026-05-22T01:00:00Z", usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 }, pricing });
  recordUsage({ model: "deepseek-v4-pro", createdAt: "2026-05-10T01:00:00Z", usage: { prompt_tokens: 20, completion_tokens: 5, prompt_cache_hit_tokens: 8, prompt_cache_miss_tokens: 12 }, pricing });
  recordUsage({ model: "deepseek-v4-flash", createdAt: "2026-04-10T01:00:00Z", usage: { prompt_tokens: 30, completion_tokens: 5, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 }, pricing });

  const now = new Date("2026-05-22T12:00:00Z");
  assert.equal(getStats({ pricing }, { range: "today", now }).requests, 1);
  assert.equal(getStats({ pricing }, { range: "month", now }).requests, 2);
  assert.equal(getStats({ pricing }, { range: "all", now }).requests, 3);
});

test("getStats groups usage by model", () => {
  useTempStats();
  recordUsage({ model: "deepseek-v4-pro", usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } });
  recordUsage({ model: "deepseek-v4-flash", usage: { prompt_tokens: 20, completion_tokens: 6, prompt_cache_hit_tokens: 5, prompt_cache_miss_tokens: 15 } });
  recordUsage({ model: "deepseek-v4-pro", usage: { prompt_tokens: 30, completion_tokens: 7, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 20 } });

  const stats = getStats({}, { range: "all" });
  const pro = stats.models.find((item) => item.model === "deepseek-v4-pro");
  const flash = stats.models.find((item) => item.model === "deepseek-v4-flash");
  assert.equal(pro.requests, 2);
  assert.equal(pro.tokens.cacheHit, 14);
  assert.equal(pro.tokens.cacheMiss, 26);
  assert.equal(pro.tokens.output, 12);
  assert.equal(pro.tokens.total, 52);
  assert.equal(flash.requests, 1);
});

test("legacy aggregate stats still read", () => {
  const file = useTempStats();
  fs.writeFileSync(file, JSON.stringify({ requests: 2, tokens: { input: 10, output: 4, total: 14, cacheHit: 3, cacheMiss: 7 }, cost: { estimated: 0 }, updatedAt: "2026-05-22T00:00:00Z" }), "utf8");
  const stats = getStats({}, { range: "all" });
  assert.equal(stats.requests, 2);
  assert.equal(stats.tokens.total, 14);
});
