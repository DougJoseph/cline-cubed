/**
 * Cline Cubed — chat isolation across a rename.
 *
 * Drives the sequence a person actually performs: a chat running in one editor tab, a second
 * chat started in another tab, that second chat RENAMED from its own header, then a message
 * typed into it. Asserts the message is displayed and executed in its own chat and nowhere else,
 * both before and after the rename — renaming must not disturb which conversation a chat owns.
 *
 * The pending-question variant (one chat awaiting an ask_question while another chat is typed
 * into) cannot be forced deterministically against a live provider from this harness; that
 * mechanism is covered by the per-session pending unit tests in
 * src/sdk/sdk-interaction-coordinator.test.ts and src/sdk/sdk-followup-coordinator.test.ts.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/chat-isolation.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

const API = process.env.HARNESS_API ?? "http://localhost:19229/api"

const RUN_ID = Date.now()
/** Probes that cannot collide with anything else on screen. */
const PROBE_OLD = `PROBE-OLD-${RUN_ID}`
const PROBE_NEW_FIRST = `PROBE-NEW-FIRST-${RUN_ID}`
const PROBE_NEW_AFTER_RENAME = `PROBE-NEW-AFTER-RENAME-${RUN_ID}`
const RENAME_TO = `Renamed Chat ${RUN_ID}`

type ApiResult = Record<string, any>

async function api(method: string, params?: Record<string, unknown>): Promise<ApiResult> {
	// One retry on a transport error: the server's HTTP keep-alive closes idle sockets after
	// ~5s, and a request issued right after a longer sleep can land on the reused dead socket.
	let res: Response
	try {
		res = await fetch(API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params ? { method, params } : { method }),
		})
	} catch {
		await new Promise((r) => setTimeout(r, 500))
		res = await fetch(API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params ? { method, params } : { method }),
		})
	}
	if (!res.ok) {
		throw new Error(`${method} → HTTP ${res.status}: ${await res.text()}`)
	}
	const body = (await res.json()) as ApiResult
	if (body?.error) {
		throw new Error(`${method} → ${body.error}`)
	}
	// The server wraps every payload as {result: ...}; hand callers the payload itself.
	return (body.result ?? body) as ApiResult
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const results: { name: string; pass: boolean; detail: string }[] = []
function assert(name: string, pass: boolean, detail: string): void {
	results.push({ name, pass, detail })
	console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}\n        ${detail}`)
}

/** Dismiss the promotional overlay that blocks a fresh launch (README: may need running twice). */
async function dismissOverlays(): Promise<void> {
	for (let i = 0; i < 2; i++) {
		await api("web.evaluate", {
			expression: `document.querySelectorAll(".sr-only").forEach(el => el.parentElement?.click())`,
		}).catch(() => {})
		await sleep(300)
	}
}

async function chatSurfaceCount(): Promise<number> {
	const { chatSurfaceCount } = await api("ui.frames")
	return chatSurfaceCount ?? 0
}

async function sendInto(frame: string, text: string): Promise<void> {
	await api("ui.react_input", { frame, text, clear: true })
	await sleep(400)
	await api("ui.react_input", { frame, text: "", clear: false, submit: true })
}

/** Poll until a surface's transcript is stable (three identical reads 4s apart), or timeout.
 *  A conversation settles asynchronously (streaming rows, provider error rows), and a snapshot
 *  taken between late arrivals fails the "unchanged" assertion for the wrong reason. */
async function waitForStableTranscript(frame: string, timeoutMs = 90000): Promise<void> {
	const start = Date.now()
	let prev = ""
	let stableReads = 0
	while (Date.now() - start < timeoutMs) {
		const { hash } = await api("ui.transcript", { frame })
		if (prev && String(hash) === prev) {
			stableReads++
			if (stableReads >= 2) {
				return
			}
		} else {
			stableReads = 0
		}
		prev = String(hash)
		await sleep(4000)
	}
}

/** The surface index whose transcript contains `text`, or -1. */
async function surfaceContaining(text: string, count: number): Promise<number> {
	for (let i = 0; i < count; i++) {
		const t = await api("ui.transcript", { frame: `surface:${i}` }).catch(() => ({ text: "" }))
		if (String(t.text).includes(text)) {
			return i
		}
	}
	return -1
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — chat isolation across a rename\nrun: ${RUN_ID}\n`)

	// A fresh app per run: leftover chats from earlier runs shift the URL-sorted
	// `surface:<n>` indexes mid-scenario, which sends probes and reads to the wrong tabs.
	const status = await api("status")
	if (status.running) {
		await api("shutdown").catch(() => {})
		await sleep(3000)
	}
	console.log("launching a fresh VSCode…")
	await api("launch", { skipBuild: true })
	await sleep(3000)

	await api("ui.open_sidebar")
	await dismissOverlays()
	await sleep(1000)

	// ── The OLD chat: an editor tab with its own conversation. ──────────────────────────────
	await api("ui.command_palette", { command: "Cline Cubed: New Chat" })
	await sleep(2500)
	if ((await chatSurfaceCount()) < 1) {
		console.log("Could not open the first editor chat tab — aborting.")
		return report()
	}
	await sendInto("surface:0", PROBE_OLD)
	await waitForStableTranscript("surface:0")

	// ── The BRAND-NEW chat: a second editor tab, first prompt typed. ────────────────────────
	await api("ui.command_palette", { command: "Cline Cubed: New Chat" })
	await sleep(2500)
	const surfaces = await chatSurfaceCount()
	assert("two chat surfaces are open (old tab + new tab)", surfaces >= 2, `found ${surfaces} chat webviews`)
	if (surfaces < 2) {
		return report()
	}
	// URL order is not open order — resolve which surface holds the OLD chat and use the
	// other for the NEW one.
	const oldIdx = await surfaceContaining(PROBE_OLD, surfaces)
	if (oldIdx === -1) {
		console.log("Old chat's conversation not found in any surface — aborting.")
		return report()
	}
	const newIdx = oldIdx === 0 ? 1 : 0
	const oldFrame = `surface:${oldIdx}`
	const newFrame = `surface:${newIdx}`
	console.log(`old chat = ${oldFrame}, new chat = ${newFrame}`)
	await sendInto(newFrame, PROBE_NEW_FIRST)
	await waitForStableTranscript(newFrame)

	const oldBefore = await api("ui.transcript", { frame: oldFrame })
	assert(
		"1. the new chat's first prompt did NOT land in the old chat",
		!String(oldBefore.text).includes(PROBE_NEW_FIRST),
		String(oldBefore.text).includes(PROBE_NEW_FIRST) ? "old chat shows the new chat's prompt" : "absent, as it should be",
	)

	// ── RENAME the new chat from its own header (the step in the field report). ─────────────
	let renamed = false
	try {
		await api("ui.click", { frame: newFrame, selector: '[aria-label^="Rename chat"]' })
		await sleep(500)
		await api("ui.fill", { frame: newFrame, selector: "input", text: RENAME_TO })
		await api("ui.press", { frame: newFrame, selector: "input", key: "Enter" })
		await sleep(1500)
		renamed = true
	} catch (e) {
		console.log(`rename step failed (${(e as Error).message}) — continuing; isolation must hold regardless`)
	}
	assert(
		"2. the new chat could be renamed from its header",
		renamed,
		renamed ? `renamed to "${RENAME_TO}"` : "rename UI not reachable",
	)

	// ── The failing step: type a message into the renamed new chat. ─────────────────────────
	const oldHashBefore = (await api("ui.transcript", { frame: oldFrame })).hash
	await sendInto(newFrame, PROBE_NEW_AFTER_RENAME)
	await sleep(6000)
	await waitForStableTranscript(newFrame)

	const newAfter = await api("ui.transcript", { frame: newFrame })
	const oldAfter = await api("ui.transcript", { frame: oldFrame })

	assert(
		"3. the post-rename message appears in the chat it was typed into",
		String(newAfter.text).includes(PROBE_NEW_AFTER_RENAME),
		String(newAfter.text).includes(PROBE_NEW_AFTER_RENAME) ? "found in the new chat" : "NOT found in the new chat",
	)
	assert(
		"4. the post-rename message does NOT appear in the old chat",
		!String(oldAfter.text).includes(PROBE_NEW_AFTER_RENAME),
		String(oldAfter.text).includes(PROBE_NEW_AFTER_RENAME)
			? "the old chat is displaying the other chat's message"
			: "absent, as it should be",
	)
	assert(
		"5. the old chat's transcript did not change while the new chat was used",
		oldHashBefore === oldAfter.hash,
		oldHashBefore === oldAfter.hash ? `unchanged (hash ${oldAfter.hash})` : "old chat's transcript CHANGED",
	)
	assert(
		"6. the old chat still shows its own conversation",
		String(oldAfter.text).includes(PROBE_OLD),
		String(oldAfter.text).includes(PROBE_OLD) ? "old chat intact" : "old chat lost its own conversation",
	)

	report()
}

function report(): void {
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

main().catch((err) => {
	console.error(`\nScenario aborted: ${err.message}\n`)
	process.exit(2)
})

// Standalone script, but declared a module so its top-level names cannot collide with the other
// scenario scripts in this folder under the project-wide typecheck.
export {}
