/**
 * baihua-local-ai-dsh-plugin — 类型声明（与实现保持同源，主要供编辑器补全）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { LlmAdapter } from "@deepseek-ai/dsh-llm";

export interface Config {
  /** LLM 提供方路由键（注册到 ctx.llm）。 */
  provider?: string;
  /** OVMS OpenAI 兼容端点。 */
  ovmsUrl?: string;
  /** 百花 AI OpenAI 兼容 shim。 */
  baihuaShimUrl?: string;
  /** 百花视觉服务。 */
  visionUrl?: string;
  /** 遗留 openvino_llm_server 扫描（默认关闭）。 */
  llmServerHost?: string;
  llmServerPorts?: number[];
  llmServerBasePath?: string;
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  timeoutMs?: number;
  defaultMaxTokens?: number;
  smallTaskMaxTokens?: number;
  smallTaskMaxPromptChars?: number;
  smallTaskTemperature?: number;
  /** 按模型 id 覆盖上下文窗口（token）。 */
  contextWindows?: Record<string, number>;
  routeAuxiliaryCalls?: "off" | "session-title" | "all";
  token?: string;
}

export interface CapabilityEntry {
  id: string;
  source: "ovms" | "shim" | "vision" | string;
  endpoint: string;
  type: "text" | "vision" | "embedding";
  owner?: string;
  name?: string;
  params?: string;
  quant?: string;
  contextWindow: number;
  maxTokens: number;
  healthy: boolean;
  lastProbeAt: number;
}

export declare const name: string;
export declare const inject: string[];
export declare const Config: import("@deepseek-ai/schemastery").Schema<Config, Config>;
export declare class BaihuaLocalAdapter extends LlmAdapter {}
export declare function apply(ctx: Context, config: Config): () => void;
