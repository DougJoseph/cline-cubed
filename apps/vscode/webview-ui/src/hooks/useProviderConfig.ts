import { StringRequest } from "@shared/proto/cline/common"
import {
	type AwsProviderConfig,
	CommitModelSelectionRequest,
	type GcpProviderConfig,
	type ProviderConfigResponse,
	WriteProviderConfigPatch,
	WriteProviderConfigRequest,
} from "@shared/proto/cline/models"
import {
	type ProviderModelOverrides,
	toProtobufModelOverrides as toProtobufProviderModelOverrides,
} from "@shared/proto-conversions/models/modelOverrides"
import type { Mode } from "@shared/storage/types"
import { useCallback, useEffect, useRef, useState } from "react"
import type { ProviderId } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import {
	beginSettingsLoad,
	endSettingsLoad,
	reportSettingsLoadFailure,
	reportSettingsSaveFailure,
	SETTINGS_ANSWER_LIMIT_MS,
	SETTINGS_SAVE_LIMIT_MS,
	withAnswerLimit,
} from "@/utils/settingsHealth"

export type ProviderConfigWritePatch = Partial<Omit<WriteProviderConfigPatch, "headers" | "aws" | "gcp">> & {
	headers?: Record<string, string>
	aws?: Partial<AwsProviderConfig>
	gcp?: Partial<GcpProviderConfig>
}

// The overrides domain type and its proto conversions are shared with the
// host; see the tri-state and normalization semantics documented there.
export {
	fromProtobufModelOverrides as fromProtobufProviderModelOverrides,
	toProtobufModelOverrides as toProtobufProviderModelOverrides,
} from "@shared/proto-conversions/models/modelOverrides"
export type { ProviderModelOverrides }

export interface ProviderModelSelection {
	providerId: ProviderId
	modelId: string
	/**
	 * Tri-state: `undefined` preserves the model's stored overrides, an
	 * explicitly empty object clears them, and a non-empty object replaces
	 * them wholesale.
	 */
	overrides?: ProviderModelOverrides
}

function toWriteProviderConfigPatch(patch: ProviderConfigWritePatch): WriteProviderConfigPatch {
	const headers = patch.headers ?? {}
	const shouldClearHeaders = patch.headers !== undefined && Object.keys(headers).length === 0

	return WriteProviderConfigPatch.create({
		...patch,
		headers,
		clearHeaders: shouldClearHeaders || undefined,
	})
}

function savedFieldName(patch: ProviderConfigWritePatch): string {
	if ("apiKey" in patch) return "API key"
	if ("baseUrl" in patch) return "Base URL"
	return "this setting"
}

export function useProviderConfig(providerId: ProviderId) {
	const [config, setConfig] = useState<ProviderConfigResponse | undefined>(undefined)

	// Reads and writes resolve asynchronously and can complete out of order
	// (e.g. a slow initial read landing after a user-triggered write). Only
	// the latest issued request may apply its response; anything older is
	// stale and would roll the UI state back.
	const requestSeqRef = useRef(0)
	const applyConfig = useCallback((seq: number, response: ProviderConfigResponse) => {
		if (seq !== requestSeqRef.current) {
			return
		}
		setConfig(response)
	}, [])

	const read = useCallback(async () => {
		const seq = ++requestSeqRef.current
		const response = await withAnswerLimit(
			ModelsServiceClient.readProviderConfig(StringRequest.create({ value: providerId })),
			SETTINGS_ANSWER_LIMIT_MS,
		)
		applyConfig(seq, response)
		return response
	}, [providerId, applyConfig])

	useEffect(() => {
		const seq = requestSeqRef.current + 1
		beginSettingsLoad()
		read()
			.catch((error) => {
				console.error(`Failed to load ${providerId} settings:`, error)
				// A newer request owns the outcome once one has been issued.
				if (seq === requestSeqRef.current) {
					reportSettingsLoadFailure()
				}
			})
			.finally(endSettingsLoad)
	}, [providerId, read])

	const write = useCallback(
		async (patch: ProviderConfigWritePatch) => {
			const seq = ++requestSeqRef.current
			try {
				const response = await withAnswerLimit(
					ModelsServiceClient.writeProviderConfig(
						WriteProviderConfigRequest.create({
							providerId,
							patch: toWriteProviderConfigPatch(patch),
						}),
					),
					SETTINGS_SAVE_LIMIT_MS,
				)
				applyConfig(seq, response)
				return response
			} catch (error) {
				reportSettingsSaveFailure(savedFieldName(patch))
				// A failed write may still have partially applied host-side, and
				// its failure means no response will ever apply for this seq —
				// without a re-read, older dropped responses could leave config
				// stale (or undefined) forever. Re-read to converge on the
				// backend's actual state, but only if this write is still the
				// latest request: when a newer request is already in flight, its
				// response (or its own failure recovery) supersedes this one,
				// and a recovery read issued now could race ahead of the newer
				// write host-side and pin a pre-write snapshot as the latest.
				if (seq === requestSeqRef.current) {
					void read().catch(() => {})
				}
				throw error
			}
		},
		[providerId, applyConfig, read],
	)

	const commitSelection = useCallback(
		async (mode: Mode, selection: ProviderModelSelection) => {
			if (selection.providerId !== providerId) {
				throw new Error(`selection providerId ${selection.providerId} does not match hook providerId ${providerId}`)
			}

			// The host writes the incoming model id over the stored selection, so an
			// empty one here erases the model the user chose. Reject it so the caller
			// surfaces the failure instead of corrupting the selection.
			const modelId = selection.modelId?.trim() ?? ""
			if (!modelId) {
				throw new Error(`commitSelection for provider ${providerId} requires a model id`)
			}

			try {
				await withAnswerLimit(
					ModelsServiceClient.commitModelSelection(
						CommitModelSelectionRequest.create({
							providerId,
							mode,
							modelId,
							overrides:
								selection.overrides !== undefined
									? toProtobufProviderModelOverrides(selection.overrides)
									: undefined,
						}),
					),
					SETTINGS_SAVE_LIMIT_MS,
				)
			} catch (error) {
				reportSettingsSaveFailure("model")
				throw error
			}
			await read()
		},
		[providerId, read],
	)

	return { config, write, commitSelection }
}
