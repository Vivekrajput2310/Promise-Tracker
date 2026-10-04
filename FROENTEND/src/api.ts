export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

export interface Evidence {
  quote?: string;
  verified?: boolean;
  [key: string]: unknown;
}

export interface PromiseItem {
  id?: string;
  promise_id?: string;
  owner?: string;
  recipient?: string;
  promise?: string;
  deadline?: string | null;
  status?: string;
  confidence?: number;
  evidence?: Evidence;
  [key: string]: unknown;
}

export interface AnalyzeResponse {
  analysis_id?: string;
  promises?: PromiseItem[];
  [key: string]: unknown;
}

export type ApiErrorKind = "cors" | "network" | "client" | "server";

export interface ApiResult<T = unknown> {
  ok: boolean;
  method: string;
  endpoint: string;
  status: number | null;
  statusText: string;
  data: T | null;
  durationMs: number;
  requestId?: string;
  requestBody?: unknown;
  errorKind?: ApiErrorKind;
  errorMessage?: string;
}

function getRequestId(data: unknown, headers: Headers): string | undefined {
  const headerId =
    headers.get("x-request-id") || headers.get("request-id") || undefined;
  if (headerId) return headerId;

  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    if (typeof record.request_id === "string") return record.request_id;
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      if (typeof error.request_id === "string") return error.request_id;
    }
  }

  return undefined;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T = unknown>(
  endpoint: string,
  options: RequestInit = {},
  requestBody?: unknown,
): Promise<ApiResult<T>> {
  const method = options.method || "GET";
  const startedAt = performance.now();

  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
    const data = await parseResponse(response);

    return {
      ok: response.ok,
      method,
      endpoint,
      status: response.status,
      statusText: response.statusText,
      data: data as T,
      durationMs: Math.round(performance.now() - startedAt),
      requestId: getRequestId(data, response.headers),
      requestBody,
      errorKind: response.ok
        ? undefined
        : response.status >= 500
          ? "server"
          : "client",
    };
  } catch (error) {
    const isOffline = typeof navigator !== "undefined" && !navigator.onLine;
    const errorKind: ApiErrorKind = isOffline ? "network" : "cors";
    const explanation = isOffline
      ? "The browser is offline or the backend cannot be reached."
      : "The request did not receive an HTTP response. The backend may be offline, unreachable, or blocking this frontend origin with CORS.";

    return {
      ok: false,
      method,
      endpoint,
      status: null,
      statusText: "No HTTP response",
      data: null,
      durationMs: Math.round(performance.now() - startedAt),
      requestBody,
      errorKind,
      errorMessage: `${explanation} ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

function jsonHeaders(): HeadersInit {
  return { "Content-Type": "application/json" };
}

export function checkHealth(): Promise<ApiResult> {
  return request("/health");
}

export function analyzeConversation(
  document: string,
  referenceDate: string,
): Promise<ApiResult<AnalyzeResponse>> {
  const payload = {
    document,
    reference_date: referenceDate,
  };

  return request<AnalyzeResponse>("/api/analyze", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  }, payload);
}

export function getAnalysis(analysisId: string): Promise<ApiResult> {
  return request(`/api/analysis/${encodeURIComponent(analysisId)}`);
}

export function getPromises(
  analysisId: string,
  status?: string,
): Promise<ApiResult> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(
    `/api/analysis/${encodeURIComponent(analysisId)}/promises${query}`,
  );
}

export function listAnalyses(): Promise<ApiResult> {
  return request("/api/analyses");
}

export function updatePromise(
  promiseId: string,
  payload: unknown,
): Promise<ApiResult> {
  return request(`/api/promise/${encodeURIComponent(promiseId)}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify(payload),
  }, payload);
}

export function completePromise(promiseId: string): Promise<ApiResult> {
  return request(`/api/promise/${encodeURIComponent(promiseId)}/complete`, {
    method: "POST",
  });
}
