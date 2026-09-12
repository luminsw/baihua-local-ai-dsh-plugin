/**
 * tool.js — local_ai_small_task 工具。
 *
 * 目标：让主 agent 把"小、有界"的任务交给本机 AI 完成，节省线上 token。
 * 只应处理：短文本摘要、分类/打标签、关键词/实体抽取、起标题、简短改写、简单问答。
 *
 * 护栏（本工具是"护栏"的最终执行点）：
 *  - 输入长度上限 smallTaskMaxPromptChars（默认 8000 字符），超出直接拒绝并建议走远程；
 *  - 输出上限 smallTaskMaxTokens（默认 512），防止本地模型长文输出；
 *  - 无可用本地模型 / 调用失败时抛错，主 agent 自行回退远程完成。
 *
 * "思考型"模型（本机 qwen3-4b 就是）：实测同样一个小任务
 *   - 原样提问：200 tok 全是 <think> 推理、10.1s、**根本没输出答案**；
 *   - 追加 Qwen3 软开关 `/no_think`：25 tok、1.3s、直接给答案。
 * 所以默认追加该软开关（disableThinking），并额外把推理块从结果里剥掉兜底
 * （chat_template_kwargs.enable_thinking=false 在本机 OVMS 上无效，已实测）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Qwen3 系列的非思考软开关（写在用户消息里；别的模型忽略它也无害）。 */
const NO_THINK_HINT = "/no_think";

/**
 * 剥掉模型输出的推理块：
 *  - 成对标签 `<think>…</think>` / `<thinking>…</thinking>`（大小写不敏感）
 *  - 结尾未闭合的开标签（达到 token 上限时很常见）：从最后一个开标签截到结尾
 * 返回 { text, hadReasoning, truncatedReasoning }。
 */
export function stripReasoning(raw) {
  const input = String(raw ?? "");

  // 1) 成对标签（用反向引用同时覆盖 think / thinking）
  const pairRe = /<(think|thinking)>[\s\S]*?<\/\1>/gi;
  const hadPairs = pairRe.test(input);
  let text = input.replace(pairRe, "");

  // 2) 未闭合的开标签：从最后一个开标签截到结尾
  const openRe = /<(think|thinking)>/gi;
  let lastOpenIdx = -1;
  let m;
  while ((m = openRe.exec(text)) !== null) lastOpenIdx = m.index;
  const truncatedReasoning = lastOpenIdx >= 0;
  if (truncatedReasoning) text = text.slice(0, lastOpenIdx);

  return {
    text: text.trim(),
    hadReasoning: hadPairs || truncatedReasoning,
    truncatedReasoning,
  };
}

function buildSystemPrompt(format) {
  const fmt =
    format === "json"
      ? "只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块包裹。"
      : format === "bullets"
        ? "用简洁的要点（每点一行，以 - 开头）。"
        : "直接给出简洁的结果，不要寒暄、不要复述任务。";
  return [
    "你是一个运行在本机的轻量 AI 助手（OpenVINO 加速）。",
    "你的回答必须非常简短（通常不超过 3-5 句话；JSON 模式不超 10 个字段）。",
    "不要输出思考过程，直接给出结果。",
    fmt,
    "语言：跟随用户输入的语言回答。",
  ].join("\n");
}

export function smallTaskTool(caps, config) {
  // 支持传 config 对象或 getter（设置页表单改了即时生效）
  const cfg = () => (typeof config === "function" ? config() : config);
  return defineTool({
    name: "local_ai_small_task",
    description:
      "把一个小型、有界的文本任务交给本机 AI（百花 OpenVINO 本地模型）执行，以节省线上 token 消耗。" +
      "只适合：短文本摘要（≤1 段）、分类/打标签、关键词/实体提取、起标题、简短改写、简单 Q&A。" +
      "不适合：长文档处理、多步推理、代码编写、需要长上下文的任何任务——输入超过上限会直接失败，此时请自行用远程模型完成。",
    parameters: {
      task: { type: "string", required: true, description: "要做什么，例如：用一句话总结、归类为哪一类、提取 3 个关键词、起一个标题、用 JSON 返回标签。" },
      input: { type: "string", required: true, description: "要处理的内容。必须短（建议 ≤ 4000 字符，硬上限见配置 smallTaskMaxPromptChars）。" },
      format: { type: "string", enum: ["plain", "bullets", "json"], description: "输出格式。json 时模型只输出一个 JSON 对象。" },
      maxTokens: { type: "integer", description: "输出 token 上限（默认取配置 smallTaskMaxTokens）。" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          text: { type: "string", required: true },
          model: { type: "string", required: true },
          source: { type: "string", required: true },
          promptTokens: { type: "number" },
          completionTokens: { type: "number" },
          elapsedMs: { type: "number" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [
        { type: "text", text: value.text },
        {
          type: "text",
          text: `（本地 ${value.source}/${value.model} · in ${value.promptTokens} / out ${value.completionTokens} tok · ${value.elapsedMs}ms）`,
        },
      ],
    },
    async execute(args, exec) {
      const input = String(args.input ?? "");
      const task = String(args.task ?? "").trim();
      if (!task) throw new Error("task 不能为空");
      if (input.length > cfg().smallTaskMaxPromptChars) {
        throw new Error(
          `输入过长（${input.length} 字符 > 上限 ${cfg().smallTaskMaxPromptChars}）：本地模型上下文有限，请改用远程模型处理该任务。`,
        );
      }
      const model = caps.pickChatModel();
      if (!model) {
        throw new Error(
          "当前没有可用的百花本地文本模型（OVMS 未运行或未检测到）。请改用远程模型完成该任务，或检查 /dsh-local-ai/status。",
        );
      }
      const format = args.format ?? "plain";
      const maxTokens = Math.min(
        Math.max(1, Number(args.maxTokens) || cfg().smallTaskMaxTokens),
        cfg().smallTaskMaxTokens,
      );
      // "思考型"模型默认加 /no_think，否则预算常被推理吃光、拿不到答案（实测 200tok/10s 全是推理）
      const noThink = cfg().disableThinking !== false;
      const { chatCompletion } = await import("./chat.js");
      const result = await chatCompletion({
        endpoint: model.endpoint,
        model: model.id,
        messages: [
          { role: "system", content: buildSystemPrompt(format) },
          { role: "user", content: `任务：${task}\n\n内容：\n${input}${noThink ? `\n\n${NO_THINK_HINT}` : ""}` },
        ],
        temperature: cfg().smallTaskTemperature,
        maxTokens,
        signal: exec.signal,
        timeoutMs: cfg().timeoutMs,
        token: model.token,
      });

      const stripped = stripReasoning(result.text);
      let text = stripped.text;
      if (!text && stripped.hadReasoning) {
        // 模型只产出了推理（常见于达到 token 上限）——不要把它当答案返回
        throw new Error(
          `本地模型只输出了思考过程、没有给出答案（输出 ${result.usage.outputTokens} tok 可能被推理占满）。` +
            `请重试、提高 maxTokens，或改用远程模型。`,
        );
      }
      if (format === "json") {
        const parsed = tryParseJson(text);
        if (parsed) text = JSON.stringify(parsed);
      }

      return {
        text,
        model: result.model,
        source: model.source,
        promptTokens: result.usage.inputTokens,
        completionTokens: result.usage.outputTokens,
        elapsedMs: result.elapsedMs,
      };
    },
  });
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // 容忍 markdown 代码块包裹
    const m = /\{\{[\s\S]*?\}\}/.exec(text) || /\{[\s\S]*\}/.exec(text);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
