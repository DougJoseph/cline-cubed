/**
 * Cline Cubed — side-by-side chat sessions regression scenario.
 *
 * Verifies the core guarantee of multiple chat sessions running side by side: a message sent to
 * one chat surface goes to that chat and no other, and the other open chats keep their own
 * conversations and stay usable.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/concurrent-chats.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

const API = process.env.HARNESS_API ?? "http://localhost:19229/api"

/** A marker that cannot collide with anything else on screen. */
const PROBE = `PROBE-${Date.now()}`

type ApiResult = Record<string, any>

async function api(method: string, params?: Record<string, unknown>): Promise<ApiResult> {
	const res = await fetch(API, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params ? { method, params } : { method }),
	})
	if (!res.ok) {
		throw new Error(`${method} → HTTP ${res.status}: ${await res.text()}`)
	}
	const body = (await res.json()) as ApiResult
	if (body?.error) {
		throw new Error(`${method} → ${body.error}`)
	}
	return body
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

async function main(): Promise<void> {
	console.log(`\nCline Cubed — side-by-side chat sessions\nprobe: ${PROBE}\n`)

	const status = await api("status")
	if (!status.running) {
		console.log("VSCode not running — launching…")
		await api("launch", { skipBuild: true })
		await sleep(3000)
	}

	await api("ui.open_sidebar")
	await dismissOverlays()
	await sleep(1000)

	// ── Open a SECOND chat surface in the editor area (Button 2). ───────────────────────────
	const before = await chatSurfaceCount()
	console.log(`chat surfaces open before: ${before}`)
	await api("ui.command_palette", { command: "cline.openChatInEditor" })
	await sleep(2500)
	const after = await chatSurfaceCount()
	console.log(`chat surfaces open after:  ${after}\n`)

	assert(
		"two chat surfaces can be open at once",
		after >= 2,
		`expected >= 2 chat webviews, found ${after}. If this fails the rest is meaningless — check that "Cline Cubed: Open Chat in Editor" ran.`,
	)
	if (after < 2) {
		return report()
	}

	// ── Snapshot surface #1 BEFORE touching surface #2. ─────────────────────────────────────
	const s0Before = await api("ui.transcript", { frame: "surface:0" })
	console.log(`surface:0 transcript before — ${s0Before.length} chars, hash ${s0Before.hash}`)

	// ── Send a uniquely-identifiable message into surface #2 ONLY. ──────────────────────────
	await api("ui.react_input", { frame: "surface:1", text: PROBE, clear: true })
	await sleep(400)
	await api("ui.react_input", { frame: "surface:1", text: "", clear: false, submit: true })
	console.log(`sent probe into surface:1\n`)

	// Give the host time to broadcast. The defect shows up immediately; a real fix must still
	// hold after the stream starts, so wait long enough to catch both.
	await sleep(6000)

	// ── Assertions. ─────────────────────────────────────────────────────────────────────────
	const s0After = await api("ui.transcript", { frame: "surface:0" })
	const s1After = await api("ui.transcript", { frame: "surface:1" })

	assert(
		"1. the probe appears in surface:1 (the chat it was typed into)",
		String(s1After.text).includes(PROBE),
		String(s1After.text).includes(PROBE)
			? "found, as it should be"
			: "NOT found — the message did not reach the chat it was typed into",
	)

	assert(
		"2. the probe does NOT appear in surface:0",
		!String(s0After.text).includes(PROBE),
		String(s0After.text).includes(PROBE) ? "surface:0 is showing surface:1's message" : "absent, as it should be",
	)

	assert(
		"3. surface:0's transcript is unchanged",
		s0Before.hash === s0After.hash,
		s0Before.hash === s0After.hash
			? `unchanged (hash ${s0After.hash})`
			: `CHANGED: ${s0Before.length} chars (hash ${s0Before.hash}) → ${s0After.length} chars (hash ${s0After.hash})`,
	)

	// ── surface:0 must still be usable afterwards (no zombie webview). ──────────────────────
	let inputWorks = false
	try {
		const typed = await api("ui.react_input", { frame: "surface:0", text: `${PROBE}-typing`, clear: true })
		inputWorks = String(typed.value ?? "").includes(PROBE)
		await api("ui.react_input", { frame: "surface:0", text: "", clear: true }).catch(() => {})
	} catch (e) {
		inputWorks = false
	}
	assert(
		"4. surface:0 still accepts input (no zombie webview)",
		inputWorks,
		inputWorks ? "input accepted" : "could not type into surface:0 after the other chat was used",
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
