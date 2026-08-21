/**
 * baihua-local-ai-dsh-plugin — 让 DeepSeek Harness 自动使用百花（Baihua）提供的本机 AI。
 *
 * 功能：
 *  1. 自动探测百花本地 AI 服务（OVMS :8000 / 视觉 :8801 / AI shim :8791 / 可选遗留 llm-server 端口段），
 *     维护一张实时能力表（模型类型、参数量、量化、上下文窗口、来源、健康状态）。
 *  2. 把检测到的本地文本模型注册为 DSH 的 LLM 提供方路由（默认 provider 键 baihua-local），
 *     可被模型选择器 / subagent 的 provider/model 覆盖直接使用。
 *  3. 注册 local_ai_small_task 工具：主 agent 把小而有界的任务（短摘要/分类/取词/起标题等）
 *     交给本机 AI，带输入长度与输出 token 护栏，失败时明确回退远程。
 *  4. 可选：把会话标题等辅助 LLM 调用自动路由到本地模型（routeAuxiliaryCalls，失败自动回退远程）。
 *  5. 在 webServer 暴露 GET /dsh-local-ai/status 便于观察。
 *
 * 安装：复制到 $DSH_HOME/profiles/node_modules/，并在 $DSH_HOME/cordis.patch.yml 的 insert 列表加入：
 *   - id: baihua-local-ai
 *     name: 'baihua-local-ai-dsh-plugin'
 *     config: { }
 */
import z from "@deepseek-ai/schemastery";
import { BaihuaLocalAdapter } from "./adapter.js";
import { createCapabilityStore } from "./probe.js";
import { smallTaskTool } from "./tool.js";
import { chatCompletion } from "./chat.js";

export const name = "dsh-baihua-local-ai";
export const inject = ["llm", "tools", "webServer"];

export const Config = z.object({
  /** 注册到 ctx.llm 的提供方路由键。 */
  provider: z.string().default("baihua-local"),
  /** OVMS OpenAI 兼容端点（/v1 前缀，含 /models 与 /chat/completions）。 */
  ovmsUrl: z.string().default("http://127.0.0.1:8000/v1"),
  /** 百花 AI 的 OpenAI 兼容 shim（按模型名路由到本地/云端提供方）。 */
  baihuaShimUrl: z.string().default("http://127.0.0.1:8791/mg/ai/v1"),
  /** 百花视觉服务（Qwen2.5-VL，图片识别）。 */
  visionUrl: z.string().default("http://127.0.0.1:8801"),
  /** 遗留 openvino_llm_server.py 实例扫描（一模型一端口）。默认关闭。 */
  llmServerHost: z.string().default("127.0.0.1"),
  llmServerPorts: z.array(z.number()).default([]),
  llmServerBasePath: z.string().default("/v1"),
  /** 探测周期（ms）。 */
  probeIntervalMs: z.number().default(60_000),
  /** 单次探测超时（ms）。 */
  probeTimeoutMs: z.number().default(5_000),
  /** 本地推理请求超时（ms）。 */
  timeoutMs: z.number().default(120_000),
  /** 本地模型单请求输出 token 上限（adapter 请求未显式给 maxTokens 时的默认）。 */
  defaultMaxTokens: z.number().default(1024),
  /** 小任务工具输出 token 上限。 */
  smallTaskMaxTokens: z.number().default(512),
  /** 小任务工具输入（prompt 内容）字符上限——本地模型上下文有限的硬护栏。 */
  smallTaskMaxPromptChars: z.number().default(8000),
  /** 小任务采样温度（偏低=更稳、更省）。 */
  smallTaskTemperature: z.number().default(0.4),
  /** 按模型 id 覆盖上下文窗口估计（token）：{ "qwen2.5": 32768 }。 */
  contextWindows: z.dict(z.number()).default({}),
  /**
   * 辅助调用路由：'off' | 'session-title'（默认）| 'all'（含 compaction）。
   * 开启后，会话标题等小辅助调用优先走本地模型，失败自动回退远程。
   */
  routeAuxiliaryCalls: z.union([z.const("off"), z.const("session-title"), z.const("all")]).default("session-title"),
  /** 状态端点鉴权 token（留空 = 回环免鉴权，与兄弟插件约定一致）。 */
  token: z.string(),
});

function chunksForText(text, usage, maxTokens) {
  const out = [];
  out.push({ type: "block-start", index: 0, blockType: "text" });
  // 按 64 字符切片模拟流式，避免单块过大
  for (let i = 0; i < text.length; i += 64) {
    out.push({ type: "text-delta", index: 0, text: text.slice(i, i + 64) });
  }
  out.push({ type: "block-end", index: 0, block: { type: "text", text } });
  out.push({ type: "usage", usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } });
  out.push({ type: "finish", reason: { kind: "stop" } });
  return out;
}

export function apply(ctx, config) {
  const caps = createCapabilityStore({
    ovmsUrl: config.ovmsUrl,
    baihuaShimUrl: config.baihuaShimUrl,
    visionUrl: config.visionUrl,
    llmServerHost: config.llmServerHost,
    llmServerPorts: config.llmServerPorts,
    llmServerBasePath: config.llmServerBasePath,
    contextWindows: config.contextWindows,
    defaultMaxTokens: config.defaultMaxTokens,
  });

  // ---------- 探测循环 ----------
  let timer = null;
  const probeSignal = new AbortController();
  void caps.probe(probeSignal.signal).catch(() => {});
  if (config.probeIntervalMs > 0) {
    timer = setInterval(() => {
      void caps.probe(probeSignal.signal).catch(() => {});
    }, config.probeIntervalMs);
  }

  // ---------- LLM 提供方注册 ----------
  const attachments = ctx.get("attachments");
  const adapter = new BaihuaLocalAdapter(
    caps,
    {
      defaultMaxTokens: config.defaultMaxTokens,
      timeoutMs: config.timeoutMs,
    },
    attachments,
  );
  const handle = ctx.llm.registerAdapter([config.provider], adapter);

  // ---------- 小任务工具 ----------
  const disposeTool = ctx.tools.register(
    smallTaskTool(caps, {
      smallTaskMaxTokens: config.smallTaskMaxTokens,
      smallTaskMaxPromptChars: config.smallTaskMaxPromptChars,
      smallTaskTemperature: config.smallTaskTemperature,
      timeoutMs: config.timeoutMs,
    }),
  );

  // ---------- 状态端点 ----------
  const webServer = ctx.get("webServer");
  const statusToken = config.token;
  function authorized(req) {
    if (!statusToken) return true;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("token") === statusToken) return true;
    const header = req.headers?.authorization;
    return typeof header === "string" && header === `Bearer ${statusToken}`;
  }
  const disposeRoute = webServer?.register({
    kind: "exact",
    path: "/dsh-local-ai/status",
    handler: (req, res) => {
      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      const models = caps.list();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          service: "dsh-baihua-local-ai",
          ok: true,
          provider: config.provider,
          models: models.map((m) => ({
            id: m.id,
            source: m.source,
            endpoint: m.endpoint,
            type: m.type,
            params: m.params,
            quant: m.quant ?? null,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            healthy: m.healthy,
            name: m.name ?? null,
            owner: m.owner ?? null,
            inputModalities:
              m.type === "vision" && (m.source === "ovms" || m.source === "shim")
                ? ["text", "image"]
                : ["text"],
          })),
          stats: caps.stats(),
          pid: process.pid,
        }),
      );
    },
  });

  // ---------- 可选：辅助调用路由（会话标题等小调用 → 本地） ----------
  const disposeAuxRoute =
    config.routeAuxiliaryCalls !== "off"
      ? ctx.on("llm/stream", async function* (options, next) {
          const purpose = options.purpose;
          const eligible =
            purpose === "session-title" ||
            (purpose === "compaction" && config.routeAuxiliaryCalls === "all");
          if (!eligible || options.provider === config.provider) {
            yield* next();
            return;
          }
          const model = caps.pickChatModel();
          if (!model) {
            yield* next();
            return;
          }
          const wireMessages = [];
          if (options.system) wireMessages.push({ role: "system", content: options.system });
          for (const m of options.messages) {
            const text = (m.content ?? [])
              .filter((b) => b.type === "text")
              .map((b) => b.text ?? "")
              .join("");
            if (!text) continue;
            wireMessages.push({
              role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user",
              content: text,
            });
          }
          if (!wireMessages.length) {
            yield* next();
            return;
          }
          try {
            const result = await chatCompletion({
              endpoint: model.endpoint,
              model: model.id,
              messages: wireMessages,
              maxTokens: Math.min(config.defaultMaxTokens, 512),
              temperature: 0.3,
              signal: options.signal,
              timeoutMs: config.timeoutMs,
            });
            if (result.text?.trim()) {
              for (const chunk of chunksForText(result.text, result.usage)) {
                yield chunk;
              }
              return;
            }
          } catch {
            /* 本地失败 → 回退远程 */
          }
          yield* next();
        })
      : null;

  console.log(
    `[dsh-baihua-local-ai] loaded (provider=${config.provider}, auxRouting=${config.routeAuxiliaryCalls}). ` +
      `本地模型：${caps.list().filter((m) => m.healthy).length} 个在线。`,
  );

  return () => {
    probeSignal.abort();
    if (timer) clearInterval(timer);
    try {
      handle();
    } catch {
      /* noop */
    }
    try {
      disposeTool();
    } catch {
      /* noop */
    }
    if (disposeRoute) disposeRoute();
    if (disposeAuxRoute) disposeAuxRoute();
  };
}
