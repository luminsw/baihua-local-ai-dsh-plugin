/**
 * 视觉链路冒烟测试：
 *  - 构造 adapter（mock attachments：readImage 返回 1x1 红色 PNG）
 *  - monkey-patch global.fetch 抓取首次请求体，校验多模态 content 数组格式
 *  - 走真实 OVMS qwen2.5-vl-3b 推理，确认模型能看图
 * 用法：node scripts/smoke-vision.mjs
 */
import { BaihuaLocalAdapter } from "../src/adapter.js";
import { createCapabilityStore } from "../src/probe.js";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const ref = {
  attachmentId: "test-red-png",
  mediaType: "image/png",
  bytes: 70,
  width: 1,
  height: 1,
  name: "red.png",
};
const fakeAttachments = {
  async readImage(r) {
    if (r.attachmentId !== ref.attachmentId) throw new Error("unknown attachment " + r.attachmentId);
    return { ref: r, data: new Uint8Array(Buffer.from(PNG_B64, "base64")) };
  },
};

const caps = createCapabilityStore({
  ovmsUrl: "http://127.0.0.1:8000/v1",
  baihuaShimUrl: "http://127.0.0.1:8791/mg/ai/v1",
  visionUrl: "http://127.0.0.1:8801",
  defaultMaxTokens: 512,
});
await caps.probe();

const vision = caps.list().find((m) => m.type === "vision" && m.source === "ovms");
if (!vision) {
  console.log("SKIP: no OVMS vision model detected");
  process.exit(0);
}
console.log("using vision model:", vision.id, "endpoint:", vision.endpoint);

const adapter = new BaihuaLocalAdapter(caps, { defaultMaxTokens: 512, timeoutMs: 120000 }, fakeAttachments);

console.log("== listModels（应含视觉模型且带 image 模态） ==");
for (const m of await adapter.listModels("baihua-local")) {
  console.log(`  ${m.id.padEnd(18)} modalities=[${m.inputModalities.join(",")}]`);
}

console.log("== resolveModel 视觉模型 ==");
const info = await adapter.resolveModel("baihua-local", vision.id);
console.log("  inputModalities:", info.inputModalities.join(","));

// 抓包：首次 fetch 的请求体
const realFetch = globalThis.fetch;
let capturedBody = null;
globalThis.fetch = async (url, init) => {
  if (!capturedBody && init?.body) {
    capturedBody = JSON.parse(init.body);
  }
  return realFetch(url, init);
};

console.log("== stream 带图消息（真实推理） ==");
const chunks = [];
for await (const c of adapter.stream({
  provider: "baihua-local",
  model: vision.id,
  system: "你是一个简洁的看图助手，一句话回答。",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "这张图是什么颜色？" },
        { type: "image", attachment: ref },
      ],
    },
  ],
  maxTokens: 64,
})) {
  if (c.type === "text-delta") chunks.push(c.text);
  if (c.type === "finish") console.log("  finish:", JSON.stringify(c.reason));
}
console.log("  answer:", chunks.join(""));

console.log("== wire 格式校验 ==");
const content = capturedBody?.messages?.[1]?.content;
console.log("  content is array:", Array.isArray(content), "len:", content?.length);
const imgPart = content?.find((p) => p.type === "image_url");
console.log("  image_url part:", imgPart ? JSON.stringify({ ...imgPart.image_url, url: imgPart.image_url.url.slice(0, 30) + "..." }) : "(MISSING)");
const dataUrlOk = imgPart?.image_url?.url?.startsWith("data:image/png;base64,") ?? false;
console.log("  dataUrl prefix OK:", dataUrlOk);
if (!Array.isArray(content) || !dataUrlOk) {
  console.log("FAIL: wire format wrong");
  process.exit(1);
}
console.log("== VISION SMOKE OK ==");
