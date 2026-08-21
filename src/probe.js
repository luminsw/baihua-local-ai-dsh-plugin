/**
 * probe.js — 百花本地 AI 服务探测与能力表。
 *
 * 职责：
 *  - 探测 OVMS（OpenVINO Model Server，默认 127.0.0.1:8000/v1，OpenAI 兼容）
 *  - 探测百花 AI 的 OpenAI 兼容 shim（默认 127.0.0.1:8791/mg/ai/v1，按模型名路由到本地/云端提供方）
 *  - 探测视觉服务（默认 127.0.0.1:8801，Qwen2.5-VL 图片识别）
 *  - 可选：探测遗留 openvino_llm_server.py 端口段（8001-8030）
 *  - 为每个模型建立能力条目（类型/参数量/量化/上下文窗口/来源/端点），并维护可选的
 *    一次"轻量测速"延迟缓存。
 *
 * 探测原则：全部静默容错——任何服务不可达都不影响插件加载，能力表如实反映"当前可用"。
 */
import net from "node:net";

/** 按模型 id 推断上下文窗口（token）。本地小模型普遍 8K-32K，Qwen2.5 系列官方 32K。
 *  这是一个保守估计表，可在插件配置的 contextWindows 里逐模型覆盖。 */
const DEFAULT_CONTEXT_WINDOWS = {
  "qwen2.5": 32768,
  "qwen2.5-vl-3b": 32768,
  "qwen2.5-vl-7b": 32768,
  "bge-small-zh": 512,
};

/** 按模型 id 推断参数规模（用于能力展示与"小任务选型"参考）。 */
const DEFAULT_PARAMS = {
  "qwen2.5": "7B",
  "qwen2.5-vl-3b": "3B",
  "qwen2.5-vl-7b": "7B",
  "bge-small-zh": "24M",
};

function classifyModel(id) {
  const low = id.toLowerCase();
  if (low.includes("vl") || low.includes("vision")) return "vision";
  if (low.includes("bge") || low.includes("embed") || low.includes("e5")) return "embedding";
  return "text";
}

function isKnownLocalOwner(owner) {
  const o = (owner ?? "").toLowerCase();
  return ["ollama", "llama.cpp", "llamafile", "lmstudio", "openvino", "ovms"].some((k) => o.includes(k));
}

async function fetchJson(url, { timeoutMs = 5000, signal, headers } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason ?? new Error("cancelled"));
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { signal: ac.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** TCP 端口存活探测（用于遗留 openvino_llm_server 扫描）。 */
async function portOpen(host, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/** 探测 OVMS：GET {base}/models → { data: [{ id, owned_by }] } */
async function probeOvms(ovmsBase, caps, signal) {
  try {
    const json = await fetchJson(`${ovmsBase}/models`, { signal });
    const list = Array.isArray(json?.data) ? json.data : [];
    for (const m of list) {
      const id = String(m.id ?? "");
      if (!id) continue;
      caps.upsert({
        id,
        source: "ovms",
        endpoint: ovmsBase,
        type: classifyModel(id),
        owner: String(m.owned_by ?? "OVMS"),
      });
    }
  } catch (err) {
    caps.noteError("ovms", err);
  }
}

/** 探测百花 AI shim：GET {base}/models → { data: [{ id, owned_by }] }。
 *  只收录"看起来是本地"的提供方（ollama/llama.cpp/lmstudio/openvino 等），
 *  云端模型（deepseek 等）不在 token 节省目标内，跳过。 */
async function probeShim(shimBase, caps, signal) {
  try {
    const json = await fetchJson(`${shimBase}/models`, { signal });
    const list = Array.isArray(json?.data) ? json.data : [];
    for (const m of list) {
      const id = String(m.id ?? "");
      const owner = String(m.owned_by ?? "");
      if (!id) continue;
      if (!isKnownLocalOwner(owner)) continue; // 云端模型跳过
      caps.upsert({
        id,
        source: "shim",
        endpoint: shimBase,
        type: classifyModel(id),
        owner,
      });
    }
  } catch (err) {
    caps.noteError("shim", err);
  }
}

/** 探测视觉服务：GET {base}/health → { ok, models:[{id,name,exists}], loaded:[...] } */
async function probeVision(visionBase, caps, signal) {
  try {
    const json = await fetchJson(`${visionBase}/health`, { signal });
    if (json?.ok !== true) return;
    const models = Array.isArray(json.models) ? json.models : [];
    const loaded = Array.isArray(json.loaded) ? json.loaded : [];
    for (const m of models) {
      const id = String(m.id ?? "");
      if (!id) continue;
      caps.upsert({
        id,
        source: "vision",
        endpoint: visionBase,
        type: "vision",
        owner: "baihua-vision",
        name: String(m.name ?? ""),
        loaded: loaded.includes(id),
      });
    }
  } catch (err) {
    caps.noteError("vision", err);
  }
}

/** 探测百花算力池统一网关：GET {base}/models → 全网可用模型（本机+对端，按模型名全网路由/failover）。
 *  与 shim 不同：pool 收录全部模型（含 deepseek 官方路由），供 DSH 直接选用全网算力。 */
async function probePool(poolBase, caps, signal, token = "") {
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    const json = await fetchJson(`${poolBase}/models`, { signal, headers });
    const list = Array.isArray(json?.data) ? json.data : [];
    for (const m of list) {
      const id = String(m.id ?? "");
      if (!id) continue;
      caps.upsert({
        id,
        source: "pool",
        endpoint: poolBase,
        type: classifyModel(id),
        owner: "baihua-pool",
        token,
      });
    }
  } catch (err) {
    caps.noteError("pool", err);
  }
}

/** 探测遗留 openvino_llm_server.py 实例端口段（一模型一端口，OpenAI 兼容）。 */
async function probeLlmServers({ host = "127.0.0.1", ports = [], basePath = "/v1" }, caps, signal) {
  for (const port of ports) {
    if (signal?.aborted) return;
    let open = false;
    try {
      open = await portOpen(host, port);
    } catch {
      open = false;
    }
    if (!open) continue;
    try {
      const json = await fetchJson(`http://${host}:${port}${basePath}/models`, { signal, timeoutMs: 3000 });
      const list = Array.isArray(json?.data) ? json.data : [];
      for (const m of list) {
        const id = String(m.id ?? "");
        if (!id) continue;
        caps.upsert({
          id,
          source: `llm-server:${port}`,
          endpoint: `http://${host}:${port}${basePath}`,
          type: classifyModel(id),
          owner: "openvino_llm_server",
        });
      }
    } catch {
      /* 端口开着但非 OpenAI 兼容，跳过 */
    }
  }
}

/**
 * 能力表：进程内单例。探测结果写入这里；adapter / tool / 状态端点都从这里读。
 */
export function createCapabilityStore(config) {
  /** id -> 能力条目 */
  const byId = new Map();
  /** source -> 最近一次探测错误（用于状态展示） */
  const errors = new Map();
  let lastProbeAt = 0;
  let probing = false;

  function effectiveContext(id, fallback) {
    const override = config.contextWindows?.[id];
    if (typeof override === "number" && override > 0) return override;
    return DEFAULT_CONTEXT_WINDOWS[id] ?? fallback ?? 8192;
  }

  function upsert(entry) {
    const prev = byId.get(entry.id);
    byId.set(entry.id, {
      ...prev,
      ...entry,
      contextWindow: entry.contextWindow ?? effectiveContext(entry.id, prev?.contextWindow),
      maxTokens: entry.maxTokens ?? config.defaultMaxTokens,
      params: entry.params ?? DEFAULT_PARAMS[entry.id] ?? "?",
      healthy: true,
      lastProbeAt: Date.now(),
    });
  }

  function noteError(source, err) {
    errors.set(source, { at: Date.now(), message: err instanceof Error ? err.message : String(err) });
  }

  /** 全量探测一轮。 */
  async function probe(signal) {
    if (probing) return;
    probing = true;
    try {
      // 先清空上次的健康状态，再重探（服务可能已下线）
      for (const e of byId.values()) e.healthy = false;
      if (config.ovmsUrl) await probeOvms(config.ovmsUrl, caps, signal);
      if (config.baihuaShimUrl) await probeShim(config.baihuaShimUrl, caps, signal);
      if (config.visionUrl) await probeVision(config.visionUrl, caps, signal);
      if (config.poolUrl) await probePool(config.poolUrl, caps, signal, config.poolToken ?? "");
      if (config.llmServerPorts?.length) {
        await probeLlmServers(
          { host: config.llmServerHost ?? "127.0.0.1", ports: config.llmServerPorts, basePath: config.llmServerBasePath ?? "/v1" },
          caps,
          signal,
        );
      }
      lastProbeAt = Date.now();
    } finally {
      probing = false;
    }
  }

  /** 列出全部能力条目（按来源分组排序）。 */
  function list() {
    return [...byId.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.id < b.id ? -1 : 1));
  }

  /** 可对话的文本模型（小任务选型用）。 */
  function chatModels() {
    return list().filter((m) => m.healthy && (m.type === "text" || m.type === "vision"));
  }

  /**
   * 为小任务挑选"最合适"的文本模型：
   *  1. 优先 OVMS（白花自研、零依赖、可稳定并发）；
   *  2. 其次 shim 收录的本地提供方；
   *  3. 再其次算力池网关（可能路由到云端 deepseek，靠后排）；
   *  4. 最后遗留 llm-server。
   * 同来源内选参数量最小者（小任务求快、省显存）。
   */
  function pickChatModel() {
    const order = { ovms: 0, shim: 1, pool: 2 };
    const pool = chatModels()
      .filter((m) => m.type === "text")
      .sort((a, b) => {
        const oa = order[a.source] ?? 3;
        const ob = order[b.source] ?? 3;
        if (oa !== ob) return oa - ob;
        return (parseParams(a.params) ?? 1e9) - (parseParams(b.params) ?? 1e9);
      });
    return pool[0] ?? null;
  }

  function get(id) {
    return byId.get(id) ?? null;
  }

  function stats() {
    return {
      lastProbeAt,
      probing,
      sources: [...new Set(list().map((m) => m.source))],
      errors: Object.fromEntries(errors),
    };
  }

  const caps = { upsert, noteError, probe, list, chatModels, pickChatModel, get, stats };
  return caps;
}

function parseParams(p) {
  const m = /^(\d+(?:\.\d+)?)\s*([BMK])?$/i.exec(String(p ?? ""));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "B").toUpperCase();
  return unit === "B" ? n : unit === "K" ? n / 1024 : unit === "M" ? n / 1024 : n;
}
