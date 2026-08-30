/**
 * A scripted stand-in for a model provider, for the debug-harness scenarios.
 *
 * Speaks enough of the OpenAI-compatible wire format for the extension's "openai" provider to
 * talk to it: `GET /v1/models` and `POST /v1/chat/completions`, streaming and not. It needs no
 * credential of any kind, and it never reaches the network.
 *
 * WHY IT EXISTS. A scenario driving a real provider can only assert on what the person typed,
 * because nobody can dictate what a model will say. That leaves the interesting states — a chat
 * parked on a question, a chat held mid-stream, a turn that fails, a run that trips the mistake
 * limit — unreachable, which is to say untested. Here the scenario dictates the reply by what it
 * types, so those states are produced on demand and every run is deterministic, instant and free.
 *
 * HOW A SCENARIO DRIVES IT. The last user message is scanned for a marker; the first one found
 * decides the reply. No marker means a plain assistant message.
 *
 *   STUB_ASK      an `ask_question` tool call — parks the chat on a question until answered
 *   STUB_SLOW     a request accepted and held, with no content, until `POST /control/release`
 *   STUB_ERROR    HTTP 500 with a provider-shaped error body
 *   STUB_BADTOOL  a tool call naming a tool that does not exist, to drive the mistake limit
 *   STUB_TOOL     a `run_commands` tool call, to reach the approval path
 *
 * TOOL NAMES COME FROM THE SDK, NOT FROM PROSE: `ask_question` and `run_commands` are the
 * registered names (`sdk/packages/core/src/extensions/tools/definitions.ts`). A name that is not
 * registered is not rejected — it simply does nothing, which is the hardest kind of wrong to see.
 *
 * CONTROL SURFACE (for the harness and scenarios, not for the extension). A leading `/v1` is
 * optional on every route, so these work appended to the provider base URL too:
 *   GET  /control/state    what has been requested so far, and what is being held
 *   POST /control/release  release every held stream
 *   POST /control/reset    forget the request log and release everything
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"

export const STUB_MODEL_ID = "cline-cubed-stub"

/** The stub authenticates nothing, but the provider wants a key present. This literal IS the
 *  whole credential — there is no real secret anywhere in this file or in what it configures. */
export const STUB_API_KEY = "stub-no-auth"

/** The markers a scenario embeds in a probe to dictate the reply. Exported so the scenarios use
 *  these constants rather than retyping the literals. */
/**
 * NO PUNCTUATION, DELIBERATELY. A marker is typed into a real chat input, and that input treats
 * some characters as commands: `@` opens the context-mention menu, which swallows the send and
 * leaves the message sitting there unsent with nothing reporting a failure. Plain uppercase
 * tokens pass through untouched, and are still unmistakable in a transcript.
 */
export const MARKERS = {
	ask: "STUB_ASK",
	slow: "STUB_SLOW",
	error: "STUB_ERROR",
	badTool: "STUB_BADTOOL",
	tool: "STUB_TOOL",
} as const

export const STUB_QUESTION = "Stub question: which way?"
export const STUB_OPTIONS = ["Option A", "Option B"]

type ChatMessage = { role?: string; content?: unknown }

export type StubRequestLog = {
	at: number
	marker: string | null
	stream: boolean
	lastUserText: string
}

export class StubProvider {
	private server: Server | null = null
	private port = 0
	private requests: StubRequestLog[] = []
	/** Streams parked by STUB_SLOW, each resolved by /control/release. */
	private held: (() => void)[] = []
	/** How many times each conversation has been answered with STUB_BADTOOL, so the malformed
	 *  reply repeats for as long as the agent keeps retrying — which is what trips the limit. */
	private badToolCalls = 0

	/** The base URL to configure the extension's provider with. */
	get url(): string {
		return `http://127.0.0.1:${this.port}/v1`
	}

	/** The base URL for the control routes. Both `/control/...` and `/v1/control/...` are served,
	 *  so a caller that only kept `url` can append to it and still be right. */
	get controlUrl(): string {
		return `http://127.0.0.1:${this.port}/control`
	}

	get isRunning(): boolean {
		return this.server !== null
	}

	async start(preferredPort = 0): Promise<string> {
		if (this.server) {
			return this.url
		}
		this.server = createServer((req, res) => {
			this.handle(req, res).catch((err) => {
				this.json(res, 500, { error: { message: `stub-provider: ${err?.message ?? err}` } })
			})
		})
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject)
			this.server?.listen(preferredPort, "127.0.0.1", () => resolve())
		})
		const addr = this.server.address()
		this.port = typeof addr === "object" && addr ? addr.port : preferredPort
		return this.url
	}

	async stop(): Promise<void> {
		this.releaseAll()
		const server = this.server
		this.server = null
		if (!server) {
			return
		}
		await new Promise<void>((resolve) => server.close(() => resolve()))
	}

	/** Release every stream parked by STUB_SLOW. */
	releaseAll(): number {
		const n = this.held.length
		for (const release of this.held.splice(0)) {
			release()
		}
		return n
	}

	/** Release everything and forget the request log — a clean slate between scenarios. */
	reset(): void {
		this.releaseAll()
		this.requests = []
		this.badToolCalls = 0
	}

	state(): { url: string; requests: StubRequestLog[]; held: number; badToolCalls: number } {
		return { url: this.url, requests: this.requests, held: this.held.length, badToolCalls: this.badToolCalls }
	}

	// ── HTTP ────────────────────────────────────────────────────────────────────────────────

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// A single `/v1` prefix is optional on every route. The provider base URL ends in `/v1`,
		// so anything appending a control path to it arrives as `/v1/control/...`; stripping the
		// prefix once here means both forms work and no caller has to know which to use.
		const raw = (req.url ?? "").split("?")[0]
		const path = raw.startsWith("/v1/") ? raw.slice(3) : raw

		if (path === "/control/state") {
			return this.json(res, 200, this.state())
		}
		if (path === "/control/release") {
			return this.json(res, 200, { released: this.releaseAll() })
		}
		if (path === "/control/reset") {
			this.reset()
			return this.json(res, 200, { ok: true })
		}
		if (path === "/models") {
			return this.json(res, 200, {
				object: "list",
				data: [{ id: STUB_MODEL_ID, object: "model", owned_by: "cline-cubed-debug-harness" }],
			})
		}
		if (path === "/chat/completions") {
			return this.completions(req, res)
		}
		this.json(res, 404, { error: { message: `stub-provider: no route for ${raw}` } })
	}

	private async completions(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readJson(req)
		const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : []
		const lastUserText = this.lastUserText(messages)
		const marker = this.markerIn(lastUserText)
		const stream = body?.stream === true
		this.requests.push({ at: Date.now(), marker, stream, lastUserText: lastUserText.slice(0, 500) })

		if (marker === MARKERS.error) {
			// Shaped like a provider failure rather than a transport one, so the extension's own
			// error handling runs instead of a socket error.
			return this.json(res, 500, {
				error: { message: "stub-provider: induced failure (STUB_ERROR)", type: "server_error", code: "stub_induced" },
			})
		}

		if (marker === MARKERS.ask) {
			return this.respondToolCall(res, stream, "ask_question", { question: STUB_QUESTION, options: STUB_OPTIONS })
		}

		if (marker === MARKERS.tool) {
			return this.respondToolCall(res, stream, "run_commands", { commands: ["echo cline-cubed-stub"] })
		}

		if (marker === MARKERS.badTool) {
			this.badToolCalls++
			// A tool NAME that is not registered, so every reply is an invalid tool call the agent
			// cannot act on — repeated, that is what reaches the consecutive-mistake limit.
			//
			// Bad ARGUMENTS to a real tool do not work for this: `run_commands` with a non-array
			// `commands` is normalised rather than rejected, and the chat parks on an approval
			// prompt instead of counting a mistake.
			return this.respondToolCall(res, stream, "definitely_not_a_registered_tool", { note: "unusable" })
		}

		if (marker === MARKERS.slow) {
			return this.respondHeldStream(res)
		}

		return this.respondText(res, stream, "Stub reply.")
	}

	// ── Replies ─────────────────────────────────────────────────────────────────────────────

	private respondText(res: ServerResponse, stream: boolean, text: string): void {
		if (!stream) {
			this.json(res, 200, this.completion({ content: text }, "stop"))
			return
		}
		this.openStream(res)
		this.sendChunk(res, { delta: { role: "assistant", content: text } })
		this.sendChunk(res, { delta: {}, finish_reason: "stop" })
		this.endStream(res)
	}

	private respondToolCall(res: ServerResponse, stream: boolean, name: string, args: unknown): void {
		const toolCall = {
			id: `call_stub_${Date.now()}`,
			type: "function" as const,
			function: { name, arguments: JSON.stringify(args) },
		}
		if (!stream) {
			this.json(res, 200, this.completion({ content: null, tool_calls: [toolCall] }, "tool_calls"))
			return
		}
		this.openStream(res)
		this.sendChunk(res, {
			delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] },
		})
		this.sendChunk(res, { delta: {}, finish_reason: "tool_calls" })
		this.endStream(res)
	}

	/** Stream a first token, then hold the connection open until /control/release. The chat sits
	 *  genuinely mid-turn for as long as the scenario needs — which is what Cancel is tested
	 *  against. */
	private respondHeldStream(res: ServerResponse): void {
		// Headers only, then NOTHING until released: the request is accepted and in flight, but no
		// content has arrived. That is the state a chat offers Cancel in, and it is the state this
		// exists to produce.
		//
		// Emitting even one chunk ends it. The chat decides its buttons from the LAST message, so
		// the moment assistant text arrives the turn stops being "a request in flight" and becomes
		// "a reply being written" — the Cancel control goes away, and a scenario waiting to press
		// it has nothing to press. Holding silently keeps the turn where Cancel lives.
		this.openStream(res)
		const release = () => {
			try {
				this.sendChunk(res, { delta: { role: "assistant", content: "Stub held this turn, then released it." } })
				this.sendChunk(res, { delta: {}, finish_reason: "stop" })
				this.endStream(res)
			} catch {}
		}
		this.held.push(release)
		// A cancelled turn closes the socket. Drop THIS release (by identity, not by position —
		// other streams may be held at the same time and the array shifts) so a later
		// /control/release does not write to a dead response.
		res.on("close", () => {
			const at = this.held.indexOf(release)
			if (at !== -1) {
				this.held.splice(at, 1)
			}
		})
	}

	// ── Wire helpers ────────────────────────────────────────────────────────────────────────

	private completion(message: Record<string, unknown>, finishReason: string): Record<string, unknown> {
		return {
			id: `chatcmpl-stub-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: STUB_MODEL_ID,
			choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finishReason }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		}
	}

	private openStream(res: ServerResponse): void {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		})
	}

	private sendChunk(res: ServerResponse, choice: Record<string, unknown>): void {
		const chunk = {
			id: `chatcmpl-stub-${Date.now()}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: STUB_MODEL_ID,
			choices: [{ index: 0, finish_reason: null, ...choice }],
		}
		res.write(`data: ${JSON.stringify(chunk)}\n\n`)
	}

	private endStream(res: ServerResponse): void {
		res.write("data: [DONE]\n\n")
		res.end()
	}

	private json(res: ServerResponse, status: number, payload: unknown): void {
		const text = JSON.stringify(payload)
		res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
		res.end(text)
	}

	private async readJson(req: IncomingMessage): Promise<any> {
		const chunks: Buffer[] = []
		for await (const chunk of req) {
			chunks.push(chunk as Buffer)
		}
		if (chunks.length === 0) {
			return {}
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString("utf8"))
		} catch {
			return {}
		}
	}

	/** The text of the last user message, flattening the array-of-parts content shape. */
	private lastUserText(messages: ChatMessage[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i]
			if (m?.role !== "user") continue
			const c = m.content
			if (typeof c === "string") {
				return c
			}
			if (Array.isArray(c)) {
				return c
					.map((part: any) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
					.join(" ")
			}
			return ""
		}
		return ""
	}

	/** The first marker present, in a fixed precedence so a probe carrying two is not ambiguous. */
	private markerIn(text: string): string | null {
		for (const marker of [MARKERS.error, MARKERS.ask, MARKERS.tool, MARKERS.badTool, MARKERS.slow]) {
			if (text.includes(marker)) {
				return marker
			}
		}
		return null
	}
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Run directly to start the stub on its own: `node --experimental-strip-types stub-provider.ts`.
 *
 * The harness server starts it this way rather than importing it, so the two stay independent
 * processes and the stub can equally be driven by hand with curl. It prints one line —
 * `STUB_URL=<url>` — as soon as it is listening, which is what the caller waits for; everything
 * after that is on the control surface above.
 */
async function runAsCli(): Promise<void> {
	const stub = new StubProvider()
	const url = await stub.start()
	// The caller parses this line. Keep it first, and keep the shape.
	console.log(`STUB_URL=${url}`)
	const stop = () => {
		void stub.stop().then(() => process.exit(0))
	}
	process.on("SIGTERM", stop)
	process.on("SIGINT", stop)
}

// `process.argv[1]` is this file when it is the entry point, and something else when it is
// imported (which the scenarios do, for MARKERS and the question text).
if (process.argv[1] && /stub-provider\.[cm]?[jt]s$/.test(process.argv[1])) {
	void runAsCli()
}
