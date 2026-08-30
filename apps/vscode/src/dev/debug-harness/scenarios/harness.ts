/**
 * Shared client for the debug-harness scenarios.
 *
 * Every scenario talks to the harness server the same way, opens chats the same way and reports
 * the same way; this is that, in one place, so a fix lands once instead of once per script.
 *
 * TWO RULES THIS MODULE EXISTS TO ENFORCE:
 *
 * 1. **Address a chat by its surface id, never by position.** `openChat()` returns the id of the
 *    chat it just opened, and every helper here takes that id. The positional `surface:<n>`
 *    selector orders chats by webview URL — a random origin GUID — so it is neither open order
 *    nor stable while surfaces are being created, closed or reloaded. An index captured at one
 *    step can address a different chat at the next, which lets an assertion pass for the wrong
 *    reason. A check that can pass for the wrong reason is worse than no check.
 *
 * 2. **Assert on what the scenario typed, never on what the model replied.** The probe text is
 *    the scenario's own, so it is exact; a reply is not the scenario's to predict.
 */

export const API = process.env.HARNESS_API ?? "http://localhost:19229/api"

export type ApiResult = Record<string, any>

/** POST one harness command. One retry on a transport error: the server's HTTP keep-alive closes
 *  idle sockets after ~5s, and a request issued right after a longer wait can land on the reused
 *  dead socket. */
export async function api(method: string, params?: Record<string, unknown>): Promise<ApiResult> {
	const body = JSON.stringify(params ? { method, params } : { method })
	const send = () => fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body })
	let res: Response
	try {
		res = await send()
	} catch {
		await sleep(500)
		res = await send()
	}
	if (!res.ok) {
		throw new Error(`${method} → HTTP ${res.status}: ${await res.text()}`)
	}
	const payload = (await res.json()) as ApiResult
	if (payload?.error) {
		throw new Error(`${method} → ${payload.error}`)
	}
	// The server wraps every payload as {result: ...}; hand callers the payload itself.
	return (payload.result ?? payload) as ApiResult
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── Reporting ───────────────────────────────────────────────────────────────────────────────

const results: { name: string; pass: boolean; detail: string }[] = []

export function assert(name: string, pass: boolean, detail: string): void {
	results.push({ name, pass, detail })
	console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`)
}

/** Print the tally and exit: 0 = all passed, 1 = an assertion failed. A scenario that cannot run
 *  at all exits 2 from its own catch, so "broken" is never mistaken for "failed". */
export function report(): never {
	const failed = results.filter((r) => !r.pass)
	console.log(`\n${"─".repeat(72)}`)
	console.log(`${results.length - failed.length}/${results.length} passed`)
	if (failed.length > 0) {
		console.log(`\nFAILED:`)
		for (const f of failed) {
			console.log(`  • ${f.name}\n    ${f.detail}`)
		}
	}
	console.log(`${"─".repeat(72)}\n`)
	process.exit(failed.length > 0 ? 1 : 0)
}

/** Wrap a scenario's main so an abort is reported as "could not run" (2), never as a failure. */
export function run(main: () => Promise<void>): void {
	main().catch((err) => {
		console.error(`\nScenario aborted: ${err.message}\n`)
		process.exit(2)
	})
}

// ── App lifecycle ───────────────────────────────────────────────────────────────────────────

/** Dismiss the promotional overlay that blocks a fresh launch (harness README: may need twice). */
export async function dismissOverlays(): Promise<void> {
	for (let i = 0; i < 2; i++) {
		await api("web.evaluate", {
			expression: `document.querySelectorAll(".sr-only").forEach(el => el.parentElement?.click())`,
		}).catch(() => {})
		await sleep(300)
	}
}

/**
 * Markers a scenario embeds in a probe to dictate what the stub replies with. Re-exported from
 * the stub so a scenario never retypes a literal that has to match on both sides.
 */
export { MARKERS, STUB_OPTIONS, STUB_QUESTION } from "../stub-provider"

/**
 * Refuse to run unless the scripted stub provider is serving the debugee.
 *
 * Fail-closed on purpose. Without the stub a scenario silently drives whatever provider the
 * profile holds: every probe is billed, replies cannot be dictated, and the states these
 * scenarios exist to reach are unreachable anyway. Spending someone's money to test nothing is
 * not a degraded run — it is a reason to stop.
 */
export async function requireStub(): Promise<void> {
	const status = await api("status")
	if (!status.stubEnabled) {
		throw new Error(
			"The harness server is running with --no-stub, so this scenario would drive a REAL provider " +
				"and be billed for every probe. Restart the server without --no-stub.",
		)
	}
	if (status.running && !status.stubUrl) {
		throw new Error("The stub provider is enabled but not running — check the harness server's log.")
	}
}

/** What the stub has been asked for, and what it is holding open. */
export async function stubState(): Promise<{ running: boolean; requests?: any[]; held?: number }> {
	return (await api("stub.state")) as any
}

/** Release every turn the stub is holding open for `STUB_SLOW`. */
export async function stubRelease(): Promise<number> {
	const { released } = await api("stub.release")
	return Number(released ?? 0)
}

/** Wait until the stub is holding at least `n` turns open — i.e. that many chats are genuinely
 *  mid-stream. Waiting on the stub's own state beats sleeping and hoping. */
export async function waitForHeldTurns(n: number, timeoutMs = 20000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const { held } = await stubState()
		if ((held ?? 0) >= n) {
			return true
		}
		await sleep(300)
	}
	return false
}

/** Relaunch VS Code and clear the overlays, leaving the app ready for `openChat()`.
 *  Chats left over from an earlier run no longer confuse addressing — every chat is named by its
 *  own id — but a known-empty app still makes a failure far easier to read. */
export async function freshApp(state?: Record<string, unknown>): Promise<void> {
	await requireStub()
	const status = await api("status")
	if (status.running) {
		await api("shutdown").catch(() => {})
		await sleep(3000)
	}
	console.log(`launching a fresh VSCode…${state ? ` with ${JSON.stringify(state)}` : ""}`)
	// `state` is written into the debugee's settings BEFORE VS Code starts — the only moment that
	// works, since the extension reads them at activation. It is how a scenario exercises
	// behaviour that depends on a SETTING rather than on what it clicks.
	await api("launch", { skipBuild: true, ...(state ? { state } : {}) })
	await sleep(3000)
	await api("ui.open_sidebar")
	await dismissOverlays()
	await sleep(1000)
	// Clean slate: the request log and any held turns belong to the previous run, not this one.
	await api("stub.reset").catch(() => {})
}

// ── Chats, addressed by identity ────────────────────────────────────────────────────────────

/** Where new chats open. The values the setting itself uses (`state-keys.ts`). */
export const CHAT_LOCATION = { editor: "editor", secondarySidebar: "secondarySidebar" } as const

/** Reveal the secondary sidebar's chat — Button #3's container. */
export async function openSecondarySidebar(): Promise<boolean> {
	try {
		await api("ui.command_palette", { command: "View: Toggle Secondary Side Bar" })
		await sleep(1500)
		return true
	} catch {
		return false
	}
}

/** The surface ids of every chat webview open right now (the chats LIST is excluded server-side). */
export async function surfaceIds(): Promise<string[]> {
	const { surfaceIds } = await api("ui.frames")
	return Array.isArray(surfaceIds) ? (surfaceIds as string[]) : []
}

/** The chat's message box. Named once: several helpers wait for it before touching a chat. */
const CHAT_INPUT = '[data-testid="chat-input"]'

/** The `frame` selector that addresses one chat for the life of the run. */
export function frameOf(surfaceId: string): string {
	return `surface-id:${surfaceId}`
}

/**
 * Open a new chat and return ITS surface id — the handle a scenario holds from here on.
 *
 * The id is found by diffing the open-surface set across the command rather than by counting or
 * by hunting the transcripts for content: it needs no reply from any model, and it cannot be
 * confused by another chat opening at the same moment.
 *
 * New Chat pressed while the target still holds an EMPTY home reveals that home rather than
 * creating a second chat — correct behaviour, since an unused home is not a chat to open another
 * beside. The retry below covers it, but a scenario that gives each chat a conversation before
 * opening the next one gets there in one press instead of two.
 */
export async function openChat(label = "chat", timeoutMs = 30000): Promise<string> {
	const before = new Set(await surfaceIds())
	const deadline = Date.now() + timeoutMs

	// Retried, not pressed once and hoped for. The palette is driven by keystrokes against the
	// window, and immediately after typing into a chat the focus is inside a webview iframe, so a
	// press can be swallowed with no error anywhere.
	//
	// The retry must NOT press Escape first. Escape cancels a RUNNING TURN, so a retry here would
	// quietly kill whatever another chat was in the middle of — destroying the very state a
	// scenario had just set up, and reporting it as a failed precondition rather than as the
	// harness's own doing. Re-invoking the palette is safe on its own: `ui.command_palette` opens
	// it fresh each time, so a half-open palette is replaced rather than typed into.
	for (let attempt = 1; Date.now() < deadline; attempt++) {
		if (attempt > 1) {
			await sleep(700)
		}
		await api("ui.command_palette", { command: "Cline Cubed: New Chat" }).catch(() => {})

		const attemptDeadline = Math.min(deadline, Date.now() + 8000)
		while (Date.now() < attemptDeadline) {
			const fresh = (await surfaceIds()).filter((id) => !before.has(id))
			if (fresh.length > 0) {
				// A surface id appears as soon as the webview registers, which is BEFORE its UI has
				// rendered. Returning then hands back a chat whose input does not exist yet, and the
				// very next `sendInto` fails with "Element not found". Wait for the input, so what
				// this returns is a chat that can actually be typed into.
				await api("ui.wait_for_selector", {
					frame: frameOf(fresh[0]),
					selector: CHAT_INPUT,
					timeout: 20000,
				})
				console.log(`opened ${label} → ${fresh[0]}${attempt > 1 ? ` (attempt ${attempt})` : ""}`)
				return fresh[0]
			}
			await sleep(300)
		}
	}
	throw new Error(`"${label}" did not open: no new chat surface appeared within ${timeoutMs}ms`)
}

/**
 * Open a new chat by pressing NEW CHAT IN THE CHATS LIST — the button a person presses — and
 * return its surface id.
 *
 * `openChat` drives the command palette instead. Both create a chat, but they are different entry
 * points, and a scenario about the chats list should reach the chats list the way a person does:
 * the button posts `newChatFromList`, which asks the host to open a chat in the configured
 * location.
 *
 * The new chat is identified by diffing the open-surface set across the press, exactly as
 * `openChat` does — nothing here depends on a model replying or on what any chat says.
 */
export async function newChatFromChatsList(label = "chat", timeoutMs = 30000): Promise<string> {
	const before = new Set(await surfaceIds())
	const deadline = Date.now() + timeoutMs

	for (let attempt = 1; Date.now() < deadline; attempt++) {
		if (attempt > 1) {
			await sleep(700)
		}
		await api("ui.open_sidebar").catch(() => {})
		await sleep(800)
		await api("ui.click", { frame: "chats-list", selector: 'vscode-button:has-text("New Chat")' }).catch(() => {})

		const attemptDeadline = Math.min(deadline, Date.now() + 8000)
		while (Date.now() < attemptDeadline) {
			const fresh = (await surfaceIds()).filter((id) => !before.has(id))
			if (fresh.length > 0) {
				// A surface id appears when the webview registers, which is before its UI renders —
				// wait for the input, so this hands back a chat that can actually be typed into.
				await api("ui.wait_for_selector", { frame: frameOf(fresh[0]), selector: CHAT_INPUT, timeout: 20000 })
				console.log(`opened ${label} from the chats list → ${fresh[0]}${attempt > 1 ? ` (attempt ${attempt})` : ""}`)
				return fresh[0]
			}
			await sleep(300)
		}
	}
	throw new Error(`"${label}" did not open from the chats list within ${timeoutMs}ms`)
}

/**
 * Type `text` into one named chat and send it.
 *
 * Sent by CLICKING the chat's own send button, not by pressing Enter. Enter is delivered to the
 * window, so it lands wherever focus happens to be — on a chat's home screen that can be the
 * history search box, and the message then sits in the input unsent with nothing reporting a
 * failure anywhere. The keypress remains as a fallback for a surface with no send button.
 */
export async function sendInto(surfaceId: string, text: string): Promise<void> {
	const frame = frameOf(surfaceId)
	// Cheap insurance: a chat can be re-rendered between steps (opening another chat, a mode
	// change), so wait for the input rather than assume it is still mounted from last time.
	await api("ui.wait_for_selector", { frame, selector: CHAT_INPUT, timeout: 20000 })
	await api("ui.react_input", { frame, text, clear: true })
	await sleep(400)
	try {
		await api("ui.click", { frame, selector: '[data-testid="send-button"]' })
		return
	} catch {
		await api("ui.react_input", { frame, text: "", clear: false, submit: true })
	}
}

/**
 * Click an editor TAB in VS Code's own chrome — outside every webview.
 *
 * `ui.click` with no `frame` targets the window rather than a chat, which is what reaches the tab
 * strip, the activity bar and the sidebar. Tabs carry their chat's name (or its first prompt), so
 * a tab is addressed by the text the scenario itself typed.
 */
export async function clickEditorTab(labelFragment: string): Promise<boolean> {
	for (const selector of [`.tab:has-text("${labelFragment}")`, `.tab [aria-label*="${labelFragment}"]`]) {
		try {
			await api("ui.click", { selector })
			return true
		} catch {}
	}
	return false
}

/**
 * The text of ONE editor group's tab strip — the first `.tabs-container` in the window — purely
 * for diagnostics. It is NOT a list of every open tab: VS Code gives each editor group its own
 * strip, and chats opened side by side commonly live in more than one, so this shows a slice.
 * Named for what it returns so a partial reading is never mistaken for a complete one.
 *
 * Read with `ui.get_text` and NO `frame`, which targets the VS Code window. `web.evaluate` is the
 * wrong tool here: it runs in the WEBVIEW debugging session, whose DOM has no tab strip at all,
 * so it reports "no tabs" while tabs are plainly on screen.
 */
export async function oneEditorTabStripText(): Promise<string> {
	const r = await api("ui.get_text", { selector: ".tabs-container" }).catch(() => null)
	return String((r as any)?.text ?? "")
		.replace(/\s+/g, " ")
		.trim()
}

/** Press the in-chat "X" — the control that returns a chat to the home WITHOUT closing its tab. */
export async function pressInChatClose(surfaceId: string): Promise<boolean> {
	try {
		await api("ui.click", { frame: frameOf(surfaceId), selector: '[aria-label="New Task"]' })
		return true
	} catch {
		return false
	}
}

/** Type into one named chat WITHOUT submitting — for checking a chat still accepts input. */
export async function typeInto(surfaceId: string, text: string): Promise<string> {
	const typed = await api("ui.react_input", { frame: frameOf(surfaceId), text, clear: true })
	return String(typed.value ?? "")
}

export async function transcriptOf(surfaceId: string): Promise<{ text: string; length: number; hash: string }> {
	const t = await api("ui.transcript", { frame: frameOf(surfaceId) })
	return { text: String(t.text ?? ""), length: Number(t.length ?? 0), hash: String(t.hash ?? "") }
}

/**
 * Wait for `text` to appear in one named chat. Returns true if it arrived.
 *
 * This replaces waiting for a whole conversation to "settle": the probe is the scenario's own
 * text, so its arrival is the exact event worth waiting for, and nothing here depends on how long
 * a model takes or on what it says.
 */
export async function waitForText(surfaceId: string, text: string, timeoutMs = 20000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const { text: seen } = await transcriptOf(surfaceId).catch(() => ({ text: "", length: 0, hash: "" }))
		if (seen.includes(text)) {
			return true
		}
		await sleep(500)
	}
	return false
}

/** Wait until a chat stops changing — two identical reads a second apart, or the timeout.
 *  Used only to steady a SECONDARY signal (a transcript hash); never to decide an assertion. */
export async function waitForQuiet(surfaceId: string, timeoutMs = 20000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	let prev = ""
	while (Date.now() < deadline) {
		const { hash } = await transcriptOf(surfaceId).catch(() => ({ text: "", length: 0, hash: "" }))
		if (prev && hash === prev) {
			return
		}
		prev = hash
		await sleep(1000)
	}
}

/** Assert one chat holds its own probe and none of the others'. The content check that decides
 *  isolation — a transcript hash is reported alongside it as a secondary signal only, because any
 *  late self-update (a cost counter, a status row) moves the hash without anything being wrong. */
export function assertHoldsOnly(
	label: string,
	transcript: { text: string },
	ownProbe: string,
	foreignProbes: { probe: string; owner: string }[],
): void {
	assert(
		`${label} still shows its own conversation`,
		transcript.text.includes(ownProbe),
		transcript.text.includes(ownProbe) ? "own probe present" : "own probe MISSING — the chat lost its conversation",
	)
	for (const { probe, owner } of foreignProbes) {
		const misrouted = transcript.text.includes(probe)
		assert(
			`${label} does NOT show ${owner}'s message`,
			!misrouted,
			misrouted ? `it is displaying ${owner}'s message` : "absent, as it should be",
		)
	}
}
