/** Public React Router endpoint for the private ChatKit/workflow service. */
const REQUEST_HEADERS = ["accept", "authorization", "content-type", "origin", "x-line-signature", "x-idempotency-key", "x-salesos-member", "x-salesos-project", "x-salesos-model"];
const DROP_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const FETCH_ERROR_NAMES = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "AggregateError"]);
const FETCH_ERROR_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "ABORT_ERR",
]);

function fetchFailureDiagnostic(error: unknown, requestAborted: boolean, timeoutAborted: boolean) {
  let name = "UnknownError";
  let code = "UNKNOWN";
  // Do not log error.message/stack, request URLs, headers, or arbitrary fields.
  try {
    if (error && typeof error === "object") {
      const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
      const candidateName = value.name;
      if (typeof candidateName === "string" && FETCH_ERROR_NAMES.has(candidateName)) name = candidateName;
      const candidate = value.cause?.code ?? value.code;
      if (typeof candidate === "string" && FETCH_ERROR_CODES.has(candidate)) code = candidate;
    }
  } catch { /* A nonstandard exception must not break the safe error response. */ }
  return {
    reason: requestAborted ? "request_aborted" : timeoutAborted ? "proxy_timeout" : "upstream_fetch_failed",
    error_name: name, error_code: code,
    request_aborted: requestAborted, timeout_aborted: timeoutAborted,
  };
}

type ProxyOptions = { origin?: string; fetchImpl?: typeof fetch };

function jsonError(status: number, detail: string) {
  return Response.json({ detail }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function proxyApiRequest(request: Request, options: ProxyOptions = {}): Promise<Response> {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith("/api/")) return jsonError(404, "요청한 경로를 찾을 수 없습니다.");
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return jsonError(413, "파일은 10MB 이하로 첨부해 주세요.");
  }
  let upstream: URL;
  try {
    upstream = new URL(options.origin || process.env.SALESOS_API_ORIGIN || "http://127.0.0.1:8000");
    if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) {
      throw new Error("Invalid internal API origin");
    }
    upstream.pathname = incoming.pathname;
    upstream.search = incoming.search;
  } catch {
    return jsonError(503, "서버 연결 설정을 확인해 주세요.");
  }
  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 120_000);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    const init: RequestInit & { duplex?: "half" } = {
      method: request.method, headers, redirect: "manual", signal,
    };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body;
      init.duplex = "half";
    }
    const response = await (options.fetchImpl || fetch)(upstream, init);
    const responseHeaders = new Headers();
    response.headers.forEach((value, name) => {
      if (!DROP_RESPONSE_HEADERS.has(name)) responseHeaders.append(name, value);
    });
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("X-Content-Type-Options", "nosniff");
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      responseHeaders.set("X-Accel-Buffering", "no");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  } catch (error) {
    console.error("[SALES-OS] Internal API request failed " + JSON.stringify(fetchFailureDiagnostic(error, request.signal.aborted, timeout.signal.aborted)));
    return jsonError(timeout.signal.aborted ? 504 : 503, "업무 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  } finally {
    clearTimeout(timer);
  }
}
