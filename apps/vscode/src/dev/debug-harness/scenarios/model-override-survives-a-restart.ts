/**
 * Cline Cubed — a chosen model id and its model configuration survive the settings UI and a restart.
 *
 * The defect this exists to catch, in stock Cline (upstream from this fork): on a provider whose models
 * come from an endpoint rather than a catalog, picking the model and editing its Model Configuration
 * (Context Window Size, Max Output Tokens, Supports Images) could persist nothing. A settings read that
 * reported no selection for the mode replaced the model id the settings panel was holding, so the next
 * edit had no model id to attach to and was discarded — while the fields kept displaying the values that
 * had just been thrown away. A selection commit carrying an empty model id then wrote that empty id over
 * the stored one, in both durable homes. The fork refuses that commit now.
 *
 * The values are a real configuration, not invented ones: an OpenAI-compatible endpoint serving a
 * model no catalog lists, that model's id typed in, and that model's numbers.
 *
 * WHAT THIS DOES NOT DO: it runs no inference and needs no credential. The defect is a settings
 * persistence defect, so every gesture here is a settings gesture, and the assertions read what the
 * settings panel displays and what the two durable files hold. Nothing is sent to any model and no
 * API key is read. The base URL is typed because the field is part of the path under test, not
 * because anything is expected to answer it.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node --experimental-strip-types src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/model-override-survives-a-restart.ts
 *
 * Exit code 0 = all assertions passed, 1 = an assertion failed, 2 = the scenario could not run.
 * A gesture the harness cannot perform aborts (2) rather than being reported as a product failure.
 */

import { readFileSync } from "node:fs"
import path from "node:path"

import { api, assert, frameOf, freshApp, openChat, reloadWindow, report, run, sleep } from "./harness"

// ── The configuration under test ─────────────────────────────────────────────────────────────────
// A host under a reserved TLD that can never resolve: the model-configuration fields under test are
// the ones that render when an endpoint lists nothing, and a host that could answer would swap them
// for a picker. The value is arbitrary on purpose — nothing here is expected to be reachable.
const BASE_URL = "http://model-endpoint.invalid:8080/v1"
const MODEL_ID = "qwen3.8-flash-next-iq3_xxs"
const CONTEXT_WINDOW = "262144"
const MAX_OUTPUT = "32768"

// ── Selectors, each one from the component that renders it ──────────────────────────────────────
const SETTINGS_BUTTON = '[data-testid="settings-button"]' // ChatTextArea
const API_CONFIG_TAB = '[data-testid="tab-api-config"]' // SettingsView's TabTrigger
const PROVIDER_INPUT = '[data-testid="provider-selector-input"] input' // ApiOptions' search field
const PROVIDER_OPTION_ID = "provider-option-openai-compatible" // its listbox item
const BASE_URL_INPUT = 'input[placeholder="Enter base URL..."]' // OpenAICompatible's DebouncedTextField
const MODEL_ID_INPUT = 'input[placeholder="Enter Model ID..."]' // the custom-model-id field
const MODEL_CONFIG_TOGGLE = 'span:text-is("Model Configuration")'
const SUPPORTS_IMAGES = 'vscode-checkbox:has-text("Supports Images")'
const DONE_BUTTON = 'button:has-text("Done"), vscode-button:has-text("Done")'

const fieldText = (label: string) => `vscode-text-field:has-text(${JSON.stringify(label)}) input`

/**
 * The settings fields are not read out of the DOM here, and that is a harness limit, not a shortcut.
 *
 * A DOM read needs the frame the panel lives in, and `web.evaluate` takes none: it resolves the first
 * frame titled "Cline", which with the chats list open is the chats list. Reads through it came back
 * empty for a settings panel that was plainly open, on a run whose values were stored correctly — a
 * check that can fail on the harness is not a check, and a green that depends on which frame a lookup
 * happened to pick is worse. What is read instead is what the panel prints for the model, aimed at the
 * same frame every click is aimed at, plus the two durable files. If `web.evaluate` gains a `frame`
 * param, the field-level read belongs back here.
 */

/** The debugee's own durable records — the second witness, independent of any frame. */
function readDurable(clineDir: string): { providers: any; models: any } {
	const settingsDir = path.join(clineDir, "data", "settings")
	const load = (name: string): any => {
		try {
			return JSON.parse(readFileSync(path.join(settingsDir, name), "utf8"))
		} catch {
			return undefined
		}
	}
	return { providers: load("providers.json"), models: load("models.json") }
}

function providerSection(file: any): any {
	if (!file) return undefined
	return file.providers?.["openai-compatible"] ?? file["openai-compatible"]
}

function storedModelId(clineDir: string): string | undefined {
	return providerSection(readDurable(clineDir).providers)?.settings?.model
}

function storedOverrides(clineDir: string): any {
	return providerSection(readDurable(clineDir).models)?.models?.[MODEL_ID]
}

/** A model-configuration edit that lost the model id lands under the empty string. */
function orphanedOverrides(clineDir: string): any {
	return providerSection(readDurable(clineDir).models)?.models?.[""]
}

async function clickIn(frame: string, selector: string, why: string): Promise<void> {
	try {
		await api("ui.wait_for_selector", { selector, frame, timeout: 15000 })
		await api("ui.click", { selector, frame, timeout: 8000 })
	} catch (e: any) {
		throw new Error(`Harness could not ${why} (${selector}): ${e.message}`)
	}
}

async function typeIn(frame: string, selector: string, text: string, why: string): Promise<void> {
	try {
		await api("ui.wait_for_selector", { selector, frame, timeout: 15000 })
		// fill, not react_input. These fields live inside the toolkit's shadow roots, and
		// react_input resolves its target with a plain querySelector inside frame.evaluate — which
		// does not pierce a shadow root and reports "Element not found" for a field that is plainly
		// on screen. Playwright's fill does pierce, and it dispatches the input event the debounced
		// field listens for. react_input stays as the fallback for a field fill cannot reach.
		await api("ui.fill", { selector, text, frame })
	} catch (e: any) {
		try {
			await api("ui.react_input", { selector, text, frame })
		} catch {
			throw new Error(`Harness could not ${why} (${selector}): ${e.message}`)
		}
	}
}

/**
 * Put the panel on the OpenAI Compatible provider by clicking it.
 *
 * The picker is a search field that opens a listbox on focus, so the option is not in the DOM until
 * the field is focused — and it is filtered by what is typed. Both are attempted; the panel is then
 * believed by what it renders rather than by the click that was meant to produce it: the base URL
 * field exists only on the OpenAI-compatible family of providers.
 */
async function chooseOpenAiCompatibleProvider(frame: string): Promise<boolean> {
	await api("ui.click", { selector: PROVIDER_INPUT, frame, timeout: 8000 }).catch(() => {})
	await sleep(900)
	let found = await api("ui.locator", { frame, testId: PROVIDER_OPTION_ID, action: "count" }).catch(() => ({ count: 0 }))
	if (!found?.count) {
		await api("ui.fill", { selector: PROVIDER_INPUT, text: "OpenAI Compatible", frame }).catch(() => {})
		await sleep(900)
		found = await api("ui.locator", { frame, testId: PROVIDER_OPTION_ID, action: "count" }).catch(() => ({ count: 0 }))
	}
	if (!found?.count) {
		return false
	}
	await api("ui.locator", { frame, testId: PROVIDER_OPTION_ID, action: "click" }).catch(() => {})
	await sleep(1500)
	return true
}

/**
 * Clear the update notice that a fresh profile opens with.
 *
 * On a debugee profile that has never run this build, the What's New modal is up before the first
 * gesture, and its backdrop swallows every click behind it — the settings button is visible, enabled
 * and stable and still cannot be clicked. Dismissing it is a precondition of the run, not something
 * the assertions are about. It is reported as an abort if it will not clear, because a scenario that
 * clicked through a modal it never closed would report on gestures that never happened.
 */
async function clearBlockingModal(frame: string): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const open = await api("ui.locator", { frame, role: "dialog", action: "count" }).catch(() => ({ count: 0 }))
		if (!open?.count) {
			return
		}
		await api("ui.locator", { frame, role: "button", name: "Close", action: "click" }).catch(() => undefined)
		await sleep(700)
	}
	const remaining = await api("ui.locator", { frame, role: "dialog", action: "count" }).catch(() => ({ count: 0 }))
	if (remaining?.count) {
		throw new Error("The update notice would not close, so every click in this run would hit its backdrop.")
	}
}

/**
 * Whether the Model Configuration fields are on screen, and what the panel resolves for context.
 *
 * Both go through the frame the chat lives in, and that is the whole point. `web.evaluate` takes no
 * frame: its sidebar lookup returns the first frame titled "Cline", and with the chats list open
 * that is the chats list rather than the chat — a read through it comes back empty for a settings
 * panel that is plainly open. So the panel is read through the same frame every click is aimed at.
 * The model line the settings page prints ("Context: 262K") is the stronger witness of the two
 * anyway: it is the number the model is actually being used with, not the number sitting in a box.
 */
async function revealModelConfiguration(frame: string): Promise<boolean> {
	const shown = await api("ui.locator", { frame, role: "checkbox", name: "Supports Images", action: "count" }).catch(() => ({
		count: 0,
	}))
	if (shown?.count) {
		return true
	}
	// The section renders collapsed on a fresh load, so the numeric fields are not in the DOM at all
	// until the header is clicked. A read that expects them before that reports absence, not loss.
	await api("ui.click", { selector: MODEL_CONFIG_TOGGLE, frame, timeout: 8000 }).catch(() => {})
	await sleep(900)
	const again = await api("ui.locator", { frame, role: "checkbox", name: "Supports Images", action: "count" }).catch(() => ({
		count: 0,
	}))
	return Boolean(again?.count)
}

/** An input's content is its `value`. `ui.get_text` reads textContent, which is empty for every text
 *  field on screen — a read through it reports "the field lost its value" about fields that never had
 *  one, on every build. `ui.locator` gained `selector` and a `value` action (Playwright's inputValue)
 *  for exactly this: the field is addressed by the same CSS the click uses, inside the shadow root.
 *  null means the field could not be addressed at all, which is a harness fact, not a product verdict. */
async function fieldValue(frame: string, selector: string): Promise<string | null> {
	try {
		const res = await api("ui.locator", { frame, selector, action: "value" })
		return typeof res?.value === "string" ? res.value : null
	} catch {
		return null
	}
}

async function contextShown(frame: string): Promise<string | null> {
	try {
		const res = await api("ui.get_text", { frame, selector: 'span:has-text("Context:") + span' })
		return String(res?.text ?? res ?? "").trim() || null
	} catch {
		return null
	}
}

/** The panel prints 262144 as "262K". Either spelling of the typed number is a pass; the catalog's
 *  own figure for this model (128000) is not. */
function contextMatches(shown: string | null): boolean {
	const digits = (shown ?? "").replace(/\D/g, "")
	return digits === "262144" || digits === "262"
}

async function main(): Promise<void> {
	console.log(`\nCline Cubed — a model id and its model configuration survive a restart\nmodel: ${MODEL_ID}\n`)

	// The provider is seeded to OpenAI Compatible so the panel opens on the screen under test. The
	// model id and every override are then entered through the UI — the path that was losing them.
	await freshApp({ actModeApiProvider: "openai-compatible", planModeApiProvider: "openai-compatible" })
	const status = await api("status")
	const clineDir = String(status.clineDir ?? "")
	if (!clineDir) throw new Error("Harness status reported no clineDir")
	console.log(`debugee profile: ${clineDir}`)

	const surface = await openChat("settings chat")
	const frame = frameOf(surface)
	await clearBlockingModal(frame)

	// ── 1. Settings → API Configuration, on the provider's own screen ───────────────────────────
	await clickIn(frame, SETTINGS_BUTTON, "open Settings")
	await sleep(1200)
	await clickIn(frame, API_CONFIG_TAB, "open the API Configuration tab")
	await sleep(1200)

	// The provider is clicked even though it was seeded: switching providers is part of the path, and
	// the switch is one of the moments a stored selection gets re-resolved.
	const picked = await chooseOpenAiCompatibleProvider(frame)
	console.log(`provider picked by click: ${picked}`)

	// ── 2. Base URL, then the model id typed in by hand ─────────────────────────────────────────
	await typeIn(frame, BASE_URL_INPUT, BASE_URL, "type the base URL")
	await sleep(2500) // let the model-list fetch settle, or fail, before reading what rendered

	const comboboxes = await api("ui.locator", { frame, role: "combobox", name: "Model ID", action: "count" }).catch(() => ({
		count: 0,
	}))
	let hasModelField = true
	try {
		await api("ui.wait_for_selector", { selector: MODEL_ID_INPUT, frame, timeout: 3000 })
	} catch {
		hasModelField = false
	}
	if (!hasModelField && comboboxes?.count) {
		throw new Error(
			"The endpoint's model list rendered, so the model id has to come from a <select>. The " +
				"harness exposes no selectOption, and clicking a native option is not a gesture worth " +
				"faking. Use a base URL that lists nothing, or add a select action to ui.locator.",
		)
	}
	await typeIn(frame, MODEL_ID_INPUT, MODEL_ID, "type the custom model id")

	// The pause is the point, not padding. In a real session a model selection is followed by the
	// endpoint's model list arriving and by a moment before the next field is touched. On the unfixed
	// code a list that could not name the custom id answered "no selection for this mode", and that
	// answer replaced the model id the panel was holding — so a value typed next had nothing to attach
	// to. Typing the overrides a second after the model id skips that window, which is why this
	// scenario must not skip it either.
	await sleep(Number(process.env.MODEL_DWELL_MS ?? 3500))
	const fieldAfterList = await fieldValue(frame, MODEL_ID_INPUT)
	const storedAfterList = storedModelId(clineDir)
	console.log(
		`after the list lands — field: ${JSON.stringify(fieldAfterList)}, providers.json: ${JSON.stringify(storedAfterList)}`,
	)
	// Asserted where it is observed: a failure in a later step must not bury this one. A null field is
	// the harness failing to address the field, which is not a verdict about the product, so it aborts
	// rather than being reported as a failure.
	if (fieldAfterList === null) {
		throw new Error("Could not read the Model ID field's value through any role — harness targeting, not a product result.")
	}
	assert(
		"the Model ID field kept the id typed while the endpoint's model list landed",
		fieldAfterList === MODEL_ID,
		`the field held ${JSON.stringify(fieldAfterList)} after the provider-config read that follows the list`,
	)
	assert(
		"the stored model id survived that same read",
		storedAfterList === MODEL_ID,
		`providers.json held ${JSON.stringify(storedAfterList)} at that moment`,
	)

	// ── 3. Model Configuration: the checkbox and the two numbers ────────────────────────────────
	const expanded = await revealModelConfiguration(frame)
	console.log(`model configuration open: ${expanded}`)
	await api("ui.click", { selector: SUPPORTS_IMAGES, frame, timeout: 8000 }).catch(() => {})
	await typeIn(frame, fieldText("Context Window Size"), CONTEXT_WINDOW, "type Context Window Size")
	await typeIn(frame, fieldText("Max Output Tokens"), MAX_OUTPUT, "type Max Output Tokens")
	await sleep(2500) // the debounces, and the commit round-trip

	// ── 4. Done, then reopen — the gesture a user actually makes ────────────────────────────────
	await clickIn(frame, DONE_BUTTON, "press Done")
	await sleep(1500)
	await clickIn(frame, SETTINGS_BUTTON, "reopen Settings")
	await sleep(1500)
	await clickIn(frame, API_CONFIG_TAB, "reopen the API Configuration tab")
	await sleep(1500)
	const expandedAfterReopen = await revealModelConfiguration(frame)
	const contextAfterReopen = await contextShown(frame)
	const contextFieldAfterReopen = await fieldValue(frame, fieldText("Context Window Size"))
	const maxFieldAfterReopen = await fieldValue(frame, fieldText("Max Output Tokens"))
	assert(
		"the reopened panel still resolves the context window typed",
		contextMatches(contextAfterReopen),
		`the model line shows ${JSON.stringify(contextAfterReopen)}; configuration open: ${expandedAfterReopen}`,
	)
	assert(
		"the reopened panel still displays the numbers typed, in its own fields",
		contextFieldAfterReopen === CONTEXT_WINDOW && maxFieldAfterReopen === MAX_OUTPUT,
		`context field ${JSON.stringify(contextFieldAfterReopen)}, max output field ${JSON.stringify(maxFieldAfterReopen)}`,
	)

	const stored = storedOverrides(clineDir)
	assert(
		"the overrides are attached to the model id typed, not to nothing",
		stored?.contextWindow === Number(CONTEXT_WINDOW) && stored?.maxTokens === Number(MAX_OUTPUT),
		`entry under ${MODEL_ID} = ${JSON.stringify(stored)}`,
	)
	assert(
		"the Supports Images override is attached to that same model id",
		stored?.supportsVision === true,
		`entry = ${JSON.stringify(stored)}`,
	)

	// ── 5. The durable records, where a lost selection actually shows up ─────────────────────────
	assert(
		"providers.json holds the chosen model id, and not an empty one",
		storedModelId(clineDir) === MODEL_ID,
		`settings.model = ${JSON.stringify(storedModelId(clineDir))}; section = ${JSON.stringify(providerSection(readDurable(clineDir).providers))?.slice(0, 300)}`,
	)
	assert(
		"models.json holds the overrides under the chosen model id",
		storedOverrides(clineDir)?.contextWindow === Number(CONTEXT_WINDOW) &&
			storedOverrides(clineDir)?.maxTokens === Number(MAX_OUTPUT),
		`entry = ${JSON.stringify(storedOverrides(clineDir))}`,
	)
	assert(
		"no model-configuration value landed under an empty model id",
		orphanedOverrides(clineDir) === undefined,
		`models.json carries an entry under the empty string: ${JSON.stringify(orphanedOverrides(clineDir))}`,
	)

	// ── 6. A restart: the in-memory selection is gone, only the files remain ─────────────────────
	// The reload is the one step that can fail for reasons that say nothing about the product — the
	// debug inspector occasionally does not answer on its port in time. A scenario that dies here says
	// nothing about the restart at all, so it gets retried before it is allowed to abort.
	for (let attempt = 1; ; attempt++) {
		try {
			await reloadWindow()
			break
		} catch (error) {
			if (attempt >= 3) throw error
			console.log(`reload did not reconnect (${String(error).slice(0, 80)}); retrying (${attempt}/3)`)
			await sleep(10000)
		}
	}
	await sleep(4000)
	await api("ui.open_sidebar").catch(() => {})
	const frames = await api("ui.frames")
	const reopened = Array.isArray(frames?.surfaceIds) && frames.surfaceIds.length > 0 ? String(frames.surfaceIds[0]) : surface
	const afterFrame = frameOf(reopened)
	await clearBlockingModal(afterFrame)
	await clickIn(afterFrame, SETTINGS_BUTTON, "open Settings after the restart")
	await sleep(1500)
	await clickIn(afterFrame, API_CONFIG_TAB, "open the API Configuration tab after the restart")
	await sleep(1500)
	const openedAfterRestart = await revealModelConfiguration(afterFrame)
	const keptContext = await contextShown(afterFrame)
	const modelFieldAfterRestart = await fieldValue(afterFrame, MODEL_ID_INPUT)
	assert(
		"the panel after the restart still resolves the context window typed",
		contextMatches(keptContext),
		`the model line shows ${JSON.stringify(keptContext)}; configuration open: ${openedAfterRestart}`,
	)
	assert(
		"the Model ID field after the restart holds the id typed",
		modelFieldAfterRestart === MODEL_ID,
		`the field holds ${JSON.stringify(modelFieldAfterRestart)}`,
	)
	assert(
		"the Model Configuration fields are reachable after the restart",
		openedAfterRestart,
		"the checkbox the section renders when open was found after expanding it",
	)
	assert(
		"the durable records still name the chosen model after the restart",
		storedModelId(clineDir) === MODEL_ID && storedOverrides(clineDir)?.contextWindow === Number(CONTEXT_WINDOW),
		`settings.model = ${JSON.stringify(storedModelId(clineDir))}, entry = ${JSON.stringify(storedOverrides(clineDir))}`,
	)
	report()
}

run(main)
