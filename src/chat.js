/**
 * chat.js — 极简 OpenAI 兼容 chat client（无第三方依赖，基于全局 fetch）。
 *
 * 同时支持：
 *  - 非流式（一次 POST 拿完整文本 + usage）
 *  - SSE 流式（async generator 产出增量，供 LlmAdapter 消费）
 *
 * 设计约束：只做本地小模型需要的子集——文本消息、temperature/max_tokens/stop。
 * 消息输入统一为 [{ role: 'system'|'user'|'assistant', content: string }]。
 */

function toWireMessages(messages) {
  return messages.map((m) => {
    const role = m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user";
    return { role, content: m.content ?? "" };
  });
}

/** 非流式补全。返回 { text, finishReason, usage, model, elapsedMs }。 */
export async function chatCompletion({
  endpoint,
  model,
  messages,
  temperature,
  maxTokens,
  stop,
  signal,
  timeoutMs = 120000,
  token = "",
}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("local AI timeout")), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason ?? new Error("cancelled"));
  signal?.addEventListener("abort", onAbort);
  const started = Date.now();
  try {
    const body = {
      model,
      messages: toWireMessages(messages),
      stream: false,
    };
    if (typeof temperature === "number") body.temperature = temperature;
    if (typeof maxTokens === "number") body.max_tokens = maxTokens;
    if (Array.isArray(stop) && stop.length) body.stop = stop;

    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* noop */
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? " — " + detail : ""}`);
    }
    const json = await res.json();
    const choice = json?.choices?.[0];
    const text = choice?.message?.content ?? "";
    const usage = json?.usage ?? {};
    return {
      text: typeof text === "string" ? text : "",
      finishReason: choice?.finish_reason ?? "stop",
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
      },
      model: json?.model ?? model,
      elapsedMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * SSE 流式补全。产出：
 *  { kind: 'delta', text }      —— 增量文本
 *  { kind: 'done', finishReason, usage } —— 结束（含 usage）
 * 抛错表示传输层/协议失败。
 */
export async function* chatCompletionStream({
  endpoint,
  model,
  messages,
  temperature,
  maxTokens,
  stop,
  signal,
  timeoutMs = 180000,
  token = "",
}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("local AI stream timeout")), timeoutMs);
  const onAbort = () => ac.abort(signal?.reason ?? new Error("cancelled"));
  signal?.addEventListener("abort", onAbort);
  try {
    const body = { model, messages: toWireMessages(messages), stream: true };
    if (typeof temperature === "number") body.temperature = temperature;
    if (typeof maxTokens === "number") body.max_tokens = maxTokens;
    if (Array.isArray(stop) && stop.length) body.stop = stop;

    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* noop */
      }
      throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? " — " + detail : ""}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("response has no body");
    const decoder = new TextDecoder("utf-8");
    let buf = "";
    let usage = {};
    let finishReason = "stop";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            reader.releaseLock();
            return;
          }
          let json;
          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = json?.choices?.[0]?.delta;
          if (delta && typeof delta.content === "string" && delta.content) {
            yield { kind: "delta", text: delta.content };
          }
          const fr = json?.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (json?.usage) usage = json.usage;
        }
      }
    }

    yield {
      kind: "done",
      finishReason,
      usage: {
        inputTokens: Number(usage.prompt_tokens ?? 0),
        outputTokens: Number(usage.completion_tokens ?? 0),
        totalTokens: Number(usage.total_tokens ?? 0),
      },
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
