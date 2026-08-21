# baihua-local-ai-dsh-plugin

让 DeepSeek Harness (DSH) 自动**检测并使用百花（Baihua）提供的本机 AI**，把"小而有界"的任务分给本地模型完成，**降低线上 token 消耗**。与兄弟插件 baihua-dsh-plugin（百花 Web → DSH 的桥）方向相反：**本插件是 DSH → 百花本地 AI**。

## 它能做什么

| 能力 | 说明 |
|---|---|
| 探测 | 启动即探测、之后周期刷新（默认 60s）：OVMS（OpenVINO Model Server）、百花 AI OpenAI 兼容 shim、视觉服务、可选遗留 openvino_llm_server 端口段 |
| 能力表 | 每个模型记录：类型（文本/视觉/嵌入）、参数量、量化、上下文窗口、来源端点、健康状态；支持按模型 id 覆盖上下文估计 |
| LLM 提供方注册 | 把检测到的本地文本模型注册为 DSH 提供方路由（默认 baihua-local），模型选择器可见、subagent 可用 provider: "baihua-local" 覆盖直接使用 |
| 小任务工具 | local_ai_small_task：主 agent 把短摘要/分类/取词/起标题/简短改写等小任务交给本机 AI，带输入长度与输出 token 双重护栏 |
| 辅助调用路由 | 可选把会话标题等小辅助 LLM 调用自动改走本地模型（失败自动回退远程） |
| 状态端点 | GET /dsh-local-ai/status 查看探测结果、能力表、错误 |

## 安装

```bash
# 1. 把插件目录复制到 DSH profile 的 node_modules（与 baihua-dsh-plugin 同位置）
cp -r baihua-local-ai-dsh-plugin ~/.dsh/profiles/node_modules/

# 2. 在 $DSH_HOME/cordis.patch.yml 的 insert 列表追加：
```

```yaml
    # baihua-local-ai-dsh-plugin：让 DSH 自动使用百花本机 AI（OpenVINO 等），省线上 token
    - id: baihua-local-ai
      name: 'baihua-local-ai-dsh-plugin'
      config: { }
```

> 配置写好后重启 DSH web（或等待 HMR 热加载补丁生效）。确认加载：访问
> http://127.0.0.1:3080/dsh-local-ai/status，应返回探测到的模型列表。

## 配置项

| 键 | 默认值 | 说明 |
|---|---|---|
| provider | baihua-local | 注册到 ctx.llm 的提供方路由键 |
| ovmsUrl | http://127.0.0.1:8000/v1 | OVMS OpenAI 兼容端点 |
| baihuaShimUrl | http://127.0.0.1:8791/mg/ai/v1 | 百花 AI OpenAI 兼容 shim |
| visionUrl | http://127.0.0.1:8801 | 百花视觉服务 |
| llmServerPorts | [] | 遗留 openvino_llm_server 端口段（如 [8001,8002]） |
| probeIntervalMs | 60000 | 探测周期 |
| defaultMaxTokens | 1024 | 本地模型单请求输出上限 |
| smallTaskMaxTokens | 512 | 小任务工具输出上限 |
| smallTaskMaxPromptChars | 8000 | 小任务输入硬上限（本地上下文有限） |
| smallTaskTemperature | 0.4 | 小任务采样温度（低=稳/省） |
| contextWindows | {} | 按模型覆盖上下文：{"qwen2.5": 32768} |
| routeAuxiliaryCalls | session-title | off / session-title / all（含 compaction） |
| token | 空 | 状态端点 Bearer 鉴权（与兄弟插件约定一致） |

## 在 DSH 里怎么用

### 方式一：小任务工具（推荐，零配置）

主 agent 在需要处理短内容时调用 local_ai_small_task：

- 适合：把一段话总结成一句话、给文本分类/打标签、提取关键词、起标题、简短改写、简单 Q&A
- 不适合：长文档、多步推理、写代码、任何需要长上下文的任务（工具会在输入超限时明确拒绝，提示改用远程）

### 方式二：提供方路由（高级）

在模型选择器中可看到"百花本地 AI（OpenVINO）"提供方下的本地模型；subagent/工作流可用
provider: "baihua-local" + model: "qwen2.5" 覆盖，让子任务完全跑在本机。

### 方式三：辅助调用自动路由（默认开启 session-title）

会话标题生成等小调用自动走本地模型；本地失败时无缝回退远程，不会打断会话。

## 工作原理

```
+------------------+   探测    +--------------------------------+
|  DSH (Cordis)    | -------> | OVMS :8000   (qwen2.5 / vl / bge) |
|  baihua-local-ai | 能力表    | 视觉 :8801   (Qwen2.5-VL 识别)   |
|   - llm adapter  | <------- | shim :8791   (按模型名路由)      |
|   - 小任务工具    |  推理请求  | llm-server 端口段（可选）        |
+------------------+          +--------------------------------+
```

- 探测：GET {endpoint}/models（OVMS/shim）+ GET {vision}/health；全部静默容错。
- 选型：小任务优先 OVMS（白花自研、零依赖、可并发），同来源取参数量最小者；上下文窗口按模型族保守估计，可配置覆盖。
- 护栏：输入字符上限（smallTaskMaxPromptChars）+ 输出 token 上限（smallTaskMaxTokens/适配器 defaultMaxTokens）；任何本地失败都以明确错误返回，主 agent 自动回退远程。

## 依赖的百花能力（如缺则先加强百花）

本插件直接调用 **OVMS 的 OpenAI 兼容 API**（/v1/chat/completions，已实测流式+非流式+真实 usage），
因此对百花服务本身**零要求**即可工作。可选路径（baihuaShimUrl）依赖百花 AI 的
/mg/ai/v1 shim；当前已针对 shim 加强：

- 透传 max_tokens / temperature / top_p（此前固定默认值，请求参数被忽略）
- 非流式响应返回真实 usage（此前恒为 0）

> 百花侧改动在 services/Baihua.AI/Controllers/OpenAiCompatController.cs，重新编译并重启
> Baihua.AI 服务后生效。插件主体不受此影响。

## 验证

```bash
# 独立冒烟（不需要 DSH 上下文；需本机 OVMS/百花服务在跑）
node scripts/smoke.mjs

# 依赖 DSH 包的冒烟（需已复制进 profiles/node_modules）
node ~/.dsh/profiles/node_modules/baihua-local-ai-dsh-plugin/scripts/smoke-dsh.mjs
```

## 已知限制

- 本地模型上下文有限（qwen2.5 约 32K，且 OVMS 实际有效长度更保守）——所以只分小任务。
- 适配器当前只透传文本消息；图片/多模态与工具调用（function calling）暂不转发。
- 视觉服务（:8801）只做图片识别，不作为 LLM 提供方注册；能力表里如实标注。
- 云端模型（shim 里的 deepseek 等）不会进入本地能力表，避免误路由。
