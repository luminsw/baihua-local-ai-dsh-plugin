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

/** 该能力条目能否作为"对话+看图"模型（OVMS/shim 的 vision 模型；:8801 识别服务不算）。 */
function isChatVision(entry) {
  return entry.type === "vision" && (entry.source === "ovms" || entry.source === "shim");
}

/**
 * DSH 的 Message[] → OpenAI wire messages。
 *  - 工具结果折叠为文本；
 *  - 视觉模型（acceptImages=true 且有 attachments）时，user 消息里的 ImageBlock
 *    经 ctx.attachments.readImage 取字节转 base64 data URL，按 OpenAI 多模态
 *    content 数组格式发给 OVMS qwen2.5-vl；
 *  - 纯文本模型（或 attachments 缺失）时图片块被忽略，只透传文本。
 */
async function toWireMessages(messages, system, { acceptImages = false, attachments = null, signal } = {}) {
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
      const combinedText = [text, resultText].filter(Boolean).join("\n");

      const imageBlocks = blocks.filter((b) => b.type === "image");
      if (imageBlocks.length && acceptImages && attachments) {
        // 多模态 content 数组：文本 + image_url（base64 data URL）
        const parts = [];
        if (combinedText) parts.push({ type: "text", text: combinedText });
        for (const img of imageBlocks) {
          const stored = await attachments.readImage(img.attachment, signal);
          const b64 = Buffer.from(stored.data).toString("base64");
          parts.push({
            type: "image_url",
            image_url: { url: `data:${img.attachment.mediaType};base64,${b64}` },
          });
        }
        wire.push({ role: "user", content: parts });
      } else {
        wire.push({ role: "user", content: combinedText });
      }
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
   * @param {import('@deepseek-ai/dsh-attachment').AttachmentStore | null} [attachments]
   *   ctx.attachments 服务（可选）：存在时视觉模型可读取对话中的图片附件。
   */
  constructor(caps, config, attachments = null) {
    super();
    this.caps = caps;
    this.config = config;
    this.attachments = attachments;
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_NAME };
  }

  async listModels(provider) {
    return this.caps
      .chatModels()
      .filter((m) => m.type === "text" || isChatVision(m)) // 文本对话模型 + OVMS/shim 视觉对话模型
      .map((m) => ({
        provider,
        id: m.id,
        name: m.name || m.id,
        description: `来源:${m.source} · ${m.params}${m.quant ? " · " + m.quant : ""} · 上下文 ${m.contextWindow} tokens`,
        inputModalities: isChatVision(m) ? ["text", "image"] : ["text"],
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
      inputModalities: isChatVision(entry) ? ["text", "image"] : ["text"],
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

    const acceptImages = isChatVision(entry) && !!this.attachments;
    const messages = await toWireMessages(options.messages, options.system, {
      acceptImages,
      attachments: this.attachments,
      signal: options.signal,
    });
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
