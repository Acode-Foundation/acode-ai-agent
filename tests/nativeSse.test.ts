import { afterEach, expect, test, vi } from "vitest";
import { Stream } from "openai/core/streaming";
import { nativeFetch } from "../src/platform/nativeHttp";
import acodeSystem from "./fixtures/acode-http-stream.cjs";

afterEach(() => vi.unstubAllGlobals());

test("passes fragmented UTF-8 and SSE frames through the actual provider parser", async () => {
	const events = [
		{ type: "response.created", response: { tools: [{ description: "read_file ".repeat(250) }] } },
		{ type: "response.output_text.delta", delta: "héllo 🌍" },
		{ type: "response.completed" },
	];
	const bytes = new TextEncoder().encode(": keepalive\r\n\r\n" + events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
	for (const size of [1, 59, 1274, 1412, 32768]) {
		vi.stubGlobal("cordova", {
			exec(success: (event: unknown) => void, _failure: unknown, service: string, action: string) {
				expect(service).toBe("System");
				if (action !== "http-stream-start") return;
				queueMicrotask(() => {
					success({ type: "headers", status: 200, headers: [["content-type", "text/event-stream"]] });
					for (let offset = 0; offset < bytes.length; offset += size) {
						const chunk = bytes.slice(offset, offset + size);
						// Match StreamHttp.java: control bytes use base64; others use latin1.
						const b64 = chunk.some((byte) => byte < 0x20);
						const binary = String.fromCharCode(...chunk);
						success({ type: "data", chunk: b64 ? btoa(binary) : binary, b64 });
					}
					success({ type: "complete" });
				});
			},
		});
		vi.stubGlobal("system", acodeSystem);
		const checked = await nativeFetch("https://api.example.test/responses");
		const parsed = [];
		for await (const event of Stream.fromSSEResponse(checked, new AbortController())) parsed.push(event);
		expect(parsed).toEqual(events);
	}
});
