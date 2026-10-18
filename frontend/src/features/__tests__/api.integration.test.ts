import { afterEach, describe, expect, it } from "bun:test";
import { getCurrentUser, login, signup } from "../auth/authApi";
import { createSession, deleteSession, getMessages, getSessions, renameSession, streamMessage } from "../chat/chatApi";
import { addDocument, deleteDocument, getDocuments, retryDocument } from "../knowledge/knowledgeApi";
import { runRagQuery } from "../rag/ragApi";
import { getHealth, getReadiness } from "../status/statusApi";
import { ApiError } from "../../lib/apiClient";

const originalFetch = globalThis.fetch;
const stamp = "2026-10-18T10:00:00.000Z";
const user = { id: "user-1", email: "reader@example.test", name: "Reader", createdAt: stamp };
const session = { id: "session-1", title: "Research", createdAt: stamp, updatedAt: stamp };
const document = {
  id: "doc-1", filename: "Notes", mimeType: "text/plain", sourceUrl: null,
  status: "processing", errorMessage: null, chunksCount: 0, createdAt: stamp, updatedAt: stamp,
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call.url, init);
  };
  return calls;
}

afterEach(() => { globalThis.fetch = originalFetch; });

describe("feature API integration", () => {
  it("matches auth request and response contracts", async () => {
    const calls = installFetch((url) => url.endsWith("/auth/me")
      ? json({ user })
      : json({ user, token: "access-token" }, url.endsWith("/auth/signup") ? 201 : 200));

    expect((await signup(user.email, "good-password", user.name)).token).toBe("access-token");
    expect((await login(user.email, "good-password")).user).toEqual(user);
    expect(await getCurrentUser()).toEqual(user);
    expect(calls.map(({ url, init }) => [new URL(url).pathname, init?.method || "GET"])).toEqual([
      ["/api/v1/auth/signup", "POST"], ["/api/v1/auth/login", "POST"], ["/api/v1/auth/me", "GET"],
    ]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ email: user.email, password: "good-password", name: user.name });
    expect(new Headers(calls[0]?.init?.headers).has("Authorization")).toBe(false);
  });

  it("covers session CRUD, history, and chat SSE events", async () => {
    const messages = [{ id: "m-1", sessionId: session.id, sender: "agent", content: "Saved reply", createdAt: stamp, metadata: null }];
    const events = [
      { type: "token", payload: { token: "hello" } },
      { type: "citation", payload: { citations: [{ title: "Guide", source: "guide.pdf", content: "A cited passage" }] } },
      { type: "done", payload: { fullResponse: "hello", status: "completed", sessionId: session.id, messageId: "m-2" } },
    ];
    const stream = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const calls = installFetch((url, init) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/messages") && init?.method === "POST") return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      if (path.endsWith("/messages")) return json({ messages });
      if (path.endsWith("/sessions") && init?.method === "POST") return json({ session }, 201);
      if (path.endsWith("/sessions") && init?.method !== "POST") return json({ sessions: [session] });
      return json({ success: true });
    });

    expect(await getSessions()).toEqual([session]);
    expect(await createSession()).toEqual(session);
    expect(await getMessages(session.id)).toEqual(messages);
    expect(await renameSession(session.id, "Renamed")).toEqual({ success: true });
    expect(await deleteSession(session.id)).toEqual({ success: true });
    const received: string[] = [];
    await streamMessage(session.id, "hello", new AbortController().signal, (event) => received.push(event.type));

    expect(received).toEqual(["token", "citation", "done"]);
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual([
      "/api/v1/chat/sessions", "/api/v1/chat/sessions", `/api/v1/chat/sessions/${session.id}/messages`,
      `/api/v1/chat/sessions/${session.id}`, `/api/v1/chat/sessions/${session.id}`,
      `/api/v1/chat/sessions/${session.id}/messages`,
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({});
    expect(JSON.parse(String(calls[5]?.init?.body))).toEqual({ text: "hello" });
    expect(new Headers(calls[5]?.init?.headers).get("accept")).toBe("text/event-stream");
  });

  it("handles asynchronous document ingestion, retry, delete, duplicates, and queue limits", async () => {
    let nextError: Response | null = null;
    const calls = installFetch((url, init) => {
      if (nextError) { const response = nextError; nextError = null; return response; }
      const path = new URL(url).pathname;
      if (path.endsWith("/retry")) return json({ document: { ...document, status: "processing" } }, 202, { location: `/api/v1/documents/${document.id}` });
      if (path.endsWith("/documents") && init?.method === "POST") return json({ document }, 202, { location: `/api/v1/documents/${document.id}` });
      if (path.endsWith("/documents") && init?.method !== "POST") return json({ documents: [document], supportedExtensions: ["txt", "md", "pdf"] });
      return json({ success: true });
    });

    expect((await addDocument({ title: "Notes", text: "Useful project notes" })).document.status).toBe("processing");
    const multipart = new FormData();
    multipart.append("file", new Blob(["notes"], { type: "text/plain" }), "notes.txt");
    await addDocument(multipart);
    expect((await getDocuments()).documents[0]?.status).toBe("processing");
    expect((await retryDocument(document.id)).document.status).toBe("processing");
    expect(await deleteDocument(document.id)).toEqual({ success: true });

    nextError = json({ error: "Already in your library", code: "duplicate_document", duplicateOf: document.id }, 409);
    await expect(addDocument({ url: "https://example.com/notes" })).rejects.toMatchObject({ code: "duplicate_document", status: 409 });
    nextError = json({ error: "Indexing queue is full", code: "queue_full", requestId: "req-42" }, 503, { "retry-after": "3" });
    await expect(addDocument({ url: "https://example.com/other" })).rejects.toMatchObject({ code: "queue_full", status: 503, retryAfter: "3" });

    expect(calls.slice(0, 5).map(({ url, init }) => [new URL(url).pathname, init?.method || "GET"])).toEqual([
      ["/api/v1/documents", "POST"], ["/api/v1/documents", "POST"], ["/api/v1/documents", "GET"],
      [`/api/v1/documents/${document.id}/retry`, "POST"], [`/api/v1/documents/${document.id}`, "DELETE"],
    ]);
    expect(new Headers(calls[1]?.init?.headers).has("Content-Type")).toBe(false);
    expect(calls[1]?.init?.body).toBe(multipart);
  });

  it("streams standalone RAG and sends the selected topK", async () => {
    const frames = [
      { type: "token", payload: { token: "Grounded " } },
      { type: "citation", payload: { citations: [{ title: "Handbook", source: "handbook.pdf", content: "Source passage" }] } },
      { type: "done", payload: { fullResponse: "Grounded answer", citationsCount: 1, status: "degraded" } },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const calls = installFetch((_url, _init) => new Response(frames, { headers: { "content-type": "text/event-stream" } }));
    const received: string[] = [];
    await runRagQuery("What does the handbook say?", 7, new AbortController().signal, (event) => received.push(event.type));
    expect(received).toEqual(["token", "citation", "done"]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ question: "What does the handbook say?", topK: 7 });
    expect(new Headers(calls[0]?.init?.headers).get("accept")).toBe("text/event-stream");
  });

  it("surfaces liveness and degraded readiness, including database outage responses", async () => {
    const calls = installFetch((url) => {
      if (url.endsWith("/health")) return json({ status: "ok", uptimeSeconds: 90, timestamp: stamp });
      return json({ status: "down", components: { database: "down", "vectorstore:chroma": "up" }, timestamp: stamp }, 503);
    });
    expect(await getHealth()).toMatchObject({ status: "ok", uptimeSeconds: 90 });
    expect(await getReadiness()).toMatchObject({ status: "down", components: { database: "down" } });
    expect(calls.map(({ url }) => new URL(url).pathname)).toEqual(["/api/v1/health", "/api/v1/ready"]);

    installFetch(() => json({ error: "Temporary failure", code: "service_unavailable" }, 503));
    await expect(getReadiness()).rejects.toBeInstanceOf(ApiError);
  });
});
