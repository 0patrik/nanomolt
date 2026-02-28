type HeadersInit = Record<string, string>;

export type OpenCodePart = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type OpenCodeEvent = {
  event: string;
  data: unknown;
};

const baseUrl = process.env.OPENCODE_URL;
if (!baseUrl) {
  console.error("OPENCODE_URL environment variable is required");
  process.exit(1);
}

const username = process.env.OPENCODE_USERNAME || "opencode";
const password = process.env.OPENCODE_PASSWORD;

function buildHeaders(): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };

  if (password) {
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }

  return headers;
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${normalizedBaseUrl}${path}`, {
    ...init,
    headers: {
      ...buildHeaders(),
      ...(init?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenCode request failed: ${res.status} ${res.statusText} ${text}`);
  }

  const text = await res.text().catch(() => "");
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function tryJsonRequest<T>(path: string, init?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  data?: T;
  text?: string;
  contentType?: string | null;
  errorText?: string;
}> {
  const res = await fetch(`${normalizedBaseUrl}${path}`, {
    ...init,
    headers: {
      ...buildHeaders(),
      ...(init?.headers || {}),
    },
  });

  const contentType = res.headers.get("content-type");
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    return { ok: false, status: res.status, errorText: text, contentType, text };
  }
  if (!text) return { ok: true, status: res.status, contentType };
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) as T, contentType };
  } catch {
    return { ok: true, status: res.status, contentType, text } as {
      ok: true;
      status: number;
      data?: T;
      text?: string;
      contentType?: string | null;
    };
  }
}

let cachedQuestionAnswerPaths: string[] | null = null;

async function resolveQuestionAnswerPaths(): Promise<string[]> {
  if (cachedQuestionAnswerPaths) return cachedQuestionAnswerPaths;

  const docCandidates = [
    "/openapi.json",
    "/doc.json",
    "/doc?format=openapi",
    "/doc?format=json",
    "/doc?openapi=1",
    "/doc?format=openapi-json",
    "/doc?format=swagger",
    "/doc",
  ];

  const extractPaths = (spec: any): string[] => {
    const paths = spec?.paths;
    if (!paths || typeof paths !== "object") return [];
    return Object.entries(paths)
      .filter(([path, methods]) => {
        if (!path.toLowerCase().includes("question")) return false;
        if (!methods || typeof methods !== "object") return false;
        const hasPost = Object.keys(methods).some(
          (method) => method.toLowerCase() === "post"
        );
        if (!hasPost) return false;
        return /answer|response|reply/.test(path.toLowerCase());
      })
      .map(([path]) => path);
  };

  const trySpec = async (path: string): Promise<string[]> => {
    const result = await tryJsonRequest<any>(path, { method: "GET" });
    if (!result.ok) return [];
    if (result.data) return extractPaths(result.data);
    return [];
  };

  for (const docPath of docCandidates) {
    const discovered = await trySpec(docPath);
    if (discovered.length) {
      cachedQuestionAnswerPaths = discovered;
      return discovered;
    }
  }

  const htmlDoc = await tryJsonRequest<string>("/doc", { method: "GET" });
  if (htmlDoc.ok && htmlDoc.text) {
    const urls = new Set<string>();
    const urlRegex = /url:\s*["']([^"']+)["']/gi;
    const urlsRegex = /urls:\s*\[\s*([^\]]+)\]/gi;
    let match: RegExpExecArray | null;
    while ((match = urlRegex.exec(htmlDoc.text)) !== null) {
      urls.add(match[1]);
    }
    while ((match = urlsRegex.exec(htmlDoc.text)) !== null) {
      const inner = match[1];
      const innerUrlRegex = /url:\s*["']([^"']+)["']/gi;
      let innerMatch: RegExpExecArray | null;
      while ((innerMatch = innerUrlRegex.exec(inner)) !== null) {
        urls.add(innerMatch[1]);
      }
    }

    for (const url of urls) {
      const path = url.startsWith("http") ? url : url.startsWith("/") ? url : `/${url}`;
      const discovered = await trySpec(path);
      if (discovered.length) {
        cachedQuestionAnswerPaths = discovered;
        return discovered;
      }
    }
  }

  cachedQuestionAnswerPaths = [];
  return [];
}

export async function createSession(title?: string): Promise<{ id: string }> {
  return jsonRequest("/session", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export async function sendPromptAsync(
  sessionId: string,
  parts: OpenCodePart[],
  options?: {
    model?: string;
    agent?: string;
    system?: string;
    tools?: unknown;
    noReply?: boolean;
    messageID?: string;
  }
): Promise<void> {
  await jsonRequest<void>(`/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({
      ...options,
      parts,
    }),
  });
}

export async function abortSession(sessionId: string): Promise<boolean> {
  return jsonRequest<boolean>(`/session/${sessionId}/abort`, {
    method: "POST",
  });
}

export async function answerQuestion(
  sessionId: string,
  questionId: string,
  answer: string | string[],
  optionIds?: number[],
  meta?: { callID?: string; messageID?: string }
): Promise<void> {
  const answerList = Array.isArray(answer) ? answer : [answer];
  const payload = {
    answers: answerList.map((value) => [value]),
    answer: answerList,
    callID: meta?.callID,
    callId: meta?.callID,
    messageID: meta?.messageID,
    messageId: meta?.messageID,
    sessionID: sessionId,
    sessionId,
  };

  const path = `/question/${questionId}/reply`;
  const result = await tryJsonRequest<void>(path, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "Content-Type": "application/json",
    },
  });

  if (!result.ok) {
    throw new Error(
      `OpenCode question answer failed: ${path} -> ${result.status} ${result.errorText ?? ""}`.trim()
    );
  }

  if (process.env.OPENCODE_DEBUG_EVENTS) {
    console.log(`OpenCode question answered via ${path} (${result.status})`);
  }
}

function parseSseBlock(block: string): OpenCodeEvent | null {
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
      continue;
    }
  }

  if (!dataLines.length) return null;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return null;

  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    return { event, data: raw };
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectEventStream(path: string): Promise<Response> {
  return fetch(`${normalizedBaseUrl}${path}`, {
    headers: {
      Accept: "text/event-stream",
      ...buildHeaders(),
    },
  });
}

export async function startEventStream(
  onEvent: (evt: OpenCodeEvent) => void
): Promise<void> {
  let backoffMs = 500;

  while (true) {
    try {
      let res = await connectEventStream("/event");
      if (res.status === 404) {
        res = await connectEventStream("/global/event");
      }

      if (!res.ok || !res.body) {
        throw new Error(`SSE connection failed: ${res.status} ${res.statusText}`);
      }

      console.log(`OpenCode SSE connected: ${res.url}`);
      backoffMs = 500;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evt = parseSseBlock(block);
          if (evt) onEvent(evt);
          idx = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      console.error("OpenCode SSE error:", err);
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 8000);
    }
  }
}
