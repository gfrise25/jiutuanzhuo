/** 極簡的 navigator.modelContext (WebMCP) 包裝 */

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
};

type Registration = { unregister: () => void };

type ModelContextLike = {
  registerTool?: (tool: unknown) => Registration | void;
  unregisterTool?: (name: string) => void;
};

function getModelContext(): ModelContextLike | null {
  if (typeof navigator === "undefined") return null;
  const mc = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  return mc && typeof mc.registerTool === "function" ? mc : null;
}

export function isWebMcpAvailable() {
  return getModelContext() !== null;
}

/** 註冊一個工具，回傳解除註冊的函式；環境不支援時回傳 null */
export function registerWebMcpTool(tool: ToolDescriptor): (() => void) | null {
  const mc = getModelContext();
  if (!mc) return null;

  const wrapped = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    execute: async (args: unknown) => {
      let payload: unknown;
      try {
        payload = await tool.execute(args);
      } catch (e) {
        payload = { ok: false, error: e instanceof Error ? e.message : "執行失敗" };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  };

  const reg = mc.registerTool!(wrapped);
  return () => {
    if (reg && typeof (reg as Registration).unregister === "function") {
      (reg as Registration).unregister();
    } else if (typeof mc.unregisterTool === "function") {
      mc.unregisterTool(tool.name);
    }
  };
}
