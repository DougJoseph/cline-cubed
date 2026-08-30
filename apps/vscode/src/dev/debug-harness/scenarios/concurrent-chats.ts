/**
 * Cline Cubed — side-by-side chat sessions.
 *
 * Verifies the core guarantee of multiple chats running at once: a message sent to one chat goes
 * to that chat and no other, and the other chats keep their own conversations and stay usable.
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

import {
	assert,
	assertHoldsOnly,
	freshApp,
	openChat,
	report,
	run,
	sendInto,
	sleep,
	transcriptOf,
	typeInto,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
/** Markers that cannot collide with anything else on screen — and, critically, not with each
 *  other: an isolation check is `text.includes(probe)`, so one probe must never be a substring of
 *  another or a chat matches its own conversation and reports a false failure. */
const SEED = `SEED-${RUN_ID}`
const PROBE = `PROBE-${RUN_ID}`

async function main(): Promise<void> {
	console.log(`\nCline Cubed — side-by-side chat sessions\nrun: ${RUN_ID}\n`)
	await freshApp()

	// Two chats, each held by its own surface id from the moment it opens.
	const seedChat = await openChat("seed chat")
	const probeChat = await openChat("probe chat")
	assert("two chat surfaces can be open at once", seedChat !== probeChat, `seed=${seedChat}, probe=${probeChat}`)

	// Give the seed chat its OWN conversation first. A chat left on the New Chat home renders the
	// RECENT list, which by design shows every chat's title — so a probe sent from another chat
	// legitimately appears there, and the isolation checks below would misread that list as a
	// failure.
	await sendInto(seedChat, SEED)
	if (!(await waitForText(seedChat, SEED))) {
		console.log("The seed chat never displayed its own message — aborting.")
		return report()
	}
	await waitForQuiet(seedChat)
	const seedBefore = await transcriptOf(seedChat)
	console.log(`seed chat before — ${seedBefore.length} chars, hash ${seedBefore.hash}`)

	// The probe goes into the OTHER chat only.
	await sendInto(probeChat, PROBE)
	const arrived = await waitForText(probeChat, PROBE)
	assert(
		"1. the probe appears in the chat it was typed into",
		arrived,
		arrived ? "found, as it should be" : "NOT found — the message did not reach the chat it was typed into",
	)

	// Let both chats stop moving before reading them: a chat's own turn can still be finishing,
	// and a late self-update is not a mutation caused by the other chat.
	await waitForQuiet(probeChat)
	await waitForQuiet(seedChat)
	const seedAfter = await transcriptOf(seedChat)
	const probeAfter = await transcriptOf(probeChat)

	// 2–5: the content checks that decide isolation, in both directions.
	assertHoldsOnly("2. the seed chat", seedAfter, SEED, [{ probe: PROBE, owner: "the probe chat" }])
	assertHoldsOnly("4. the probe chat", probeAfter, PROBE, [{ probe: SEED, owner: "the seed chat" }])

	// Secondary signal only — reported, never decisive. Any late self-update (a cost counter, a
	// status row) moves the hash without anything being wrong, so a difference here is printed
	// with its first-difference position for a human to judge, not asserted on.
	if (seedBefore.hash !== seedAfter.hash) {
		let firstDiff = -1
		for (let i = 0; i < Math.max(seedBefore.text.length, seedAfter.text.length); i++) {
			if (seedBefore.text[i] !== seedAfter.text[i]) {
				firstDiff = i
				break
			}
		}
		console.log(
			`  note  the seed chat's transcript moved on its own: ${seedBefore.length} → ${seedAfter.length} chars, ` +
				`first difference at ${firstDiff}: ` +
				`before ${JSON.stringify(seedBefore.text.slice(Math.max(0, firstDiff - 20), firstDiff + 40))} / ` +
				`after ${JSON.stringify(seedAfter.text.slice(Math.max(0, firstDiff - 20), firstDiff + 40))}\n` +
				`        Not a failure by itself — the content checks above are what decide isolation.`,
		)
	}

	// Neither chat's header may ever present bookkeeping as its name. Every turn opens with an
	// api_req_started row whose text is a JSON blob; if the header ever selects it as "the task",
	// the chat's displayed name becomes that blob — seen in the field as a name of "{}".
	for (const [label, t] of [
		["the seed chat", seedAfter],
		["the probe chat", probeAfter],
	] as const) {
		const blobbed = t.text.split("\n").some((line) => line.trim() === "{}")
		assert(
			`5. ${label} never shows a JSON blob as its name`,
			!blobbed,
			blobbed ? "a line of the transcript is exactly {}" : "no bookkeeping text presented as a name",
		)
	}

	// The seed chat must still be usable afterwards (no zombie webview).
	let inputWorks = false
	try {
		inputWorks = (await typeInto(seedChat, `${SEED}-typing`)).includes(SEED)
		await typeInto(seedChat, "").catch(() => "")
	} catch {
		inputWorks = false
	}
	assert(
		"6. the seed chat still accepts input (no zombie webview)",
		inputWorks,
		inputWorks ? "input accepted" : "could not type into the seed chat after the other chat was used",
	)

	await sleep(0)
	report()
}

run(main)
