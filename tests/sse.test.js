import { test } from "node:test";
import assert from "node:assert/strict";

import { SseTranslator } from "../lib/sse.js";

class FakeResponse {
  constructor() { this.chunks = []; this.ended = false; }
  write(chunk) { this.chunks.push(chunk); }
  end() { this.ended = true; }
}

function events(res) {
  return res.chunks.flatMap((chunk) => String(chunk).trim().split("\n\n")).map((block) => {
    const line = block.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : null;
  }).filter(Boolean);
}

test("SseTranslator keeps usage from final choices-empty chunk", () => {
  const res = new FakeResponse();
  let completedUsage = null;
  const translator = new SseTranslator(res, { model: "deepseek-v4-pro", onComplete: (usage) => { completedUsage = usage; } });

  translator.feed({ choices: [{ delta: { content: "ok" } }] });
  translator.feed({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 } });
  translator.done();

  const completed = events(res).find((event) => event.type === "response.completed");
  assert.equal(res.ended, true);
  assert.equal(completed.response.usage.input_tokens, 10);
  assert.equal(completed.response.usage.output_tokens, 2);
  assert.equal(completed.response.usage.total_tokens, 12);
  assert.equal(completed.response.usage.deepseek.prompt_cache_hit_tokens, 4);
  assert.equal(completedUsage.total_tokens, 12);
});
