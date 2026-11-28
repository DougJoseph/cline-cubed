/**
 * Cline Cubed: a profile is a named, complete model setup that can be switched to in one action,
 * for Plan or Act. It holds every field Settings writes for a mode's model, so two setups under
 * the same provider (two models at one OpenAI Compatible base URL, say) no longer overwrite each
 * other. It never holds a key: it uses the key already saved for its provider.
 */
import type { ModelInfo } from "./api"

/** The provider-level reasoning a profile restores (`providers.json` `reasoning`). */
export interface ModelProfileReasoning {
	enabled?: boolean
	effort?: string
	budgetTokens?: number
}

/** The model's own settings a profile restores (the per-model overrides in `models.json`). */
export interface ModelProfileOverrides {
	name?: string
	maxTokens?: number
	contextWindow?: number
	maxInputTokens?: number
	capabilities?: string[]
	supportsVision?: boolean
	supportsAttachments?: boolean
	supportsReasoning?: boolean
	inputPrice?: number
	outputPrice?: number
	cacheReadsPrice?: number
	cacheWritesPrice?: number
	temperature?: number
	apiFormat?: ModelInfo["apiFormat"]
}

/** The "Images sent to the model" settings a profile restores. */
export interface ModelProfileImages {
	imagesTotalLimitMb: number
	imagesPerImageLimitMb: number
	imagesPerImageDecodedLimitMb: number
	imageDescriber: "imageModeFirst" | "mainModelFirst"
	earlierImages: "pictures" | "descriptions"
}

export interface ModelProfile {
	name: string
	/** Provider id as the provider config store names it, e.g. "openai" for OpenAI Compatible. */
	providerId: string
	baseUrl?: string
	/** Provider-level context window (`providers.json` `contextWindow`). */
	providerContextWindow?: number
	reasoning?: ModelProfileReasoning
	modelId: string
	overrides?: ModelProfileOverrides
	/** The mode's reasoning effort (`planModeReasoningEffort` / `actModeReasoningEffort`). */
	reasoningEffort?: string
	/** The mode's thinking budget (`planModeThinkingBudgetTokens` / `actModeThinkingBudgetTokens`). */
	thinkingBudgetTokens?: number
	images: ModelProfileImages
	savedAt: number
}

/** The profile last chosen or saved for each mode, by name. */
export interface ModelProfileActive {
	plan?: string
	act?: string
}

export const MODEL_PROFILE_NAME_MAX_LENGTH = 60
