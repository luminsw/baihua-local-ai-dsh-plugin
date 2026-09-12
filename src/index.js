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
 * 安装：本包是标准 DSH 组合包（package.json 声明 dsh.bundle），执行
 *   dsh plugin --profile web add github:luminsw/baihua-local-ai-dsh-plugin
 * 后由 profile 组合自动应用 cordis.patch.yml 层；配置项按 id 在 profile 的
 * cordis.patch.yml 里覆盖（如 - id: dsh-baihua-local-ai / config: {...}）。
 */
import z from "@deepseek-ai/schemastery";
import { BaihuaLocalAdapter } from "./adapter.js";
import { createCapabilityStore } from "./probe.js";
import { smallTaskTool } from "./tool.js";
import { chatCompletion } from "./chat.js";

export const name = "dsh-baihua-local-ai";
export const inject = ["llm", "tools", "webServer"];

/** 设置页插件卡片命名空间（客户端卡片以同名 key 注册）。 */
const SETTINGS_NS = "baihua-local-ai";

export const Config = z.object({
  /** 注册到 ctx.llm 的提供方路由键。 */
  provider: z.string().default("baihua-local"),
  /** 百花后端服务地址（用于零配置自举拉取 poolUrl/shimUrl）。
   *  注意：三服务合一 + 全容器化后宿主机只暴露 Traefik :80（8788/5177 仅在集群内），
   *  所以这里写 http://127.0.0.1 或 http://<宿主IP>（不带端口）。 */
  familyUrl: z.string().default("http://127.0.0.1"),
  /** OVMS OpenAI 兼容端点（含 /models 与 /chat/completions）。
   *  默认留空 = 不探测：Windows 原生 OVMS 已退役，OVMS 现只在 k3s 内（bh-openvino，
   *  ClusterIP:8000，宿主机不可达）。本机模型请经 baihuaShimUrl / poolUrl 通道暴露。 */
  ovmsUrl: z.string().default(""),
  /** 百花 AI 的 OpenAI 兼容 shim（按模型名路由到本地/云端提供方）。留空=自举。 */
  baihuaShimUrl: z.string().default(""),
  /** 百花视觉服务（如 qwen2.5-vl，经 shim/OVMS 暴露）。默认留空 = 不探测（原 8801 端口已退役）。 */
  visionUrl: z.string().default(""),
  /** 百花算力池统一网关（/mg/pool/v1，按模型名全网路由 + failover）。空=不探测。 */
  poolUrl: z.string().default(""),
  /** 算力池网关鉴权 token（BAIHUA_AI_EXTERNAL_TOKEN 未配置时可留空）。 */
  poolToken: z.string().role("secret").default(""),
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
  token: z.string().role("secret"),
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
  // 设置页表单可改配置：setSource 重绑 current，运行时读最新值（修 setSource no-op bug）。
  let current = () => config;
  ctx.inject(["settings"], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, SETTINGS_NS, Config, config, {
      setSource: (source) => { current = source; },
      onChange: () => {},
    });
  });
  // 零配置自举：从本机 /api/dsh/config 拉 poolUrl/poolToken/baihuaShimUrl（用户显式配置优先）。
  // 不是"只拉一次"：DSH 可能先于百花启动，早期失败会永久留空；这里按 30s 退避重试，
  // 拿到值（或用户已显式配置）后就不再打扰。
  let bootstrap = {};
  let bootstrapAt = 0;
  async function refreshBootstrap(force = false) {
    const c = current();
    const need = force || !(c.poolUrl || bootstrap.poolUrl) || !bootstrap.aiShimUrl;
    if (!need) return;
    if (!force && Date.now() - bootstrapAt < 30_000) return;
    bootstrapAt = Date.now();
    try {
      const base = (c.familyUrl || "http://127.0.0.1").trim().replace(/\/+$/, "");
      const r = await fetch(`${base}/api/dsh/config`, { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.ok) bootstrap = j;
    } catch { /* noop */ }
  }
  const cfg = () => {
    const c = current();
    return {
      ...c,
      poolUrl: c.poolUrl || bootstrap.poolUrl || "",
      poolToken: c.poolToken || bootstrap.poolToken || "",
      baihuaShimUrl: c.baihuaShimUrl || bootstrap.aiShimUrl || "",
      aiUrl: c.aiUrl || bootstrap.aiUrl || "",
    };
  };
  const caps = createCapabilityStore(cfg);

  // ---------- 探测循环 ----------
  const probeSignal = new AbortController();
  const initialProbe = (async () => {
    await refreshBootstrap(true);
    await caps.probe(probeSignal.signal);
  })().catch(() => {});

  // ---------- LLM 提供方注册 ----------
  const attachments = ctx.get("attachments");
  const adapter = new BaihuaLocalAdapter(
    caps,
    cfg,
    attachments,
  );
  const handle = ctx.llm.registerAdapter([cfg().provider], adapter);

  // ---------- 小任务工具 ----------
  const disposeTool = ctx.tools.register(
    smallTaskTool(caps, cfg),
  );

  // ---------- 状态端点 ----------
  const webServer = ctx.get("webServer");
  const statusToken = () => cfg().token;
  function authorized(req) {
    const st = statusToken();
    if (!st) return true;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.searchParams.get("token") === st) return true;
    const header = req.headers?.authorization;
    return typeof header === "string" && header === `Bearer ${st}`;
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
          provider: cfg().provider,
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
              m.type === "vision" && (m.source === "ovms" || m.source === "shim" || m.source === "pool")
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
    cfg().routeAuxiliaryCalls !== "off"
      ? ctx.on("llm/stream", async function* (options, next) {
          const purpose = options.purpose;
          const eligible =
            purpose === "session-title" ||
            (purpose === "compaction" && cfg().routeAuxiliaryCalls === "all");
          if (!eligible || options.provider === cfg().provider) {
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
              maxTokens: Math.min(cfg().defaultMaxTokens, 512),
              temperature: 0.3,
              signal: options.signal,
              timeoutMs: cfg().timeoutMs,
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
    `[dsh-baihua-local-ai] loaded (provider=${cfg().provider}, auxRouting=${cfg().routeAuxiliaryCalls}). ` +
      `等待首次探测…（模型数在探测完成后打印）`,
  );
  // 首次探测完成后再报告模型数（避免启动日志显示 0 个的假象）
  void initialProbe.then(() => {
    const healthy = caps.list().filter((m) => m.healthy);
    const sources = [...new Set(healthy.map((m) => m.source))].join(",") || "无";
    console.log(`[dsh-baihua-local-ai] 首次探测完成：${healthy.length} 个模型在线（来源：${sources}）。`);
  });

  // ---------- 生命周期清理（ctx.effect：插件卸载/热重载时自动执行） ----------
  // 说明：ctx.on / ctx.tools.register / ctx.llm.registerAdapter 等经 ctx 注册的能力
  // 在插件卸载时会被 Cordis 自动清理；这里只需显式清理原始资源（探测定时器、
  // AbortController）与 webServer 路由（register 返回的 disposer 不属于 ctx 注册）。
  ctx.effect(() => {
    const timer =
      cfg().probeIntervalMs > 0
        ? setInterval(() => {
            void (async () => {
              await refreshBootstrap();  // 自举失败（DSH 先起/百花后起）时按退避重试
              await caps.probe(probeSignal.signal);
            })().catch(() => {});
          }, cfg().probeIntervalMs)
        : null;
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
  });
}
