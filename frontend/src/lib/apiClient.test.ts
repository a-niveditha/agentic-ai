import { afterEach, describe, expect, it } from "bun:test";
import { apiRequest, ApiError, streamRequest } from "./apiClient";

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("apiRequest errors", () => {
  it("exposes backend message, code, request id, and validation issues", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: "Invalid request",
      code: "validation_error",
      requestId: "request_123",
      issues: [{ path: "email", message: "Invalid email" }],
    }), { status: 400, headers: { "Content-Type": "application/json" } });

    try {
      await apiRequest("/auth/login", { method: "POST", auth: false, body: "{}" });
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        message: "Invalid request",
        status: 400,
        code: "validation_error",
        requestId: "request_123",
        issues: [{ path: "email", message: "Invalid email" }],
      });
    }
  });

  it("falls back to a useful error for non-JSON responses", async () => {
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await expect(apiRequest("/ready")).rejects.toMatchObject({
      status: 503,
      code: "request_failed",
      message: "The request could not be completed.",
    });
  });

  it("adds the saved access token to authenticated requests", async () => {
    const values = new Map<string, string>([["agentic-ai-access-token", "saved-token"]]);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } },
    });
    let authorization = "";
    globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization") || "";
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    };
    await apiRequest("/auth/me");
    expect(authorization).toBe("Bearer saved-token");
  });

  it("clears an expired access token and broadcasts unauthorized", async () => {
    const values = new Map<string, string>([["agentic-ai-access-token", "expired-token"]]);
    const events: Event[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) },
        dispatchEvent: (event: Event) => { events.push(event); return true; },
      },
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Expired", code: "invalid_token" }), { status: 401 });
    await expect(apiRequest("/auth/me")).rejects.toMatchObject({ status: 401, code: "invalid_token" });
    expect(values.has("agentic-ai-access-token")).toBe(false);
    expect(events.map((event) => event.type)).toEqual(["agentic:unauthorized"]);
  });

  it("forwards cancellation to an in-flight stream request", async () => {
    let receivedSignal: AbortSignal | null = null;
    globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      receivedSignal = init?.signal as AbortSignal;
      receivedSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    const controller = new AbortController();
    const request = streamRequest("/chat/sessions/session/messages", { text: "hello" }, controller.signal).catch((error) => error);
    await Promise.resolve();
    controller.abort();
    const error = await request;
    expect(receivedSignal?.aborted).toBe(true);
    expect(error).toMatchObject({ name: "AbortError" });
  });
});
