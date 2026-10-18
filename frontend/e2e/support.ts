import type { Page, Route } from "@playwright/test";

export const testUser = { id: "user-1", email: "reader@example.test", name: "Reader", createdAt: "2026-10-18T10:00:00.000Z" };
const apiOrigin = "http://127.0.0.1:3200";

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, contentType: "application/json", headers, body: JSON.stringify(body) };
}

export function eventStream(events: Array<{ type: string; payload: unknown }>) {
  return events.map((event) => `data: ${JSON.stringify({ ...event, timestamp: Date.now() })}\n\n`).join("");
}

export async function mockSignedIn(page: Page, handler: (path: string, route: Route) => Promise<void> | void) {
  await page.addInitScript(() => localStorage.setItem("agentic-ai-access-token", "test-access-token"));
  await page.route(`${apiOrigin}/api/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    if (path === "/auth/me") return route.fulfill(jsonResponse({ user: testUser }));
    return handler(path, route);
  });
}

export async function notFound(route: Route) {
  await route.fulfill(jsonResponse({ error: "Not found", code: "not_found" }, 404));
}
