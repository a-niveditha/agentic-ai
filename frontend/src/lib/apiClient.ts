export const API_BASE =
  (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5000").replace(/\/$/, "") + "/api/v1";

export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly issues?: ApiIssue[],
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "agentic-ai-access-token";

export function getToken(): string | null {
  return typeof window === "undefined" ? null : window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(TOKEN_KEY);
}

function notifyUnauthorized(): void {
  clearToken();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("agentic:unauthorized"));
}

async function asApiError(response: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (response.status === 401) notifyUnauthorized();
  return new ApiError(
    String(body.error || "The request could not be completed."),
    response.status,
    String(body.code || "request_failed"),
    typeof body.requestId === "string" ? body.requestId : response.headers.get("x-request-id") || undefined,
    Array.isArray(body.issues) ? (body.issues as ApiIssue[]) : undefined,
    body,
    response.headers.get("retry-after"),
  );
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const { auth = true, ...requestOptions } = options;
  const headers = new Headers(requestOptions.headers);
  const token = auth ? getToken() : null;
  if (token) headers.set("Authorization", "Bearer " + token);
  if (requestOptions.body && !(requestOptions.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(API_BASE + path, { ...requestOptions, headers });
  if (!response.ok) throw await asApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function streamRequest(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const token = getToken();
  const response = await fetch(API_BASE + path, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await asApiError(response);
  return response;
}
