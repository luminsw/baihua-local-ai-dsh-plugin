/**
 * adapter.js — 把百花本地模型注册为 DSH 的 LLM 提供方路由（ctx.llm.registerAdapter）。
 *
 * 实现 @deepseek-ai/dsh-llm 的 LlmAdapter：
 *  - listModels / resolveModel 从能力表（probe.js）实时读取，探测刷新后无需重注册；
 *  - stream 把 OVMS/百花 shim 的 OpenAI 兼容 SSE 流映射为 DSH 的 StreamChunk 协议。
 *
 * 上下文护栏：本地模型上下文有限，本适配器不做任何长文本拼接；
 * 请求方（agent 循环）只发送它自己的历史。这里只负责把消息透传并限制输出长度。
 */
import { LlmAdapter, LlmError } from "@deepseek-ai/dsh-llm";
import { chatCompletionStream } from "./chat.js";

const PROVIDER_NAME = "百花本地 AI（OpenVINO）";

function messageRole(m) {
  return m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user";
}

/** DSH 的 Message[] → OpenAI wire messages。本地小模型只吃文本；工具结果折叠为文本。 */
function toWireMessages(messages, system) {
  const wire = [];
  if (system) wire.push({ role: "system", content: system });
  for (const m of messages) {
    const role = messageRole(m);
    const blocks = m.content ?? [];
    if (role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks
        .filter((b) => b.type === "tool-call")
        .map((b) => ({
          id: String(b.id),
          type: "function",
          function: { name: b.name, arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}) },
        }));
      const msg = { role: "assistant", content: text };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      wire.push(msg);
      continue;
    }
    if (role === "user") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const results = blocks.filter((b) => b.type === "tool-result").map((b) => b.content ?? []);
      const resultText = results
        .flat()
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      wire.push({ role: "user", content: [text, resultText].filter(Boolean).join("\n") });
      continue;
    }
    // tool 消息：DSH 的历史里以 tool-result 块挂在 user 消息上；防御性兜底
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    wire.push({ role, content: text });
  }
  return wire;
}

export class BaihuaLocalAdapter extends LlmAdapter {
  /**
   * @param {import('./probe.js').CapabilityStore} caps 能力表
   * @param {{ defaultMaxTokens: number, timeoutMs: number }} config
   */
  constructor(caps, config) {
    super();
    this.caps = caps;
    this.config = config;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    return this.caps
      .chatModels()
      .filter((m) => m.type === "text") // 文本对话模型才能做 LLM provider；视觉/嵌入另行展示
      .map((m) => ({
        provider,
        id: m.id,
        name: m.name || m.id,
        description: `来源:${m.source} · ${m.params}${m.quant ? " · " + m.quant : ""} · 上下文 ${m.contextWindow} tokens`,
        inputModalities: ["text"],
      }));
  }

  async resolveModel(provider, model, _signal) {
    const entry = this.caps.get(model);
    if (!entry) {
      throw new LlmError(
        `local model "${model}" is not in the detected capability table (probe once more or check /dsh-local-ai/status)`,
        "UNKNOWN_MODEL",
      );
    }
    return {
      provider,
      id: model,
      name: entry.name || model,
      description: `来源:${entry.source} · ${entry.params}`,
      inputModalities: ["text"],
      context: { contextWindow: entry.contextWindow ?? 8192 },
      defaultMaxTokens: this.config.defaultMaxTokens,
    };
  }

  async *stream(options) {
    const entry = this.caps.get(options.model);
    if (!entry) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: `local model "${options.model}" not detected`, code: "UNKNOWN_MODEL" },
        },
      };
      return;
    }
    if (!entry.healthy) {
      yield {
        type: "finish",
        reason: {
          kind: "error",
          failure: { message: `local model "${entry.id}" is currently unreachable`, code: "LOCAL_AI_UNAVAILABLE" },
        },
      };
      return;
    }

    const messages = toWireMessages(options.messages, options.system);
    let started = false;
    try {
      for await (const ev of chatCompletionStream({
        endpoint: entry.endpoint,
        model: entry.id,
        messages,
        temperature: options.temperature,
        maxTokens: options.maxTokens ?? this.config.defaultMaxTokens,
        stop: options.stop,
        signal: options.signal,
        timeoutMs: this.config.timeoutMs,
      })) {
        if (ev.kind === "delta") {
          if (!started) {
            yield { type: "block-start", index: 0, blockType: "text" };
            started = true;
          }
          yield { type: "text-delta", index: 0, text: ev.text };
        } else if (ev.kind === "done") {
          yield {
            type: "usage",
            usage: { inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens },
          };
          yield {
            type: "finish",
            reason: { kind: ev.finishReason === "length" ? "max-tokens" : "stop" },
          };
          return;
        }
      }
      // 流提前结束（无 done 事件）
      if (!started) yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "" } };
      yield { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } };
      yield { type: "finish", reason: { kind: "stop" } };
    } catch (err) {
      const aborted = options.signal?.aborted;
      if (aborted) {
        yield { type: "finish", reason: { kind: "aborted", failure: { message: "aborted", code: "ABORTED" } } };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        yield {
          type: "finish",
          reason: {
            kind: "error",
            failure: { message: `local AI call failed: ${msg}`, code: "LOCAL_AI_UNAVAILABLE" },
          },
        };
      }
    }
  }
}
