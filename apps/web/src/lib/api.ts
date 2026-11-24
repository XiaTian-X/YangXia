// 养夏网页端统一 API 客户端：自动携带 HttpOnly Cookie 与 X-YangXia-CSRF: 1，内置 SSE 流式解析与 AbortSignal 取消。

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiRequest<T = any>(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    formData?: FormData;
    signal?: AbortSignal;
    rawResponse?: boolean;
  } = {},
): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers = new Headers();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-YangXia-CSRF", "1");
  }
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(opts.body);
  }

  const res = await fetch(path, {
    method,
    headers,
    body,
    credentials: "include",
    signal: opts.signal,
  });

  if (opts.rawResponse) {
    if (!res.ok) {
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, data?.code ?? "HTTP_ERROR", data?.message ?? `请求失败 (${res.status})`, data?.details);
    }
    return res as unknown as T;
  }

  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("application/json") ? await res.json() : await res.text();
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof data === "object" && data?.code ? String(data.code) : "HTTP_ERROR",
      typeof data === "object" && data?.message ? String(data.message) : `请求失败 (${res.status})`,
      typeof data === "object" ? data?.details : undefined,
    );
  }
  return data as T;
}

export interface SseEvent {
  event: string;
  data: any;
}

/** 通过 fetch + ReadableStream 消费 POST SSE 流（原生支持 CSRF Header、Cookie 与 AbortController 停止）。 */
export async function streamSsePost(
  path: string,
  payload: unknown,
  onEvent: (ev: SseEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-YangXia-CSRF": "1",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(payload),
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    let err: any = null;
    try {
      err = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, err?.code ?? "SSE_ERROR", err?.message ?? `对话请求失败 (${res.status})`, err?.details);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buf = "";

  const flushBlock = (block: string) => {
    const lines = block.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    try {
      onEvent({ event, data: JSON.parse(dataLines.join("\n")) });
    } catch {
      onEvent({ event, data: dataLines.join("\n") });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 2);
      if (block) flushBlock(block);
    }
  }
  if (buf.trim()) flushBlock(buf.trim());
}

/** 从 ApiError 提取清晰可读的中文错误列表。 */
export function formatApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.details as { issues?: { level?: string; path?: string; message?: string }[] } | undefined;
    if (Array.isArray(d?.issues) && d.issues.length) {
      const lines = d.issues
        .filter((i) => i.level !== "warning")
        .slice(0, 6)
        .map((i) => `• ${i.path ? `${i.path}: ` : ""}${i.message ?? ""}`);
      if (lines.length) return `${err.message}\n${lines.join("\n")}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "操作失败，请稍后重试";
}
