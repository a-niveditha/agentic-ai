import { describe, expect, it } from "bun:test";
import { readSse } from "./readSse";

describe("readSse", () => {
  it("parses frames split across byte chunks and ignores heartbeat comments", async () => {
    const bytes = new TextEncoder().encode(
      ": keep-alive\n\ndata: {\"type\":\"token\",\"payload\":{\"token\":\"hello\"}}\n\n" +
        "data: {\"type\":\"done\",\"payload\":{\"status\":\"completed\"}}\n\n",
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17, 61));
        controller.enqueue(bytes.slice(61));
        controller.close();
      },
    });
    const events: string[] = [];
    await readSse(new Response(stream), (event) => events.push(event.type));
    expect(events).toEqual(["token", "done"]);
  });

  it("parses CRLF-separated frames", async () => {
    const response = new Response('data: {"type":"start","payload":{}}\r\n\r\n');
    const types: string[] = [];
    await readSse(response, (event) => types.push(event.type));
    expect(types).toEqual(["start"]);
  });
});
