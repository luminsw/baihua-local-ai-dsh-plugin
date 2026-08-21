/**
 * 独立冒烟测试：不依赖 cordis 上下文，直接跑探测 + 能力表 + 一次真实本地推理。
 * 用法：node scripts/smoke.mjs
 */
import { createCapabilityStore } from "../src/probe.js";
import { chatCompletion, chatCompletionStream } from "../src/chat.js";

const caps = createCapabilityStore({
  ovmsUrl: "http://127.0.0.1:8000/v1",
  baihuaShimUrl: "http://127.0.0.1:8791/mg/ai/v1",
  visionUrl: "http://127.0.0.1:8801",
  defaultMaxTokens: 1024,
});

console.log("== probing ==");
await caps.probe();
for (const m of caps.list()) {
  console.log(`  [${m.healthy ? "OK" : "--"}] ${m.id.padEnd(18)} src=${m.source.padEnd(12)} type=${m.type.padEnd(9)} params=${m.params} ctx=${m.contextWindow}`);
}
const stats = caps.stats();
console.log("stats:", JSON.stringify(stats));

const model = caps.pickChatModel();
console.log("pickChatModel:", model ? model.id : "(none)");
if (!model) {
  console.log("SKIP: no local chat model");
  process.exit(0);
}

console.log("== non-stream chat ==");
const r = await chatCompletion({
  endpoint: model.endpoint,
  model: model.id,
  messages: [
    { role: "system", content: "你是一个简洁的本机助手。" },
    { role: "user", content: "用一句话回答：什么是 OpenVINO？" },
  ],
  maxTokens: 96,
  timeoutMs: 60000,
});
console.log("text:", r.text);
console.log("usage:", JSON.stringify(r.usage), "elapsed:", r.elapsedMs, "ms");

console.log("== stream chat ==");
let streamed = "";
for await (const ev of chatCompletionStream({
  endpoint: model.endpoint,
  model: model.id,
  messages: [{ role: "user", content: "数到 3，用逗号分隔" }],
  maxTokens: 32,
  timeoutMs: 60000,
})) {
  if (ev.kind === "delta") streamed += ev.text;
  if (ev.kind === "done") console.log("done usage:", JSON.stringify(ev.usage), "finish:", ev.finishReason);
}
console.log("streamed text:", streamed);

console.log("== SMOKE OK ==");
