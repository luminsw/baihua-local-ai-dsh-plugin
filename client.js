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

    const FIELDS = [
      { key: "provider", label: "提供方路由键", hint: "注册到 ctx.llm 的 provider 键", type: "text" },
      { key: "ovmsUrl", label: "OVMS 端点", hint: "OpenAI 兼容，含 /v1", type: "text" },
      { key: "baihuaShimUrl", label: "AI shim 端点", hint: "按模型名路由到本地/云端", type: "text" },
      { key: "visionUrl", label: "视觉服务端点", hint: "Qwen2.5-VL", type: "text" },
      { key: "poolUrl", label: "算力池网关", hint: "/mg/pool/v1；空=不探测", type: "text" },
      { key: "poolToken", label: "算力池网关 token", hint: "write-only", type: "password" },
      { key: "token", label: "状态端点鉴权 token", hint: "留空=回环免鉴权（write-only）", type: "password" },
      { key: "llmServerHost", label: "遗留 llm-server 主机", hint: "默认 127.0.0.1", type: "text" },
      { key: "llmServerBasePath", label: "llm-server 路径前缀", hint: "默认 /v1", type: "text" },
      { key: "timeoutMs", label: "本地推理超时(ms)", hint: "默认 120000", type: "number" },
      { key: "probeIntervalMs", label: "探测周期(ms)", hint: "默认 60000", type: "number" },
      { key: "defaultMaxTokens", label: "默认输出上限", hint: "默认 1024", type: "number" },
      { key: "smallTaskMaxTokens", label: "小任务输出上限", hint: "默认 512", type: "number" },
      { key: "smallTaskMaxPromptChars", label: "小任务输入字符上限", hint: "默认 8000", type: "number" },
      { key: "smallTaskTemperature", label: "小任务采样温度", hint: "默认 0.4", type: "number" },
      { key: "routeAuxiliaryCalls", label: "辅助调用路由", hint: "off | session-title | all", type: "text" },
    ];

    function LocalAiConfigCard(props) {
      const scope = props.scope;
      const [snap, setSnap] = useState(null);
      const [draft, setDraft] = useState({});
      const [saving, setSaving] = useState(false);
      const [saveMsg, setSaveMsg] = useState(null);
      const [open, setOpen] = useState(true);

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
          React.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)", flex: "none", fontSize: 12, transition: "transform .16s", transform: open ? "rotate(180deg)" : "none" } }, "▾")
        ),
        open
          ? React.createElement(
              "div",
              null,
              React.createElement("div", { style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)", margin: "6px 0 4px" } }, "参数配置" + (snap && snap.status === "unavailable" ? "（当前不可编辑）" : "")),
              FIELDS.map((f) => {
                const val = draft[f.key];
                const isNum = f.type === "number";
                return React.createElement(
                  "div",
                  { key: f.key, style: { display: "flex", flexDirection: "column", gap: 4, padding: "8px 0" } },
                  React.createElement("label", { style: { fontSize: 12, fontWeight: 500, color: "var(--dsw-alias-label-primary)" } }, f.label),
                  React.createElement("input", {
                    style: inp,
                    type: f.type === "password" ? "password" : "text",
                    inputMode: isNum ? "numeric" : undefined,
                    value: val === undefined ? "" : String(val),
                    placeholder: f.type === "password" ? "留空保持现状" : undefined,
                    disabled: !writable || saving,
                    onChange: (e) => setField(f.key, e.target.value),
                  }),
                  React.createElement("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 } }, f.hint)
                );
              }),
              React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center" } },
                React.createElement("button", { style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "var(--dsw-alias-label-secondary)", cursor: saving ? "not-allowed" : "pointer" }, disabled: saving || !writable, onClick: discard }, "放弃修改"),
                React.createElement("button", { style: { font: "inherit", fontSize: 13, padding: "5px 14px", borderRadius: 8, border: "1px solid transparent", background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)", cursor: saving ? "not-allowed" : "pointer" }, disabled: saving || !writable, onClick: save }, saving ? "保存中…" : "保存"),
                saveMsg ? React.createElement("span", { style: { fontSize: 12, color: saveMsg.ok ? "#2e7d32" : "#c0392b" } }, saveMsg.text) : null
              )
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
