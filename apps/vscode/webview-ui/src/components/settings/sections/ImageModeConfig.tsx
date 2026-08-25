import { ApiConfiguration, ApiProvider } from "@shared/api"
import { VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Cline Cubed — Image Mode configuration.
 *
 * The third model channel. The Image Mode model is a vision-capable model
 * that reads image attachments and produces text-only descriptions, which the
 * image bridge injects into the request when the Plan/Act model cannot view
 * images (e.g. DeepSeek Reasoner). This form stores the bridge model's
 * provider, model id, API key, base URL and API format.
 */
const IMAGE_PROVIDER_OPTIONS: { id: ApiProvider; label: string }[] = [
	{ id: "openai", label: "OpenAI Compatible" },
	{ id: "openai-native", label: "OpenAI" },
	{ id: "deepseek", label: "DeepSeek" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "gemini", label: "Google Gemini" },
	{ id: "openrouter", label: "OpenRouter" },
]

export const ImageModeConfig = () => {
	const { apiConfiguration } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()

	const provider = (apiConfiguration?.imageModeApiProvider as ApiProvider | undefined) ?? "openai"
	const modelId = apiConfiguration?.imageModeApiModelId ?? ""
	const apiKey = apiConfiguration?.imageModeApiKey ?? ""
	const apiUri = apiConfiguration?.imageModeApiUri ?? ""
	const apiFormat = apiConfiguration?.imageModeApiFormat ?? ""

	const write = async <K extends keyof ApiConfiguration>(field: K, value: ApiConfiguration[K]) => {
		try {
			await handleFieldChange(field, value)
		} catch (error) {
			console.error(`Failed to update ${String(field)}:`, error)
		}
	}

	return (
		<div>
			<VSCodeDropdown
				onChange={(e: any) => {
					void write("imageModeApiProvider", e.target.value as ApiProvider)
				}}
				value={provider}>
				<span slot="label">Vision provider</span>
				{IMAGE_PROVIDER_OPTIONS.map((option) => (
					<VSCodeOption key={option.id} value={option.id}>
						{option.label}
					</VSCodeOption>
				))}
			</VSCodeDropdown>

			<DebouncedTextField
				initialValue={modelId}
				onChange={(value) => void write("imageModeApiModelId", value)}
				placeholder="e.g. deepseek-vl2, gpt-4o-mini, gemini-2.0-flash">
				Model ID
			</DebouncedTextField>

			<DebouncedTextField
				initialValue={apiKey}
				onChange={(value) => void write("imageModeApiKey", value)}
				placeholder="Provider API key"
				type="password">
				API Key
			</DebouncedTextField>

			<DebouncedTextField
				initialValue={apiUri}
				onChange={(value) => void write("imageModeApiUri", value)}
				placeholder="https://api.deepseek.com (optional)">
				Base URL
			</DebouncedTextField>

			<DebouncedTextField
				initialValue={apiFormat}
				onChange={(value) => void write("imageModeApiFormat", value)}
				placeholder="openai (optional)">
				API Format
			</DebouncedTextField>

			<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
				The Image Mode model is the Cline Cubed image bridge: it reads pasted images and feeds their contents to the
				Plan/Act model as text, so a text-only reasoning model (such as DeepSeek Reasoner) can reason about images.
			</p>
		</div>
	)
}
