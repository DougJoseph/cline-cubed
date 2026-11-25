import { useState } from "react"
import type { ProviderId } from "@/context/ExtensionStateContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { fromProtobufProviderModelOverrides, useProviderConfig } from "@/hooks/useProviderConfig"
import { useSettingsHealth } from "@/utils/settingsHealth"
import { DebouncedTextField } from "./DebouncedTextField"

const MaxOutputInput = ({ providerId, modelId }: { providerId: ProviderId; modelId: string }) => {
	const { config, commitSelection } = useProviderConfig(providerId)
	const [error, setError] = useState<string>()
	const selection = config?.imageSelection?.modelId === modelId ? config.imageSelection : undefined
	const maxTokens = selection?.modelInfo?.maxTokens

	const save = (value: string) => {
		const trimmed = value.trim()
		if (trimmed === (maxTokens === undefined ? "" : String(maxTokens))) {
			return
		}
		if (trimmed && !/^[1-9]\d*$/.test(trimmed)) {
			setError("Max Output Tokens must be a positive whole number.")
			return
		}
		setError(undefined)
		const { maxTokens: _previous, ...overrides } = fromProtobufProviderModelOverrides(selection?.overrides) ?? {}
		void commitSelection("image", {
			providerId,
			modelId,
			overrides: trimmed ? { ...overrides, maxTokens: Number(trimmed) } : overrides,
		}).catch((commitError) => {
			console.error("Failed to save the Image Mode output limit:", commitError)
			setError("Could not save Max Output Tokens.")
		})
	}

	return (
		<div className="mt-3">
			<DebouncedTextField
				className="w-full"
				initialValue={maxTokens === undefined ? "" : String(maxTokens)}
				onChange={save}
				placeholder="No limit sent">
				<span className="font-medium">Max Output Tokens</span>
			</DebouncedTextField>
			{error && (
				<p className="mt-1 text-xs text-error" role="alert">
					{error}
				</p>
			)}
			<p className="mt-1 text-xs text-muted-foreground">
				The most the image model may write per image, including its reasoning.
			</p>
		</div>
	)
}

/** The output limit the image bridge actually sends for the selected Image Mode model. */
export const ImageModeMaxOutputField = () => {
	const { apiConfiguration } = useExtensionState()
	const providerId = apiConfiguration?.imageModeApiProvider as ProviderId | undefined
	const modelId = apiConfiguration?.imageModeApiModelId
	const { loadFailed } = useSettingsHealth()
	if (!providerId || !modelId || loadFailed) {
		return null
	}
	return <MaxOutputInput key={`${providerId}:${modelId}`} modelId={modelId} providerId={providerId} />
}
