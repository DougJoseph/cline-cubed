/**
 * Cline Cubed: model profiles. A profile is a named, complete model setup (provider, base URL,
 * model, context window, max output tokens, temperature, reasoning, image settings), saved from
 * what Settings holds for a mode and switched to in one action.
 *
 * Saving reads the same stores Settings writes: the provider entry in `providers.json`, the
 * model's overrides in `models.json` (temperature among them), and the mode's keys in the
 * extension's state. Switching writes every field back through the same paths Settings uses
 * (`writeProviderConfig`'s store write and `commitModelSelection`), so a profile carries its
 * own values and two profiles on one model keep their own temperatures. No key is ever copied:
 * a profile uses the key already saved for its provider.
 */
import type { ApiConfiguration } from "@shared/api"
import {
	MODEL_PROFILE_NAME_MAX_LENGTH,
	type ModelProfile,
	type ModelProfileActive,
	type ModelProfileImages,
	type ModelProfileOverrides,
	type ModelProfileReasoning,
} from "@shared/model-profiles"
import type { GlobalState, GlobalStateAndSettings, Settings } from "@shared/storage/state-keys"
import { commitModelSelection } from "@/core/controller/models/commitModelSelection"
import type { ProviderCatalogController } from "@/core/controller/models/providerCatalogShared"
import type { ProviderConfigPatch } from "@/sdk/model-catalog/contracts"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import { connectionChangesFromWrite } from "@/sdk/provider-connection-update"
import { getProviderSettingsManager } from "@/sdk/provider-migration"
import { CommitModelSelectionRequest } from "@/shared/proto/cline/models"
import { toProtobufModelOverrides } from "@/shared/proto-conversions/models/modelOverrides"
import { Logger } from "@/shared/services/Logger"

export type ProfileMode = "plan" | "act"

export interface ModelProfilesController extends ProviderCatalogController {
	stateManager: {
		setGlobalStateBatch(updates: Partial<GlobalStateAndSettings>): void
		flushPendingState?(): Promise<void>
		getApiConfiguration(): ApiConfiguration
		getGlobalStateKey<K extends keyof GlobalState>(key: K): GlobalState[K]
		getGlobalSettingsKey<K extends keyof Settings>(key: K): Settings[K]
	}
	handleApiConfigurationChanged?(previous: ApiConfiguration, next: ApiConfiguration): void
	/** Rebuilds the open chat's session from the stored setup (SdkController). */
	rebuildActiveSessionFromSettings?(): void
	postStateToWebview?(): Promise<void>
}

export interface ModelProfilesView {
	profiles: ModelProfile[]
	/** The profile last chosen or saved for the mode, "" for none. */
	activeName: string
	/** Whether the mode's setup has been changed by hand since that profile was chosen or saved. */
	activeEdited: boolean
}

/** One line naming what a profile holds, for the debug log. Never includes a key: a profile holds none. */
function describeProfile(profile: Omit<ModelProfile, "name" | "savedAt">): string {
	return `provider ${profile.providerId}, base URL ${profile.baseUrl ?? "(none)"}, model ${profile.modelId}, temperature ${profile.overrides?.temperature ?? "(default)"}, reasoning effort ${profile.reasoningEffort ?? "(none)"}`
}

export function parseProfileMode(raw: string | undefined): ProfileMode {
	if (raw === "plan" || raw === "act") return raw
	throw new Error('mode must be "plan" or "act"')
}

function readProfiles(controller: ModelProfilesController): ModelProfile[] {
	const stored = controller.stateManager.getGlobalStateKey("modelProfiles")
	return Array.isArray(stored) ? stored : []
}

function readActive(controller: ModelProfilesController): ModelProfileActive {
	const stored = controller.stateManager.getGlobalStateKey("modelProfileActive")
	return stored && typeof stored === "object" ? stored : {}
}

/** The modes a choice for `mode` reaches: one when Plan and Act use different models, both otherwise. */
function reachedModes(controller: ModelProfilesController, mode: ProfileMode): ProfileMode[] {
	return controller.stateManager.getGlobalSettingsKey("planActSeparateModelsSetting") ? [mode] : ["plan", "act"]
}

function normalizeName(raw: string | undefined): string {
	const name = (raw ?? "").trim()
	if (!name) throw new Error("A profile needs a name.")
	if (name.length > MODEL_PROFILE_NAME_MAX_LENGTH) {
		throw new Error(`A profile name can be at most ${MODEL_PROFILE_NAME_MAX_LENGTH} characters.`)
	}
	return name
}

function sameName(a: string, b: string): boolean {
	return a.toLowerCase() === b.toLowerCase()
}

function definedOnly<T extends object>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function readImages(controller: ModelProfilesController): ModelProfileImages {
	const settings = controller.stateManager
	return {
		imagesTotalLimitMb: settings.getGlobalSettingsKey("imagesTotalLimitMb"),
		imagesPerImageLimitMb: settings.getGlobalSettingsKey("imagesPerImageLimitMb"),
		imagesPerImageDecodedLimitMb: settings.getGlobalSettingsKey("imagesPerImageDecodedLimitMb"),
		imageDescriber: settings.getGlobalSettingsKey("imageDescriber"),
		earlierImages: settings.getGlobalSettingsKey("earlierImages"),
	}
}

function readProviderReasoning(providerId: string): ModelProfileReasoning | undefined {
	const settings = getProviderSettingsManager().getProviderSettings(toSdkProviderId(parseProviderId(providerId)))
	const reasoning = settings?.reasoning as Record<string, unknown> | undefined
	if (!reasoning || typeof reasoning !== "object") return undefined
	const captured = definedOnly<ModelProfileReasoning>({
		enabled: typeof reasoning.enabled === "boolean" ? reasoning.enabled : undefined,
		effort: typeof reasoning.effort === "string" ? reasoning.effort : undefined,
		budgetTokens: typeof reasoning.budgetTokens === "number" ? reasoning.budgetTokens : undefined,
	})
	return Object.keys(captured).length > 0 ? captured : undefined
}

/** Reads the mode's whole setup from the stores Settings writes, as a profile with no name yet. */
export function captureModelSetup(
	controller: ModelProfilesController,
	mode: ProfileMode,
): Omit<ModelProfile, "name" | "savedAt"> {
	const api = controller.stateManager.getApiConfiguration()
	const legacyProvider = mode === "plan" ? api.planModeApiProvider : api.actModeApiProvider
	if (!legacyProvider) throw new Error(`No provider is set for ${mode === "plan" ? "Plan" : "Act"} mode.`)
	const providerId = parseProviderId(legacyProvider)
	const store = controller.getProviderConfigStore()
	const config = store.read(providerId)
	const selection = store.readSelection(providerId, mode)
	const modelId = selection?.modelId?.trim()
	if (!modelId) throw new Error(`No model is selected for ${mode === "plan" ? "Plan" : "Act"} mode.`)
	const overrides = selection?.overrides
		? definedOnly<ModelProfileOverrides>({
				...selection.overrides,
				capabilities: selection.overrides.capabilities ? [...selection.overrides.capabilities] : undefined,
			})
		: undefined
	return definedOnly({
		providerId: providerId.toString(),
		baseUrl: config.baseUrl,
		providerContextWindow: config.contextWindow,
		reasoning: readProviderReasoning(providerId.toString()),
		modelId,
		overrides: overrides && Object.keys(overrides).length > 0 ? overrides : undefined,
		reasoningEffort: mode === "plan" ? api.planModeReasoningEffort : api.actModeReasoningEffort,
		thinkingBudgetTokens: mode === "plan" ? api.planModeThinkingBudgetTokens : api.actModeThinkingBudgetTokens,
		images: readImages(controller),
	})
}

/** A stable text form of a setup, for telling whether the mode still matches its profile. */
function setupKey(setup: Omit<ModelProfile, "name" | "savedAt">): string {
	const sortKeys = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(sortKeys)
		if (value && typeof value === "object") {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.filter(([, v]) => v !== undefined)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([k, v]) => [k, sortKeys(v)]),
			)
		}
		return value
	}
	const {
		providerId,
		baseUrl,
		providerContextWindow,
		reasoning,
		modelId,
		overrides,
		reasoningEffort,
		thinkingBudgetTokens,
		images,
	} = setup
	return JSON.stringify(
		sortKeys({
			providerId,
			baseUrl,
			providerContextWindow,
			reasoning,
			modelId,
			overrides,
			reasoningEffort,
			thinkingBudgetTokens,
			images,
		}),
	)
}

/**
 * The profiles, and which one the mode is on. A saved profile the mode's setup matches exactly is the
 * one named, whichever way the setup got there (a switch, or the same fields set by hand in Settings);
 * the one last chosen or saved wins when several match. When none matches, the last chosen or saved
 * profile is named as edited, so it can be saved again under its own name.
 */
export function listModelProfiles(controller: ModelProfilesController, mode: ProfileMode): ModelProfilesView {
	const profiles = readProfiles(controller)
	const active = readActive(controller)
	const activeName = active[mode] ?? ""
	const last = profiles.find((profile) => profile.name === activeName)
	let current: string | undefined
	try {
		current = setupKey(captureModelSetup(controller, mode))
	} catch {
		// No provider or model for the mode: it matches no profile.
	}
	if (current !== undefined) {
		const matching = profiles.filter((profile) => setupKey(profile) === current)
		const named = matching.find((profile) => profile.name === activeName) ?? matching[0]
		if (named) {
			if (named.name !== activeName) {
				// The mode is on this profile's setup now, so it is the active one from here on.
				controller.stateManager.setGlobalStateBatch({ modelProfileActive: { ...active, [mode]: named.name } })
			}
			return { profiles, activeName: named.name, activeEdited: false }
		}
	}
	if (!last) return { profiles, activeName: "", activeEdited: false }
	return { profiles, activeName, activeEdited: true }
}

/**
 * Saves the mode's current setup under `name`. A name already in use is replaced only when
 * `replace` is set; otherwise nothing is written and `nameExists` is returned.
 */
export async function saveModelProfile(
	controller: ModelProfilesController,
	rawName: string,
	mode: ProfileMode,
	replace: boolean,
): Promise<{ view: ModelProfilesView; nameExists: boolean }> {
	const name = normalizeName(rawName)
	const profiles = readProfiles(controller)
	const existing = profiles.findIndex((profile) => sameName(profile.name, name))
	if (existing >= 0 && !replace) {
		return { view: listModelProfiles(controller, mode), nameExists: true }
	}
	const profile: ModelProfile = { name, ...captureModelSetup(controller, mode), savedAt: Date.now() }
	Logger.debug(`[Profiles] save "${name}" (${mode}${existing >= 0 ? ", replacing" : ""}): ${describeProfile(profile)}`)
	const next = existing >= 0 ? profiles.map((p, i) => (i === existing ? profile : p)) : [...profiles, profile]
	const active = { ...readActive(controller) }
	const previousName = existing >= 0 ? profiles[existing].name : undefined
	for (const m of ["plan", "act"] as const) {
		if (previousName !== undefined && active[m] === previousName) active[m] = name
	}
	for (const m of reachedModes(controller, mode)) active[m] = name
	controller.stateManager.setGlobalStateBatch({ modelProfiles: next, modelProfileActive: active })
	await controller.stateManager.flushPendingState?.()
	return { view: listModelProfiles(controller, mode), nameExists: false }
}

/** Switches the mode (both modes, when Plan and Act share one model) to the named profile. */
export async function applyModelProfile(
	controller: ModelProfilesController,
	rawName: string,
	mode: ProfileMode,
): Promise<ModelProfilesView> {
	const name = normalizeName(rawName)
	const profile = readProfiles(controller).find((p) => p.name === name)
	if (!profile) throw new Error(`No profile is named "${name}".`)
	const previousApiConfiguration = controller.stateManager.getApiConfiguration()
	Logger.debug(
		`[Profiles] switch ${mode} to "${name}": ${describeProfile(profile)}; act provider before: ${previousApiConfiguration.actModeApiProvider}, plan provider before: ${previousApiConfiguration.planModeApiProvider}`,
	)
	const providerId = parseProviderId(profile.providerId)
	const store = controller.getProviderConfigStore()

	// Provider fields. Reasoning is cleared first, because a reasoning write merges onto what is
	// stored and would otherwise keep an effort the profile does not have.
	const before = store.read(providerId)
	store.write(providerId, { reasoning: null })
	const patch: ProviderConfigPatch = {
		baseUrl: profile.baseUrl ?? null,
		contextWindow: profile.providerContextWindow ?? null,
		...(profile.reasoning ? { reasoning: profile.reasoning } : {}),
	}
	const updated = store.write(providerId, patch)
	// A changed base URL reaches the chats already open on this provider, as a Settings save does.
	if ((before.baseUrl ?? "") !== (updated.baseUrl ?? "")) {
		const changes = connectionChangesFromWrite({ baseUrl: updated.baseUrl ?? "" }, updated)
		if (changes && controller.applyProviderConnectionChange) {
			await controller.applyProviderConnectionChange(profile.providerId, changes)
		}
	}

	// The model and its own settings, temperature among them, for each mode the choice reaches.
	// An empty overrides message clears what is stored, so the profile's values replace it exactly.
	const modes = reachedModes(controller, mode)
	for (const m of modes) {
		await commitModelSelection(
			controller,
			CommitModelSelectionRequest.create({
				providerId: profile.providerId,
				mode: m,
				modelId: profile.modelId,
				overrides: toProtobufModelOverrides(profile.overrides ?? {}),
			}),
		)
	}

	// The mode keys and the image settings.
	const updates: Partial<GlobalStateAndSettings> = {
		...profile.images,
		modelProfileActive: { ...readActive(controller), ...Object.fromEntries(modes.map((m) => [m, profile.name])) },
	}
	for (const m of modes) {
		if (m === "plan") {
			updates.planModeReasoningEffort = profile.reasoningEffort
			updates.planModeThinkingBudgetTokens = profile.thinkingBudgetTokens
		} else {
			updates.actModeReasoningEffort = profile.reasoningEffort
			updates.actModeThinkingBudgetTokens = profile.thinkingBudgetTokens
		}
	}
	controller.stateManager.setGlobalStateBatch(updates)
	await controller.stateManager.flushPendingState?.()
	controller.handleApiConfigurationChanged?.(previousApiConfiguration, controller.stateManager.getApiConfiguration())
	// The open chat takes the whole profile, not only its model (plan section 8).
	controller.rebuildActiveSessionFromSettings?.()
	await controller.postStateToWebview?.()
	const after = controller.stateManager.getApiConfiguration()
	Logger.debug(
		`[Profiles] switch to "${name}" done: act provider ${after.actModeApiProvider}, plan provider ${after.planModeApiProvider}`,
	)
	return listModelProfiles(controller, mode)
}

export async function renameModelProfile(
	controller: ModelProfilesController,
	rawOldName: string,
	rawNewName: string,
	mode: ProfileMode,
): Promise<{ view: ModelProfilesView; nameExists: boolean }> {
	const oldName = normalizeName(rawOldName)
	const newName = normalizeName(rawNewName)
	const profiles = readProfiles(controller)
	const index = profiles.findIndex((p) => p.name === oldName)
	if (index < 0) throw new Error(`No profile is named "${oldName}".`)
	if (profiles.some((p, i) => i !== index && sameName(p.name, newName))) {
		return { view: listModelProfiles(controller, mode), nameExists: true }
	}
	const next = profiles.map((p, i) => (i === index ? { ...p, name: newName } : p))
	const active = { ...readActive(controller) }
	for (const m of ["plan", "act"] as const) {
		if (active[m] === oldName) active[m] = newName
	}
	controller.stateManager.setGlobalStateBatch({ modelProfiles: next, modelProfileActive: active })
	await controller.stateManager.flushPendingState?.()
	return { view: listModelProfiles(controller, mode), nameExists: false }
}

export async function deleteModelProfile(
	controller: ModelProfilesController,
	rawName: string,
	mode: ProfileMode,
): Promise<ModelProfilesView> {
	const name = normalizeName(rawName)
	const profiles = readProfiles(controller)
	if (!profiles.some((p) => p.name === name)) throw new Error(`No profile is named "${name}".`)
	const active = { ...readActive(controller) }
	for (const m of ["plan", "act"] as const) {
		if (active[m] === name) delete active[m]
	}
	controller.stateManager.setGlobalStateBatch({
		modelProfiles: profiles.filter((p) => p.name !== name),
		modelProfileActive: active,
	})
	await controller.stateManager.flushPendingState?.()
	return listModelProfiles(controller, mode)
}
