/**
 * baihua-local-ai-dsh-plugin 客户端模块（DSH Web UI 侧）。
 *
 * 由 DSH 客户端模块系统按 lazy-CJS factory 格式加载（window.__ModuleLoader__.load）。
 * 作用：在 DSH 设置 → 插件页注册一张「百花本地 AI」配置卡片——绑定
 * baihua-local-ai settings namespace（settingsScope），提供可编辑参数表单
 * （OVMS/视觉/shim/算力池地址、poolToken/token 为 write-only、超时/探测/小任务护栏等），
 * 保存即写入 DSH 设置，宿主 adapter/工具读同一设置生效。
 */
window.__ModuleLoader__.load({
  id: "baihua-local-ai-dsh-plugin",
  factory(require) {
    const React = require("react");
    const { useState, useEffect, useCallback } = React;

    const NS = "baihua-local-ai";

    // group: "basic" 展开即见；"advanced" 折叠在「高级设置」里（零配置自举下一般无需改）。
    const FIELDS = [
      { key: "ovmsUrl", label: "OVMS 端点", hint: "OpenAI 兼容，含 /v1（默认 127.0.0.1:8000/v1）", type: "text", group: "basic" },
      { key: "visionUrl", label: "视觉服务端点", hint: "Qwen2.5-VL（默认 127.0.0.1:8801）", type: "text", group: "basic" },
      { key: "routeAuxiliaryCalls", label: "辅助调用路由", hint: "会话标题等小调用优先走本地，失败自动回退远程", type: "select", group: "basic",
        options: [
          { value: "", label: "会话标题（默认）" },
          { value: "off", label: "关闭" },
          { value: "session-title", label: "仅会话标题" },
          { value: "all", label: "全部（含压缩）" },
        ] },
      { key: "provider", label: "提供方路由键", hint: "注册到 ctx.llm 的 provider 键（默认 baihua-local）", type: "text", group: "advanced" },
      { key: "baihuaShimUrl", label: "AI shim 端点", hint: "按模型名路由本地/云端；空=自动发现", type: "text", group: "advanced" },
      { key: "poolUrl", label: "算力池网关", hint: "/mg/pool/v1；空=自动发现/不探测", type: "text", group: "advanced" },
      { key: "poolToken", label: "算力池网关 token", hint: "write-only；空=自动发现", type: "password", group: "advanced" },
      { key: "token", label: "状态端点鉴权 token", hint: "留空=回环免鉴权（write-only）", type: "password", group: "advanced" },
      { key: "llmServerHost", label: "遗留 llm-server 主机", hint: "默认 127.0.0.1", type: "text", group: "advanced" },
      { key: "llmServerBasePath", label: "llm-server 路径前缀", hint: "默认 /v1", type: "text", group: "advanced" },
      { key: "timeoutMs", label: "本地推理超时(ms)", hint: "默认 120000", type: "number", group: "advanced" },
      { key: "probeIntervalMs", label: "探测周期(ms)", hint: "默认 60000", type: "number", group: "advanced" },
      { key: "defaultMaxTokens", label: "默认输出上限", hint: "默认 1024", type: "number", group: "advanced" },
      { key: "smallTaskMaxTokens", label: "小任务输出上限", hint: "默认 512", type: "number", group: "advanced" },
      { key: "smallTaskMaxPromptChars", label: "小任务输入字符上限", hint: "默认 8000", type: "number", group: "advanced" },
      { key: "smallTaskTemperature", label: "小任务采样温度", hint: "默认 0.4", type: "number", group: "advanced" },
    ];

    function LocalAiConfigCard(props) {
      const scope = props.scope;
      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [saveMsg, setSaveMsg] = useState(null);
      const [open, setOpen] = useState(false);
      const [showAdvanced, setShowAdvanced] = useState(false); // 「高级设置」开合：默认收起

      useEffect(() => {
        if (!scope) return;
        const read = () => {
          const s = scope.getSnapshot();
          setSnap(s);
          const v = s.value || {};
          const d = {};
          for (const f of FIELDS) {
            if (f.type === "password") continue;
            d[f.key] = v[f.key] === undefined ? "" : String(v[f.key]);
          }
          setDraft(d);
        };
        read();
        const off = scope.subscribe(read);
        return () => off();
      }, [scope]);

      const setField = (key, raw) => setDraft((d) => ({ ...d, [key]: raw }));

      const save = useCallback(async () => {
        if (!scope || saving) return;
        setSaving(true);
        setSaveMsg(null);
        try {
          const v = (scope.getSnapshot().value) || {};
          const ops = [];
          for (const f of FIELDS) {
            const raw = draft[f.key];
            if (f.type === "password") {
              const text = String(raw || "").trim();
              if (text) ops.push(() => scope.set(f.key, text));
              continue;
            }
            if (f.type === "number") {
              const text = String(raw === undefined ? "" : raw).trim();
              const cur = v[f.key] === undefined ? "" : String(v[f.key]);
              if (text === cur) continue;
              const n = Number(text);
              if (text !== "" && Number.isFinite(n)) ops.push(() => scope.set(f.key, n));
              continue;
            }
            const text = String(raw === undefined ? "" : raw).trim();
            const cur = v[f.key] === undefined ? "" : String(v[f.key]);
            if (text === cur) continue;
            ops.push(text ? () => scope.set(f.key, text) : () => scope.unset(f.key));
          }
          for (const op of ops) await op();
          setSaveMsg({ ok: true, text: "已保存（重启后生效）" });
        } catch (e) {
          setSaveMsg({ ok: false, text: "保存失败：" + (e instanceof Error ? e.message : String(e)) });
        } finally {
          setSaving(false);
        }
      }, [scope, draft, saving]);

      const discard = useCallback(() => {
        setSaveMsg(null);
        const v = (scope && scope.getSnapshot().value) || {};
        const d = {};
        for (const f of FIELDS) {
          if (f.type === "password") continue;
          d[f.key] = v[f.key] === undefined ? "" : String(v[f.key]);
        }
        setDraft(d);
      }, [scope]);

      const base = {
        fontFamily: "inherit",
        fontSize: 13,
        lineHeight: 1.6,
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 14,
        boxShadow: "0 2px 8px rgba(0,0,0,.14)",
        padding: "14px 16px",
      };
      const inp = {
        font: "inherit", fontSize: 13, color: "var(--dsw-alias-label-primary)",
        background: "var(--dsw-alias-bg-layer-3)", border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8, padding: "6px 10px", lineHeight: 1.5,
      };
      const writable = snap && snap.writable !== false;
      const basicFields = FIELDS.filter((f) => f.group === "basic");
      const advancedFields = FIELDS.filter((f) => f.group !== "basic");

      // 单个配置字段节点（文本/密码/数字/下拉）
      const fieldNode = (f) => {
        const val = draft[f.key];
        const isNum = f.type === "number";
        const control =
          f.type === "select"
            ? React.createElement(
                "select",
                {
                  style: inp,
                  value: val === undefined ? "" : String(val),
                  disabled: !writable || saving,
                  onChange: (e) => setField(f.key, e.target.value),
                },
                f.options.map((o) =>
                  React.createElement("option", { key: o.value, value: o.value }, o.label)
                )
              )
            : React.createElement("input", {
                style: inp,
                type: f.type === "password" ? "password" : "text",
                inputMode: isNum ? "numeric" : undefined,
                value: val === undefined ? "" : String(val),
                placeholder: f.type === "password" ? "留空保持现状" : undefined,
                disabled: !writable || saving,
                onChange: (e) => setField(f.key, e.target.value),
              });
        return React.createElement(
          "div",
          { key: f.key, style: { display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" } },
          React.createElement("label", { style: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-primary)" } }, f.label),
          control,
          React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 } }, f.hint)
        );
      };

      const advancedToggle = React.createElement(
        "button",
        {
          type: "button",
          style: { appearance: "none", display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", font: "inherit", color: "var(--dsw-alias-label-primary)", background: "transparent", border: "none", padding: "8px 0", margin: 0, cursor: "pointer", fontSize: 13, fontWeight: 600 },
          "aria-expanded": showAdvanced,
          onClick: () => setShowAdvanced(!showAdvanced),
        },
        React.createElement("span", { style: { flex: 1, minWidth: 0 } }, "高级设置（" + advancedFields.length + " 项）"),
        React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", style: { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s", transform: showAdvanced ? "rotate(180deg)" : "none" } },
          React.createElement("path", { d: "M3 5.5L7 9.5L11 5.5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
        )
      );
      const saveButtons = React.createElement(
        "div",
        { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" } },
        React.createElement("button", { style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: saving ? "not-allowed" : "pointer" }, disabled: saving || !writable, onClick: discard }, "放弃修改"),
        React.createElement("button", { style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid transparent", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)", cursor: saving ? "not-allowed" : "pointer" }, disabled: saving || !writable, onClick: save }, saving ? "保存中…" : "保存"),
        saveMsg ? React.createElement("span", { style: { fontSize: 12, color: saveMsg.ok ? "#2e7d32" : "#c0392b" } }, saveMsg.text) : null
      );

      return React.createElement(
        "div",
        { style: base },
        React.createElement(
          "button",
          {
            type: "button",
            style: { appearance: "none", display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", font: "inherit", color: "inherit", background: "transparent", border: "none", padding: 0, margin: 0, cursor: "pointer" },
            "aria-expanded": open,
            onClick: () => setOpen(!open),
          },
          React.createElement(
            "span",
            { style: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 } },
            React.createElement("span", { style: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: "var(--dsw-alias-label-primary)" } }, "百花本地 AI"),
            React.createElement("span", { style: { fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-tertiary)" } }, "探测并路由百花本机 AI（OVMS/视觉/shim/算力池），可配置地址与 token。")
          ),
          React.createElement("svg", { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", style: { color: "var(--dsw-alias-label-tertiary)", flex: "none", transition: "transform .16s", transform: open ? "rotate(180deg)" : "none" } },
            React.createElement("path", { d: "M3 5.5L7 9.5L11 5.5", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
          )
        ),
        open
          ? React.createElement(
              "div",
              null,
              React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: "6px 0 4px" } }, "参数配置" + (snap && snap.status === "unavailable" ? "（当前不可编辑）" : "")),
              basicFields.map(fieldNode),
              advancedToggle,
              showAdvanced
                ? React.createElement("div", null, advancedFields.map(fieldNode))
                : null,
              saveButtons
            )
          : null
      );
    }

    return {
      name: "dsh-baihua-local-ai-client",
      inject: ["slots"],
      apply(ctx) {
        const settingsScope = ctx.get("settingsScope");
        let scope = null;
        if (settingsScope) {
          try {
            scope = settingsScope.bind({ namespace: NS });
            ctx.onDispose(() => {
              try { scope?.dispose?.(); } catch { /* noop */ }
            });
          } catch (e) {
            console.log("[dsh-baihua-local-ai] settingsScope.bind 失败：", e.message);
          }
        }
        ctx.slots.inject("settings.plugin.item", function* () {
          yield ctx.slots.register(
            {
              name: "settings.plugin.item",
              key: NS,
              locale: "settings.baihua-local-ai",
              inject: () => ({ scope }),
            },
            LocalAiConfigCard
          );
        });
      },
    };
  },
});
