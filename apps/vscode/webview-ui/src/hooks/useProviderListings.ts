import { Empty } from "@shared/proto/cline/common"
import type { ProviderListing } from "@shared/proto/cline/models"
import { useCallback, useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"
import {
	beginSettingsLoad,
	endSettingsLoad,
	reportSettingsLoadFailure,
	SETTINGS_ANSWER_LIMIT_MS,
	withAnswerLimit,
} from "@/utils/settingsHealth"

export function useProviderListings() {
	const [providers, setProviders] = useState<ProviderListing[]>([])
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<Error | undefined>(undefined)

	const refresh = useCallback(async () => {
		setIsLoading(true)
		setError(undefined)
		beginSettingsLoad()
		try {
			const response = await withAnswerLimit(ModelsServiceClient.listProviders(Empty.create()), SETTINGS_ANSWER_LIMIT_MS)
			setProviders(response.providers)
			return response.providers
		} catch (err) {
			const normalizedError = err instanceof Error ? err : new Error(String(err))
			setError(normalizedError)
			console.error("Failed to list provider catalog entries:", normalizedError)
			reportSettingsLoadFailure()
			return []
		} finally {
			endSettingsLoad()
			setIsLoading(false)
		}
	}, [])

	useEffect(() => {
		void refresh()
	}, [refresh])

	return { providers, isLoading, error, refresh }
}
