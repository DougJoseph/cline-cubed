import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { Mode } from "@shared/storage/types"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { TabButton } from "../../mcp/configuration/McpConfigurationView"
import ApiOptions from "../ApiOptions"
import Section from "../Section"
import { syncModeConfigurations } from "../utils/providerUtils"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * The settings tab id. Image mode is the Cline Cubed third channel — a config
 * concept only, never a runtime task mode (the global `Mode` stays plan/act).
 */
type SettingsTab = Mode | "image"

interface ApiConfigurationSectionProps {
	renderSectionHeader?: (tabId: string) => JSX.Element | null
	initialModelTab?: "recommended" | "free"
}

const ApiConfigurationSection = ({ renderSectionHeader, initialModelTab }: ApiConfigurationSectionProps) => {
	const { planActSeparateModelsSetting, mode, apiConfiguration, imageBridgeDebugEnabled } = useExtensionState()
	const [currentTab, setCurrentTab] = useState<SettingsTab>(mode)
	const { handleFieldsChange } = useApiConfigurationHandlers()
	return (
		<div>
			{renderSectionHeader?.("api-config")}
			<Section>
				{/* Tabs container */}
				{planActSeparateModelsSetting ? (
					<div className="rounded-md mb-5">
						<div className="flex gap-px mb-[10px] -mt-2 border-0 border-b border-solid border-(--vscode-panel-border)">
							<TabButton
								disabled={currentTab === "plan"}
								isActive={currentTab === "plan"}
								onClick={() => setCurrentTab("plan")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Plan Mode
							</TabButton>
							<TabButton
								disabled={currentTab === "act"}
								isActive={currentTab === "act"}
								onClick={() => setCurrentTab("act")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Act Mode
							</TabButton>
							<TabButton
								disabled={currentTab === "image"}
								isActive={currentTab === "image"}
								onClick={() => setCurrentTab("image")}
								style={{
									opacity: 1,
									cursor: "pointer",
								}}>
								Image Mode
							</TabButton>
						</div>

						{/* Content container */}
						<div className="-mb-3">
							{currentTab === "image" ? (
								<>
									<ApiOptions currentMode="image" initialModelTab={initialModelTab} showModelOptions={true} />
									<div className="mt-3">
										<VSCodeCheckbox
											checked={imageBridgeDebugEnabled === true}
											onChange={async (e: any) => {
												try {
													await StateServiceClient.updateSettings(
														UpdateSettingsRequest.create({
															imageBridgeDebugEnabled: e.target.checked === true,
														}),
													)
												} catch (error) {
													console.error("Failed to update image bridge debug setting:", error)
												}
											}}>
											Image bridge debug logging
										</VSCodeCheckbox>
										<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
											Records each image-bridge call (provider, model, URL, image type/size, auth, status)
											to the output channel and shows the most recent calls inline under failed bridge
											blocks. Full log: <code>View → Output → Cline Cubed</code>.
										</p>
									</div>
								</>
							) : (
								<ApiOptions currentMode={currentTab} initialModelTab={initialModelTab} showModelOptions={true} />
							)}
						</div>
					</div>
				) : (
					<ApiOptions currentMode={mode} initialModelTab={initialModelTab} showModelOptions={true} />
				)}

				<div className="mb-[5px]">
					<VSCodeCheckbox
						checked={planActSeparateModelsSetting}
						className="mb-[5px]"
						onChange={async (e: any) => {
							const checked = e.target.checked === true
							try {
								// If unchecking the toggle, wait a bit for state to update, then sync configurations
								if (!checked) {
									await syncModeConfigurations(
										apiConfiguration,
										currentTab === "image" ? mode : currentTab,
										handleFieldsChange,
									)
								}
								await StateServiceClient.updateSettings(
									UpdateSettingsRequest.create({
										planActSeparateModelsSetting: checked,
									}),
								)
							} catch (error) {
								console.error("Failed to update separate models setting:", error)
							}
						}}>
						Use different models for Plan and Act modes
					</VSCodeCheckbox>
					<p className="text-xs mt-[5px] text-(--vscode-descriptionForeground)">
						Switching between Plan and Act mode will persist the API and model used in the previous mode. This may be
						helpful e.g. when using a strong reasoning model to architect a plan for a cheaper coding model to act on.
					</p>
				</div>
			</Section>
		</div>
	)
}

export default ApiConfigurationSection
