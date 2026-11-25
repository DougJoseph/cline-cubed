import { describe, expect, it, vi } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { bridgeImage } from "./imageBridge"

/**
 * Cline Cubed — the image bridge must never fail silently.
 *
 * The worst failure this bridge has is a 200 that carries no description: the request is accepted,
 * the key is fine, the network is fine, and the fork's flagship feature returns nothing. What tells
 * the possible causes apart — a gateway error envelope, a model that spent its whole budget on
 * reasoning, a plain empty message — is the response body, so these tests pin that the body is read
 * on the SUCCESS path too, and that the failure names what it found.
 */

const IMAGE_BASE64 = "aGVsbG8="

/** A JSON `Response` for the given body and status. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

/** Call the bridge once, with the Image Mode wiring filled in. */
function callBridge(overrides: Partial<Parameters<typeof bridgeImage>[0]> = {}) {
	return bridgeImage({
		base64: IMAGE_BASE64,
		mediaType: "image/png",
		provider: "deepseek",
		modelId: "deepseek-vl2",
		apiKey: "test-key",
		...overrides,
	})
}

describe("bridgeImage — a 200 with no description says why", () => {
	it("returns the description when the response has one", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "A grid of tiles." } }] }))
		const content = await mockFetchForTesting(fetchMock, () => callBridge())
		expect(content).toBe("A grid of tiles.")
	})

	it("names a 200 error envelope instead of a bare 'no content'", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ error: { message: "Model Not Exist", type: "invalid_request_error", code: "model_not_found" } }),
		)
		await mockFetchForTesting(fetchMock, async () => {
			await expect(callBridge()).rejects.toThrow(/error object/)
			await expect(callBridge()).rejects.toThrow(/Model Not Exist/)
		})
	})

	it("points at the token budget when the model stopped for length", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }))
		await mockFetchForTesting(fetchMock, async () => {
			await expect(callBridge()).rejects.toThrow(/token budget/)
		})
	})

	it("sends the limit it is given", async () => {
		const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
			jsonResponse({ choices: [{ message: { content: "ok" } }] }),
		)
		await mockFetchForTesting(fetchMock as never, () => callBridge({ maxTokens: 123_456 }))
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).max_tokens).toBe(123_456)
	})

	it("sends the prompt it is given instead of the Image Mode prompt", async () => {
		const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
			jsonResponse({ choices: [{ message: { content: "ok" } }] }),
		)
		await mockFetchForTesting(fetchMock as never, () => callBridge({ prompt: "SHORT PROMPT" }))
		const sent = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content[0].text
		expect(sent).toBe("SHORT PROMPT")
	})

	it("sends no limit when none is known", async () => {
		const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
			jsonResponse({ choices: [{ message: { content: "ok" } }] }),
		)
		await mockFetchForTesting(fetchMock as never, () => callBridge())
		expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).not.toHaveProperty("max_tokens")
	})

	it("names the limit it actually sent when the model runs out", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }))
		await mockFetchForTesting(fetchMock, async () => {
			await expect(callBridge({ maxTokens: 9_000 })).rejects.toThrow("max_tokens 9000")
		})
	})

	it("quotes the raw body when a non-OK request fails", async () => {
		const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429 }))
		await mockFetchForTesting(fetchMock, async () => {
			await expect(callBridge()).rejects.toThrow(/429/)
			await expect(callBridge()).rejects.toThrow(/rate limited/)
		})
	})
})
