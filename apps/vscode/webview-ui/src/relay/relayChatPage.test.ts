import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The relay's chat page, run in a browser-like document against a stand-in relay. The page is the
 * text of RELAY_CHAT_PAGE in the extension's source, read as text so this test needs nothing from
 * the extension's build.
 */
function pageSource(): { markup: string; script: string } {
	const file = readFileSync(path.resolve(__dirname, "../../../src/core/relay/relayChatPage.ts"), "utf8")
	const start = file.indexOf("String.raw`") + "String.raw`".length
	const page = file.slice(start, file.lastIndexOf("`"))
	const scriptStart = page.indexOf("<script>")
	return { markup: page.slice(0, scriptStart), script: page.slice(scriptStart + 8, page.lastIndexOf("</script>")) }
}

function jsonResponse(body: unknown) {
	return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => body }
}

/** Opens the page on one chat, and lets the test decide what the relay hands it next. */
function openPage(firstContextUsed: number) {
	const queue: unknown[] = [
		{
			kind: "snapshot",
			seq: 1,
			payload: {
				messages: [],
				working: false,
				title: "A chat",
				workspace: "project",
				meta: { context: { used: firstContextUsed, window: 1200, compactAt: 1000 }, usage: {}, allChatsCost: 0 },
			},
		},
	]
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			const route = new URL(url, "http://localhost").searchParams.get("route")
			if (route === "pairing") {
				return jsonResponse({ paired: true })
			}
			if (url.includes("cursor=latest")) {
				return jsonResponse({ events: [], cursor: 0 })
			}
			if (route?.endsWith("/inbound")) {
				return jsonResponse({ accepted: 1 })
			}
			const events = queue.splice(0)
			return jsonResponse({ events, cursor: events.length ? 99 : 99, dropped: 0 })
		}),
	)
	// The test document does not scroll; the page's scroll-to-bottom is a no-op here.
	vi.stubGlobal("scrollTo", vi.fn())
	const { markup, script } = pageSource()
	document.body.innerHTML = markup
	window.location.hash = "#session_chat-0001"
	new Function(script)()
	return {
		relaySends: (event: unknown) => queue.push(event),
	}
}

describe("relay chat page — context warning bar", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		document.body.innerHTML = ""
	})

	it("stays hidden below 80% of the way to compaction", async () => {
		openPage(500)
		await vi.waitFor(() => expect(document.getElementById("ring-text")?.textContent).toBe("50%"), { timeout: 4000 })
		expect(document.getElementById("context-bar")?.classList.contains("hidden")).toBe(true)
	})

	it("appears past 80%, and turns to the warning color past 95%", async () => {
		const page = openPage(850)
		const bar = () => document.getElementById("context-bar") as HTMLElement
		await vi.waitFor(() => expect(bar().classList.contains("hidden")).toBe(false), { timeout: 4000 })
		expect(bar().textContent).toContain("Context 85% full")
		expect(bar().classList.contains("warn")).toBe(false)

		page.relaySends({
			kind: "update",
			seq: 2,
			payload: { messages: [], order: [], working: false, meta: { context: { used: 960, window: 1200, compactAt: 1000 } } },
		})
		await vi.waitFor(() => expect(bar().classList.contains("warn")).toBe(true), { timeout: 4000 })
		expect(bar().textContent).toContain("Context 96% full")
		expect(document.getElementById("ring")?.classList.contains("warn")).toBe(true)
	})
})

describe("relay chat page — sending messages back to back", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		document.body.innerHTML = ""
	})

	/**
	 * Opens the page on one chat with a relay that holds each message post open until the test
	 * answers it, and records the text of every message posted.
	 */
	function openHeldPage() {
		const posted: string[] = []
		const held: Array<(failed?: boolean) => void> = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { body?: string }) => {
				const route = new URL(url, "http://localhost").searchParams.get("route")
				if (route === "pairing") {
					return jsonResponse({ paired: true })
				}
				if (route?.endsWith("/inbound")) {
					const body = JSON.parse(init?.body ?? "{}") as { events: Array<{ kind: string; payload: { text?: string } }> }
					const message = body.events.find((event) => event.kind === "message")
					if (!message) {
						return jsonResponse({ accepted: 1 })
					}
					posted.push(message.payload.text ?? "")
					return new Promise((resolve) => {
						held.push((failed) =>
							resolve(
								failed
									? {
											ok: false,
											status: 500,
											headers: { get: () => "application/json" },
											json: async () => ({ error: "relay_save_failed" }),
										}
									: jsonResponse({ accepted: 1 }),
							),
						)
					})
				}
				return jsonResponse({ events: [], cursor: 0, dropped: 0 })
			}),
		)
		vi.stubGlobal("scrollTo", vi.fn())
		const { markup, script } = pageSource()
		document.body.innerHTML = markup
		window.location.hash = "#session_chat-0001"
		new Function(script)()
		const box = () => document.getElementById("message-input") as HTMLTextAreaElement
		const submit = (text: string) => {
			box().value = text
			document.getElementById("composer")?.dispatchEvent(new Event("submit", { cancelable: true }))
		}
		return { posted, held, box, submit }
	}

	it("keeps what is typed while the previous message is still sending", async () => {
		const page = openHeldPage()
		page.submit("message 1")
		await vi.waitFor(() => expect(page.posted).toEqual(["message 1"]))
		const boxAfterSend = page.box().value
		// The next message is typed while the first is still on its way, and the first then lands.
		page.box().value = "message 2"
		page.held[0]()
		await new Promise((resolve) => setTimeout(resolve, 50))
		const boxAfterFirstLands = page.box().value
		page.submit(page.box().value)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect({ boxAfterSend, boxAfterFirstLands, posted: page.posted }).toEqual({
			boxAfterSend: "",
			boxAfterFirstLands: "message 2",
			posted: ["message 1", "message 2"],
		})
	})

	it("puts a message back in the box when its send fails", async () => {
		const page = openHeldPage()
		page.submit("message 3")
		await vi.waitFor(() => expect(page.posted).toEqual(["message 3"]))
		page.held[0](true)
		await vi.waitFor(() => expect(page.box().value).toBe("message 3"))
	})
})

describe("relay chat page — the suggested reply", () => {
	// Pages from earlier tests are still running, and follow the address to the next test's chat.
	// Each page here is handed its own fetch, which stops answering once its test ends, and the
	// global fetch the earlier pages use never answers, so only this test's page sees its events.
	const ended: Array<() => void> = []
	beforeEach(() => {
		vi.stubGlobal("fetch", () => new Promise(() => {}))
	})
	afterEach(async () => {
		for (const end of ended.splice(0)) {
			end()
		}
		// An answer already on its way lands before the document is cleared.
		await new Promise((resolve) => setTimeout(resolve, 100))
		vi.unstubAllGlobals()
		vi.stubGlobal("fetch", () => new Promise(() => {}))
		document.body.innerHTML = ""
	})
	let chatNumber = 0

	const meta = (suggestion: string) => ({
		context: { used: 0, window: 1200, compactAt: 1000 },
		usage: {},
		allChatsCost: 0,
		suggestion,
	})

	/** Opens the page on a chat whose snapshot carries this suggestion, recording each message posted. */
	function openSuggestionPage(suggestion: string, working = false) {
		chatNumber++
		const chatId = `chat-suggest-${chatNumber}`
		const posted: string[] = []
		const queue: unknown[] = []
		// Sent whenever the page asks for the chat whole, as the extension does.
		const snapshot = [
			{
				kind: "snapshot",
				seq: 1,
				payload: {
					messages: [
						{ ts: 1, type: "say", say: "text", text: "Should I write the plan?", partial: false, hasImages: false },
					],
					working,
					title: "A chat",
					workspace: "project",
					meta: meta(suggestion),
				},
			},
		]
		let live = true
		ended.push(() => {
			live = false
		})
		const pageFetch = vi.fn(async (url: string, init?: { body?: string }) => {
			if (!live) {
				return new Promise(() => {})
			}
			const route = new URL(url, "http://localhost").searchParams.get("route")
			if (route === "pairing") {
				return jsonResponse({ paired: true })
			}
			if (url.includes("cursor=latest")) {
				return jsonResponse({ events: [], cursor: 0 })
			}
			if (route === `session/${chatId}/inbound`) {
				const body = JSON.parse(init?.body ?? "{}") as { events: Array<{ kind: string; payload: { text?: string } }> }
				for (const event of body.events) {
					if (event.kind === "message") {
						posted.push(event.payload.text ?? "")
					}
					if (event.kind === "sync") {
						queue.push(...snapshot)
					}
				}
				return jsonResponse({ accepted: 1 })
			}
			if (route !== `session/${chatId}/outbound`) {
				return jsonResponse({ events: [], cursor: 99, dropped: 0 })
			}
			const events = queue.splice(0)
			return jsonResponse({ events, cursor: 99, dropped: 0 })
		})
		vi.stubGlobal("scrollTo", vi.fn())
		const { markup, script } = pageSource()
		document.body.innerHTML = markup
		window.location.hash = `#session_${chatId}`
		new Function("fetch", script)(pageFetch)
		const box = () => document.getElementById("message-input") as HTMLTextAreaElement
		const tab = () => document.getElementById("suggestion-tab") as HTMLButtonElement
		const press = (init: KeyboardEventInit) => {
			const event = new KeyboardEvent("keydown", { cancelable: true, ...init })
			box().dispatchEvent(event)
			return event
		}
		return { posted, box, tab, press, relaySends: (event: unknown) => queue.push(event) }
	}

	it("shows the suggestion in the empty box with a Tab button", async () => {
		const page = openSuggestionPage("yes, write the plan")
		await vi.waitFor(() => expect(page.tab().classList.contains("hidden")).toBe(false), { timeout: 4000 })
		expect(page.box().placeholder).toBe("yes, write the plan")
		expect(page.box().value).toBe("")
	})

	it("a tap on Tab puts the suggestion in the box and sends nothing", async () => {
		const page = openSuggestionPage("yes, write the plan")
		await vi.waitFor(() => expect(page.tab().classList.contains("hidden")).toBe(false), { timeout: 4000 })
		page.tab().click()
		expect(page.box().value).toBe("yes, write the plan")
		expect(page.tab().classList.contains("hidden")).toBe(true)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(page.posted).toEqual([])
	})

	it("the Tab key puts it in the box, but not with Shift held or with text in the box", async () => {
		const page = openSuggestionPage("yes, write the plan")
		await vi.waitFor(() => expect(page.tab().classList.contains("hidden")).toBe(false), { timeout: 4000 })
		const shifted = page.press({ key: "Tab", shiftKey: true })
		expect({ value: page.box().value, prevented: shifted.defaultPrevented }).toEqual({ value: "", prevented: false })

		page.box().value = "n"
		page.box().dispatchEvent(new Event("input"))
		expect(page.tab().classList.contains("hidden")).toBe(true)
		const typed = page.press({ key: "Tab" })
		expect({ value: page.box().value, prevented: typed.defaultPrevented }).toEqual({ value: "n", prevented: false })

		page.box().value = ""
		page.box().dispatchEvent(new Event("input"))
		const plain = page.press({ key: "Tab" })
		expect({ value: page.box().value, prevented: plain.defaultPrevented }).toEqual({
			value: "yes, write the plan",
			prevented: true,
		})
	})

	it("is hidden while the model is working, and goes when an update carries none", async () => {
		const page = openSuggestionPage("yes, write the plan", true)
		await vi.waitFor(() => expect(document.getElementById("working")?.classList.contains("hidden")).toBe(false), {
			timeout: 4000,
		})
		expect(page.tab().classList.contains("hidden")).toBe(true)
		expect(page.box().placeholder).toBe("Message this chat")

		page.relaySends({ kind: "update", seq: 2, payload: { messages: [], order: [1], working: false, meta: meta("yes, go") } })
		await vi.waitFor(() => expect(page.tab().classList.contains("hidden")).toBe(false), { timeout: 4000 })
		page.relaySends({ kind: "update", seq: 3, payload: { messages: [], order: [1], working: false, meta: meta("") } })
		await vi.waitFor(() => expect(page.tab().classList.contains("hidden")).toBe(true), { timeout: 4000 })
		expect(page.box().placeholder).toBe("Message this chat")
	})

	it("sends the suggestion once it is in the box and Enter is pressed", async () => {
		const page = openSuggestionPage("yes, write the plan")
		await vi.waitFor(() => expect(page.tab().classList.contains("hidden")).toBe(false), { timeout: 4000 })
		page.tab().click()
		page.press({ key: "Enter" })
		await vi.waitFor(() => expect(page.posted).toEqual(["yes, write the plan"]))
	})
})
