/**
 * WebMCP 註冊層。
 * - 瀏覽器有原生 navigator.modelContext / document.modelContext 就直接用。
 * - 沒有的話自建相容 polyfill（registerTool / provideContext / listTools / callTool），
 *   讓 agent 端偵測得到工具。
 * - SSR 期間完全不執行。
 */

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
  listTools?: () => unknown[];
  callTool?: (name: string, args?: unknown) => Promise<unknown>;
  __jtPolyfill?: boolean;
};

type WrappedTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
};

/** 這一頁目前提供的工具 */
const activeTools = new Map<string, WrappedTool>();

let nativePresent = false;

function isBrowser() {
  return typeof navigator !== "undefined" && typeof window !== "undefined";
}

function readNative(): ModelContextLike | null {
  if (!isBrowser()) return null;
  const fromNavigator = (navigator as unknown as { modelContext?: ModelContextLike }).modelContext;
  const fromDocument =
    typeof document === "undefined"
      ? undefined
      : (document as unknown as { modelContext?: ModelContextLike }).modelContext;
  const mc = fromNavigator ?? fromDocument;
  if (!mc || mc.__jtPolyfill) return null;
  return typeof mc.registerTool === "function" || typeof mc.provideContext === "function"
    ? mc
    : null;
}

function createPolyfill(): ModelContextLike {
  const polyfill: ModelContextLike = {
    __jtPolyfill: true,
    registerTool(tool, options) {
      const t = tool as WrappedTool;
      activeTools.set(t.name, t);
      options?.signal?.addEventListener("abort", () => activeTools.delete(t.name));
      return { unregister: () => activeTools.delete(t.name) };
    },
    unregisterTool(name) {
      activeTools.delete(name);
    },
    provideContext(context) {
      for (const tool of context.tools as WrappedTool[]) {
        if (tool?.name) activeTools.set(tool.name, tool);
      }
    },
    listTools() {
      return [...activeTools.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        ...(t.annotations ? { annotations: t.annotations } : {}),
      }));
    },
    async callTool(name, args) {
      const tool = activeTools.get(name);
      if (!tool) return { ok: false, error: `找不到工具 ${name}` };
      return tool.execute(args ?? {});
    },
  };
  return polyfill;
}

let context: ModelContextLike | null = null;

/** 確保 navigator.modelContext（與 document.modelContext）存在，回傳可用的 context */
export function ensureModelContext(): ModelContextLike | null {
  if (!isBrowser()) return null;
  if (context) return context;

  const native = readNative();
  if (native) {
    nativePresent = true;
    context = native;
  } else {
    nativePresent = false;
    context = createPolyfill();
    try {
      Object.defineProperty(navigator, "modelContext", {
        value: context,
        configurable: true,
        writable: true,
      });
      if (typeof document !== "undefined") {
        Object.defineProperty(document, "modelContext", {
          value: context,
          configurable: true,
          writable: true,
        });
      }
    } catch (error) {
      console.error("[揪團桌] 無法安裝 WebMCP polyfill", error);
    }
  }
  installDebugHook();
  return context;
}

export function isWebMcpAvailable() {
  return ensureModelContext() !== null;
}

export function hasNativeModelContext() {
  ensureModelContext();
  return nativePresent;
}

export function listRegisteredWebMcpTools() {
  return [...activeTools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

function syncProvideContext() {
  if (!context || typeof context.provideContext !== "function") return;
  try {
    context.provideContext({ tools: [...activeTools.values()] });
  } catch (error) {
    console.error("[揪團桌] WebMCP provideContext 失敗", error);
  }
}

/** 註冊一個工具，回傳解除註冊的函式；環境不支援時回傳 null */
export function registerWebMcpTool(tool: ToolDescriptor): (() => void) | null {
  const mc = ensureModelContext();
  if (!mc) return null;

  const controller = new AbortController();
  let registration: Registration | null = null;

  const wrapped: WrappedTool = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
    execute: async (args: unknown) => {
      try {
        return await tool.execute(args);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "執行失敗" };
      }
    },
  };

  activeTools.set(wrapped.name, wrapped);

  if (typeof mc.registerTool === "function") {
    try {
      const result = mc.registerTool(wrapped, { signal: controller.signal });
      if (result instanceof Promise) {
        void result
          .then((resolved) => {
            if (resolved && typeof resolved.unregister === "function") registration = resolved;
          })
          .catch((error: unknown) => {
            console.error(`[揪團桌] WebMCP 工具 ${tool.name} 註冊失敗`, error);
          });
      } else if (result && typeof result.unregister === "function") {
        registration = result;
      }
    } catch (error) {
      console.error(`[揪團桌] WebMCP 工具 ${tool.name} 註冊失敗`, error);
    }
  }

  // 部分實作只讀 provideContext 宣告的清單，兩條路都送。
  syncProvideContext();

  return () => {
    controller.abort();
    if (registration) {
      registration.unregister();
    } else if (typeof mc.unregisterTool === "function") {
      try {
        mc.unregisterTool(tool.name);
      } catch {
        /* 部分實作沒有這個方法 */
      }
    }
    activeTools.delete(tool.name);
    syncProvideContext();
  };
}

/** 一次註冊多個工具，回傳統一的解除註冊函式 */
export function registerWebMcpTools(tools: ToolDescriptor[]): () => void {
  const disposers = tools.map((t) => registerWebMcpTool(t));
  return () => disposers.forEach((d) => d?.());
}

function installDebugHook() {
  if (typeof window === "undefined") return;
  (window as unknown as { __jt?: unknown }).__jt = {
    available: () => ({
      registered: activeTools.size > 0,
      toolCount: activeTools.size,
      nativeModelContext: nativePresent,
      polyfill: !nativePresent,
    }),
    tools: () => listRegisteredWebMcpTools(),
    raw: () => context,
    call: (name: string, args?: unknown) => context?.callTool?.(name, args),
  };
}
