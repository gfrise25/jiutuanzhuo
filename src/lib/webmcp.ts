/** 極簡的 document.modelContext (WebMCP) 包裝，並相容早期 navigator API */

export type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
};

type Registration = { unregister: () => void };

type ModelContextLike = {
  registerTool?: (
    tool: unknown,
    options?: { signal?: AbortSignal },
  ) => Registration | Promise<Registration | void> | void;
  unregisterTool?: (name: string) => void;
  provideContext?: (context: { tools: unknown[] }) => void;
};

function getModelContext(): ModelContextLike | null {
  if (typeof document === "undefined") return null;
  const documentContext = (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  const legacyContext =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  const mc = documentContext ?? legacyContext;
  if (!mc) return null;
  return typeof mc.registerTool === "function" || typeof mc.provideContext === "function" ? mc : null;
}

export function isWebMcpAvailable() {
  return getModelContext() !== null;
}

/** 目前這一頁提供的工具（用於 provideContext 全量宣告） */
const activeTools = new Map<string, Record<string, unknown>>();

function syncProvideContext() {
  const mc = getModelContext();
  if (!mc || typeof mc.provideContext !== "function") return;
  try {
    mc.provideContext({ tools: [...activeTools.values()] });
  } catch (error) {
    console.error("[揪團桌] WebMCP provideContext 失敗", error);
  }
}

/** 方便在 DevTools 檢查目前註冊了哪些工具 */
export function listRegisteredWebMcpTools() {
  return [...activeTools.keys()];
}

/** 註冊一個工具，回傳解除註冊的函式；環境不支援時回傳 null */
export function registerWebMcpTool(tool: ToolDescriptor): (() => void) | null {
  const mc = getModelContext();
  if (!mc) return null;

  const controller = new AbortController();
  let legacyRegistration: Registration | null = null;

  const wrapped = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    execute: async (args: unknown) => {
      try {
        // WebMCP 的 execute 直接回傳可結構化複製的 JSON；不要再包一層
        // MCP transport 的 content/structuredContent envelope。
        return await tool.execute(args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "執行失敗" };
      }
    },
  };

  // Chrome 現行 API 以 AbortSignal 解除註冊；同時保留舊版回傳
  // registration.unregister() 與 unregisterTool(name) 的相容處理。
  if (typeof mc.registerTool === "function") {
    try {
      const registration = mc.registerTool(wrapped, { signal: controller.signal });
      if (registration instanceof Promise) {
        void registration
          .then((resolved) => {
            if (resolved && typeof resolved.unregister === "function") {
              legacyRegistration = resolved;
            }
          })
          .catch((error: unknown) => {
            console.error(`[揪團桌] WebMCP 工具 ${tool.name} 註冊失敗`, error);
          });
      } else if (registration && typeof registration.unregister === "function") {
        legacyRegistration = registration;
      }
    } catch (error) {
      console.error(`[揪團桌] WebMCP 工具 ${tool.name} 註冊失敗`, error);
    }
  }

  // 部分 Chrome 版本只讀 provideContext 宣告的工具清單，兩種都送。
  activeTools.set(tool.name, wrapped);
  syncProvideContext();

  return () => {
    controller.abort();
    if (legacyRegistration) {
      legacyRegistration.unregister();
    } else if (typeof mc.unregisterTool === "function") {
      try {
        mc.unregisterTool(tool.name);
      } catch {
        /* 忽略：部分版本沒有這個方法 */
      }
    }
    activeTools.delete(tool.name);
    syncProvideContext();
  };
}
