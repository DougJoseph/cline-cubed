import { ResolveProviderModelsRequest } from "@shared/proto/cline/models"
import { useCallback, useEffect, useRef } from "react"
import { type ProviderId, useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { clearModelListSlow, MODEL_LIST_SLOW_NOTICE_MS, reportModelListSlow } from "@/utils/settingsHealth"

let providerModelRequestCounter = 0

function createRequestId(): string {
	providerModelRequestCounter += 1
	return `provider-models-${providerModelRequestCounter}`
}

/**
 * Read-only provider model-list hook backed by the unified provider catalog RPC.
 *
 * This hook never writes model selection state; selection commits are owned by
 * useProviderConfig/commitModelSelection.
 */
export function useProviderModels(providerId: ProviderId) {
	const { providerModelsByProvider, startProviderModelsRequest, applyProviderModelsResponse } = useExtensionState()
	const state = providerModelsByProvider?.[providerId]

	const slowNoticeRef = useRef<(() => void) | undefined>(undefined)

	const refresh = useCallback(async () => {
		const requestId = createRequestId()
		startProviderModelsRequest(providerId, requestId)
		slowNoticeRef.current?.()
		const slowTimer = setTimeout(() => reportModelListSlow(requestId), MODEL_LIST_SLOW_NOTICE_MS)
		const clearSlowNotice = () => {
			clearTimeout(slowTimer)
			clearModelListSlow(requestId)
		}
		slowNoticeRef.current = clearSlowNotice
		try {
			// The request keeps running after the notice, so a slow server's answer still lands.
			const response = await ModelsServiceClient.resolveProviderModels(
				ResolveProviderModelsRequest.create({ providerId, forceRefresh: true, requestId }),
			)
			applyProviderModelsResponse(response)
		} catch (error) {
			applyProviderModelsResponse({
				providerId,
				requestId,
				configFingerprint: "",
				fetchedAt: Date.now(),
				ok: false,
				models: {},
				error: {
					kind: "unknown",
					message: error instanceof Error ? error.message : String(error),
				},
			})
		} finally {
			clearSlowNotice()
		}
	}, [applyProviderModelsResponse, providerId, startProviderModelsRequest])

	useEffect(() => {
		void refresh()
		return () => slowNoticeRef.current?.()
	}, [refresh])

	return {
		models: state?.models ?? {},
		defaultModelId: state?.defaultModelId ?? "",
		isLoading: state?.isLoading ?? false,
		isStale: state?.isStale ?? false,
		error: state?.error,
		refresh,
		fingerprint: state?.configFingerprint ?? "",
	}
}
