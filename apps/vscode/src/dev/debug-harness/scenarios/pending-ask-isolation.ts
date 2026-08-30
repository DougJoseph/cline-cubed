/**
 * Cline Cubed — a chat parked on a question stays its own.
 *
 * A chat that has asked the user something is waiting on an answer. That wait belongs to THAT
 * chat: no other chat's typing may answer it, opening some other chat may not answer it, and it
 * must still be answerable from the chat that asked, whatever else happened in between.
 *
 * This is the state a real provider cannot be made to produce on cue, which is why it went
 * untested end to end for so long. The scripted stub emits the ask tool on demand, so the chat
 * parks exactly when the scenario says so and stays parked until it is answered.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/pending-ask-isolation.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 */

import {
	assert,
	assertHoldsOnly,
	freshApp,
	MARKERS,
	openChat,
	report,
	run,
	STUB_OPTIONS,
	STUB_QUESTION,
	sendInto,
	transcriptOf,
	waitForQuiet,
	waitForText,
} from "./harness"

const RUN_ID = Date.now()
/** Probes chosen so none is a substring of another — an isolation check is `includes()`. */
const ASKER_PROBE = `ASKER-${RUN_ID} ${MARKERS.ask}`
const ASKER_MARK = `ASKER-${RUN_ID}`
const OTHER_PROBE = `OTHER-${RUN_ID}`
const ANSWER_TEXT = `ANSWER-${RUN_ID}`

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a chat parked on a question stays its own\nrun: ${RUN_ID}\n`)
	await freshApp()

	// ── Chat A asks a question and parks. ───────────────────────────────────────────────────
	const asker = await openChat("asker chat")
	await sendInto(asker, ASKER_PROBE)
	const parked = await waitForText(asker, STUB_QUESTION, 30000)
	assert(
		"1. the asking chat displays its question and parks",
		parked,
		parked ? `showing "${STUB_QUESTION}"` : "the question never appeared — the chat did not park",
	)
	if (!parked) {
		return report()
	}

	// ── Chat B: a second chat, typed into while A is still waiting. ─────────────────────────
	const other = await openChat("other chat")
	await sendInto(other, OTHER_PROBE)
	const otherArrived = await waitForText(other, OTHER_PROBE)
	assert(
		"2. the second chat's message appears in the second chat",
		otherArrived,
		otherArrived ? "found, as it should be" : "NOT found in the chat it was typed into",
	)
	await waitForQuiet(other)

	const askerAfterOther = await transcriptOf(asker)
	assert(
		"3. the parked chat is STILL parked on its question after another chat was used",
		askerAfterOther.text.includes(STUB_QUESTION),
		askerAfterOther.text.includes(STUB_QUESTION)
			? "still showing its question"
			: "the question is gone — something answered or cleared it",
	)
	assertHoldsOnly("4. the parked chat", askerAfterOther, ASKER_MARK, [{ probe: OTHER_PROBE, owner: "the second chat" }])

	// ── Opening a THIRD chat must not answer anyone's question. ─────────────────────────────
	const bystander = await openChat("bystander chat")
	await waitForQuiet(asker)
	const askerAfterOpen = await transcriptOf(asker)
	assert(
		"5. merely OPENING another chat did not answer the parked question",
		askerAfterOpen.text.includes(STUB_QUESTION),
		askerAfterOpen.text.includes(STUB_QUESTION)
			? "still parked, as it should be"
			: "the question was answered or cleared by opening an unrelated chat",
	)
	assert(
		"6. the newly opened chat holds no other chat's conversation",
		bystander !== asker && bystander !== other,
		`bystander=${bystander}`,
	)

	// ── The answer must still be deliverable from the chat that asked. ──────────────────────
	// Typed rather than clicked: an option button and a typed reply take different paths in, and
	// typing is the one a person reaches for when the options do not fit.
	await sendInto(asker, ANSWER_TEXT)
	const answered = await waitForText(asker, ANSWER_TEXT, 30000)
	assert(
		"7. the parked chat still accepts its answer, in its own chat",
		answered,
		answered ? "the answer landed in the asking chat" : "the answer never reached the asking chat",
	)

	await waitForQuiet(asker)
	await waitForQuiet(other)
	const otherFinal = await transcriptOf(other)
	assertHoldsOnly("8. the second chat", otherFinal, OTHER_PROBE, [
		{ probe: ANSWER_TEXT, owner: "the asking chat" },
		{ probe: ASKER_MARK, owner: "the asking chat" },
	])
	assert(
		"10. the second chat was never shown the other chat's question",
		!otherFinal.text.includes(STUB_QUESTION),
		otherFinal.text.includes(STUB_QUESTION) ? "it is displaying the asking chat's question" : "absent, as it should be",
	)
	// The options belong to the asking chat's prompt; seeing them elsewhere is the same fault
	// wearing different clothes.
	assert(
		"11. the second chat was never shown the question's options",
		!STUB_OPTIONS.some((o) => otherFinal.text.includes(o)),
		STUB_OPTIONS.some((o) => otherFinal.text.includes(o)) ? "it is displaying the question's options" : "absent",
	)

	report()
}

run(main)
