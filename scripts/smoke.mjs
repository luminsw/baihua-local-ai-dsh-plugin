/**
 * 独立冒烟测试：不依赖 cordis 上下文，直接跑探测 + 能力表 + 一次真实本地推理。
 *
 * 用法：
 *   node scripts/smoke.mjs                 # 经 Traefik :80 自举（本机默认 http://127.0.0.1）
 *   BAIHUA_FAMILY_URL=http://192.168.3.9 node scripts/smoke.mjs
 *   OVMS_URL=http://127.0.0.1:8000/v1 node scripts/smoke.mjs   # 仅在能直连 OVMS 时才需要
 *
 * 架构提示（2026-09）：Windows 原生 OVMS 已退役，OVMS 只在 k3s 内（宿主机不可达 :8000），
 * 宿主机唯一入口是 Traefik :80。因此默认只经 shim / 算力池通道探测本地模型。
 */
import { createCapabilityStore } from "../src/probe.js";
import { chatCompletion, chatCompletionStream } from "../src/chat.js";

const familyUrl = (process.env.BAIHUA_FAMILY_URL || "http://127.0.0.1").trim().replace(/\/+$/, "");

// 零配置自举：从 /api/dsh/config 拿 poolUrl / aiShimUrl / token
let bootstrap = {};
try {
  const r = await fetch(`${familyUrl}/api/dsh/config`, { cache: "no-store" });
  if (r.ok) {
    const j = await r.json();
    if (j && j.ok) bootstrap = j;
  }
} catch {
  /* 百花没起也能继续（下面会报告无可用模型） */
}
console.log("familyUrl:", familyUrl, "bootstrap:", JSON.stringify({
  aiShimUrl: bootstrap.aiShimUrl ?? "",
  poolUrl: bootstrap.poolUrl ?? "",
}));

const caps = createCapabilityStore({
  ovmsUrl: process.env.OVMS_URL || "",
  baihuaShimUrl: bootstrap.aiShimUrl || "",
  visionUrl: "",
  poolUrl: bootstrap.poolUrl || "",
  poolToken: bootstrap.poolToken || "",
  defaultMaxTokens: 1024,
});

console.log("== probing ==");
await caps.probe();
for (const m of caps.list()) {
  console.log(`  [${m.healthy ? "OK" : "--"}] ${m.id.padEnd(24)} src=${m.source.padEnd(12)} type=${m.type.padEnd(9)} params=${m.params} ctx=${m.contextWindow}`);
}
const stats = caps.stats();
console.log("stats:", JSON.stringify(stats));

const model = caps.pickChatModel();
console.log("pickChatModel:", model ? model.id : "(none)");
if (!model) {
  console.log("SKIP: 没有可用的本地聊天模型");
  console.log("提示：本机 OVMS 只在 k3s 内，需先把它注册成百花的 AI 提供方");
  console.log("      （WebUI → AI 设置 → 添加 OpenAI 兼容提供方，baseUrl 填 http://bh-openvino:8000/v3），");
  console.log("      这样 /mg/ai/v1（shim）才会列出本地模型。");
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
