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
/** Surface #1's own seed message. MUST NOT contain PROBE as a substring — the isolation check is
 *  `text.includes(PROBE)`, and a seed built as `SEED-${PROBE}` matched its own conversation
 *  (a false failure). */
const SEED_TEXT = PROBE.replace("PROBE", "SEED")

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
	console.log(`\nCline Cubed — side-by-side chat sessions\nprobe: ${PROBE}\n`)

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

	// ── Open TWO chat surfaces in the editor area. (On VS Code builds where the secondary
	// container is unavailable, so both chats live in editor tabs.) ─────────────────────────
	const before = await chatSurfaceCount()
	console.log(`chat surfaces open before: ${before}`)
	await api("ui.command_palette", { command: "Cline Cubed: New Chat" })
	await sleep(2500)
	if ((await chatSurfaceCount()) < 2) {
		await api("ui.command_palette", { command: "Cline Cubed: New Chat" })
		await sleep(2500)
	}
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

	// ── Give surface #1 its OWN conversation first. A surface left on the New Chat home
	// renders the RECENT list, which by design shows every new chat's title — so a probe sent
	// from another chat legitimately appears there and the isolation assertions below would
	// misread the recent list as a failure. ────────────────────────────────────────────────
	await api("ui.react_input", { frame: "surface:0", text: SEED_TEXT, clear: true })
	await sleep(400)
	await api("ui.react_input", { frame: "surface:0", text: "", clear: false, submit: true })
	await waitForStableTranscript("surface:0")
	await sleep(6000)
	await waitForStableTranscript("surface:0")

	// URL order is not open order — resolve which surface actually holds the seed, and use
	// the OTHER one for the probe.
	const seedIdx = await surfaceContaining(SEED_TEXT, after)
	if (seedIdx === -1) {
		console.log("Seed conversation not found in any surface — aborting.")
		return report()
	}
	const probeIdx = seedIdx === 0 ? 1 : 0
	const seedFrame = `surface:${seedIdx}`
	const probeFrame = `surface:${probeIdx}`
	console.log(`seed chat = ${seedFrame}, probe chat = ${probeFrame}`)

	// ── Snapshot the seeded chat BEFORE touching the other one. ─────────────────────────────
	const s0Before = await api("ui.transcript", { frame: seedFrame })
	console.log(`${seedFrame} transcript before — ${s0Before.length} chars, hash ${s0Before.hash}`)

	// ── Send a uniquely-identifiable message into the OTHER chat ONLY. ──────────────────────
	await api("ui.react_input", { frame: probeFrame, text: PROBE, clear: true })
	await sleep(400)
	await api("ui.react_input", { frame: probeFrame, text: "", clear: false, submit: true })
	console.log(`sent probe into ${probeFrame}\n`)

	// Give the host time to broadcast. The defect shows up immediately; a real fix must still
	// hold after the stream starts, so wait until surface:1 settles.
	await sleep(6000)
	await waitForStableTranscript(probeFrame)

	// ── Assertions. Let the seeded chat settle again first: its OWN turn can still be
	// finishing (cost counters, error rows), and a late self-update is not a mutation caused
	// by the other chat. ───────────────────────────────────────────────────────────────────
	await waitForStableTranscript(seedFrame)
	const s0After = await api("ui.transcript", { frame: seedFrame })
	const s1After = await api("ui.transcript", { frame: probeFrame })

	assert(
		`1. the probe appears in ${probeFrame} (the chat it was typed into)`,
		String(s1After.text).includes(PROBE),
		String(s1After.text).includes(PROBE)
			? "found, as it should be"
			: "NOT found — the message did not reach the chat it was typed into",
	)

	assert(
		`2. the probe does NOT appear in ${seedFrame}`,
		!String(s0After.text).includes(PROBE),
		String(s0After.text).includes(PROBE) ? "the seeded chat is showing the probe chat's message" : "absent, as it should be",
	)

	const beforeText = String(s0Before.text ?? "")
	const afterText = String(s0After.text ?? "")
	let firstDiff = -1
	for (let i = 0; i < Math.max(beforeText.length, afterText.length); i++) {
		if (beforeText[i] !== afterText[i]) {
			firstDiff = i
			break
		}
	}
	assert(
		`3. the seeded chat's transcript is unchanged`,
		s0Before.hash === s0After.hash,
		s0Before.hash === s0After.hash
			? `unchanged (hash ${s0After.hash})`
			: `CHANGED: ${s0Before.length} → ${s0After.length} chars; first difference at ${firstDiff}: ` +
					`before ${JSON.stringify(beforeText.slice(Math.max(0, firstDiff - 20), firstDiff + 40))} / ` +
					`after ${JSON.stringify(afterText.slice(Math.max(0, firstDiff - 20), firstDiff + 40))}`,
	)

	// ── surface:0 must still be usable afterwards (no zombie webview). ──────────────────────
	let inputWorks = false
	try {
		const typed = await api("ui.react_input", { frame: seedFrame, text: `${PROBE}-typing`, clear: true })
		inputWorks = String(typed.value ?? "").includes(PROBE)
		await api("ui.react_input", { frame: seedFrame, text: "", clear: true }).catch(() => {})
	} catch (e) {
		inputWorks = false
	}
	assert(
		`4. the seeded chat still accepts input (no zombie webview)`,
		inputWorks,
		inputWorks ? "input accepted" : "could not type into the seeded chat after the other chat was used",
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
