import { expect, test } from "@playwright/test";
import { eventStream, jsonResponse, mockSignedIn, notFound, testUser } from "./support";

const now = "2026-10-18T10:00:00.000Z";

test("login displays backend errors, then stores the access token and opens chat", async ({ page }) => {
  let valid = false;
  await page.route("http://127.0.0.1:3200/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/login" && !valid) return route.fulfill(jsonResponse({ error: "Invalid email or password", code: "invalid_credentials" }, 401));
    if (path === "/auth/login") return route.fulfill(jsonResponse({ user: testUser, token: "browser-token" }));
    if (path === "/auth/me") return route.fulfill(jsonResponse({ user: testUser }));
    return notFound(route);
  });
  await page.goto("/login");
  await page.getByLabel("Email address").fill(testUser.email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("status")).toContainText("Invalid email or password");
  valid = true;
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText("Reader", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("agentic-ai-access-token"))).toBe("browser-token");
});

test("creates a conversation, streams tool activity and citations, renames and deletes it", async ({ page }) => {
  const session = { id: "11111111-1111-4111-8111-111111111111", title: "New Conversation", createdAt: now, updatedAt: now };
  let sessions: typeof session[] = [];
  let messages: Array<Record<string, unknown>> = [];
  await mockSignedIn(page, async (path, route) => {
    const method = route.request().method();
    if (path === "/chat/sessions" && method === "GET") return route.fulfill(jsonResponse({ sessions }));
    if (path === "/chat/sessions" && method === "POST") {
      sessions = [session];
      return route.fulfill(jsonResponse({ session }, 201));
    }
    if (path === `/chat/sessions/${session.id}/messages` && method === "GET") return route.fulfill(jsonResponse({ messages }));
    if (path === `/chat/sessions/${session.id}/messages` && method === "POST") {
      const text = String(route.request().postDataJSON().text);
      const citation = { title: "Travel guide", source: "https://example.test/guide", url: "https://example.test/guide", content: "Keep a copy of each receipt." };
      messages = [
        { id: "m1", sessionId: session.id, sender: "user", content: text, createdAt: now, metadata: null },
        { id: "m2", sessionId: session.id, sender: "agent", content: "Keep a copy of each receipt.", createdAt: now, metadata: { status: "completed", citations: [citation], toolCalls: [{ name: "knowledge_base_search", input: { query: "receipts" }, ok: true }] } },
      ];
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream([
        { type: "token", payload: { token: "Keep a copy of each receipt." } },
        { type: "tool_start", payload: { id: "t1", tool: "knowledge_base_search", input: { query: "receipts" } } },
        { type: "tool_end", payload: { id: "t1", tool: "knowledge_base_search", success: true, output: "receipt policy" } },
        { type: "citation", payload: { citations: [citation] } },
        { type: "done", payload: { fullResponse: "Keep a copy of each receipt.", citationsCount: 1, status: "completed", sessionId: session.id, messageId: "m2" } },
      ]) });
    }
    if (path === `/chat/sessions/${session.id}` && method === "PATCH") {
      session.title = String(route.request().postDataJSON().title);
      return route.fulfill(jsonResponse({ success: true }));
    }
    if (path === `/chat/sessions/${session.id}` && method === "DELETE") {
      sessions = [];
      messages = [];
      return route.fulfill(jsonResponse({ success: true }));
    }
    return notFound(route);
  });

  await page.goto("/chat");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${session.id}$`));
  await page.getByLabel("Message").fill("Where should I keep receipts?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Keep a copy of each receipt.").first()).toBeVisible();
  await expect(page.getByText("Sources", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Travel guide/ })).toHaveAttribute("href", "https://example.test/guide");
  await page.getByText("Used 1 tool").click();
  await expect(page.getByText("knowledge_base_search", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Rename New Conversation" }).click();
  await page.getByLabel("Conversation title").fill("Travel planning");
  await page.getByRole("button", { name: "Save title" }).click();
  await expect(page.getByRole("link", { name: /Travel planning/ })).toBeVisible();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Travel planning" }).click();
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByText("What’s on your mind?")).toBeVisible();
});

test("polls asynchronous indexing, retries a failed document, and deletes a source", async ({ page }) => {
  const failedId = "22222222-2222-4222-8222-222222222222";
  const docs: Array<Record<string, unknown>> = [{
    id: failedId, filename: "Old notes.txt", mimeType: "text/plain", sourceUrl: null,
    status: "failed", errorMessage: "Embedding service was unavailable", chunksCount: 0, createdAt: now, updatedAt: now,
  }];
  const polls = new Map<string, number>();
  let nextId = 0;
  await mockSignedIn(page, async (path, route) => {
    const method = route.request().method();
    if (path === "/documents" && method === "GET") {
      for (const doc of docs) {
        if (doc.status !== "processing") continue;
        const count = (polls.get(String(doc.id)) || 0) + 1;
        polls.set(String(doc.id), count);
        if (count > 1) { doc.status = "ready"; doc.chunksCount = 2; doc.errorMessage = null; }
      }
      return route.fulfill(jsonResponse({ documents: docs, supportedExtensions: ["txt", "md", "pdf"] }));
    }
    if (path === "/documents" && method === "POST") {
      const request = route.request();
      const contentType = request.headers()["content-type"] || "";
      const body = contentType.includes("application/json") ? request.postDataJSON() : {};
      const uploadedName = request.postDataBuffer()?.toString("utf8").match(/filename="([^"]+)"/)?.[1];
      const filename = body.title || (body.url ? new URL(String(body.url)).hostname : uploadedName || "Pasted text");
      const doc = { id: `doc-${++nextId}`, filename: String(filename), mimeType: "text/plain", sourceUrl: body.url || null, status: "processing", errorMessage: null, chunksCount: 0, createdAt: now, updatedAt: now };
      docs.unshift(doc);
      polls.set(doc.id, 0);
      return route.fulfill(jsonResponse({ document: doc }, 202, { location: `/api/v1/documents/${doc.id}` }));
    }
    if (path === `/documents/${failedId}/retry` && method === "POST") {
      const doc = docs.find((item) => item.id === failedId)!;
      doc.status = "processing";
      doc.updatedAt = now;
      polls.set(failedId, 0);
      return route.fulfill(jsonResponse({ document: doc }, 202, { location: `/api/v1/documents/${failedId}` }));
    }
    if (path.startsWith("/documents/") && method === "DELETE") {
      const id = path.split("/").at(-1);
      const index = docs.findIndex((doc) => doc.id === id);
      if (index >= 0) docs.splice(index, 1);
      return route.fulfill(jsonResponse({ success: true }));
    }
    return notFound(route);
  });

  await page.goto("/knowledge");
  await expect(page.getByText("Embedding service was unavailable")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Old notes.txt").locator(".." ).getByText("Ready")).toBeVisible({ timeout: 12_000 });

  await page.getByRole("tab", { name: "Paste text" }).click();
  await page.getByLabel("Title").fill("Project notes");
  await page.getByLabel("Text to index").fill("The project review happens each Friday.");
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.getByRole("status")).toContainText("Indexing is running in the background.");
  await expect(page.locator("article").filter({ hasText: "Project notes" }).getByText("Ready")).toBeVisible({ timeout: 12_000 });

  await page.getByRole("tab", { name: "Add a link" }).click();
  await page.getByLabel("Public webpage URL").fill("https://docs.example.test/guide");
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.locator("article").filter({ hasText: "docs.example.test" }).getByText("Ready")).toBeVisible({ timeout: 12_000 });

  await page.getByRole("tab", { name: "Upload file" }).click();
  await page.getByLabel("Choose a file").setInputFiles({ name: "field-guide.txt", mimeType: "text/plain", buffer: Buffer.from("A short field guide.") });
  await page.getByRole("button", { name: "Add document" }).click();
  await expect(page.locator("article").filter({ hasText: "field-guide.txt" }).getByText("Ready")).toBeVisible({ timeout: 12_000 });

  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Project notes" }).click();
  await expect(page.getByText("Project notes", { exact: true })).toHaveCount(0);
});

test("shows degraded readiness and a streamed RAG answer with citations", async ({ page }) => {
  await mockSignedIn(page, async (path, route) => {
    if (path === "/health") return route.fulfill(jsonResponse({ status: "ok", uptimeSeconds: 95, timestamp: now }));
    if (path === "/ready") return route.fulfill(jsonResponse({ status: "degraded", components: { database: "up", "embeddings:gemini": "down", "vectorstore:chroma": "up" }, timestamp: now }));
    if (path === "/rag/query" && route.request().method() === "POST") {
      expect(route.request().postDataJSON()).toEqual({ question: "How often is the review?", topK: 7 });
      return route.fulfill({ status: 200, contentType: "text/event-stream", body: eventStream([
        { type: "token", payload: { token: "The review happens each Friday." } },
        { type: "citation", payload: { citations: [{ title: "Project notes", source: "https://example.test/notes", url: "https://example.test/notes", content: "Review cadence: Friday." }] } },
        { type: "done", payload: { fullResponse: "The review happens each Friday.", citationsCount: 1, status: "degraded" } },
      ]) });
    }
    return notFound(route);
  });

  await page.goto("/status");
  await expect(page.getByText("degraded", { exact: true })).toBeVisible();
  await expect(page.getByText("embeddings gemini", { exact: true })).toBeVisible();
  await expect(page.getByText("down", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Ask your library" }).click();
  await page.getByLabel("What would you like to know?").fill("How often is the review?");
  await page.getByLabel("Sources to retrieve").selectOption("7");
  await page.getByRole("button", { name: "Ask" }).click();
  await expect(page.getByText("Showing retrieved passages because the model is unavailable")).toBeVisible();
  await expect(page.getByText("The review happens each Friday.").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Project notes/ })).toHaveAttribute("href", "https://example.test/notes");
});

test("mobile navigation opens and follows links with keyboard activation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSignedIn(page, async (path, route) => {
    if (path === "/chat/sessions") return route.fulfill(jsonResponse({ sessions: [] }));
    if (path === "/health") return route.fulfill(jsonResponse({ status: "ok", uptimeSeconds: 20, timestamp: now }));
    if (path === "/ready") return route.fulfill(jsonResponse({ status: "up", components: { database: "up" }, timestamp: now }));
    return notFound(route);
  });
  await page.goto("/chat");
  const menu = page.getByRole("button", { name: "Open menu" });
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Close menu" })).toBeVisible();
  await page.getByRole("link", { name: "System status" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/status$/);
  await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
});
