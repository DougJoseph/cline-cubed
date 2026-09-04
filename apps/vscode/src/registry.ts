import { name, publisher, version } from "../package.json"
import { HostProvider } from "./hosts/host-provider"

const prefix = name === "claude-dev" || name === "cline-cubed" ? "cline" : name

/**
 * List of commands with the name of the extension they are registered under.
 * These should match the command IDs defined in package.json.
 * For Nightly build, the publish script has updated all the commands to use the extension name as prefix.
 * In production, all commands are registered under "cline" for consistency.
 */
const ClineCommands = {
	PlusButton: prefix + ".plusButtonClicked",
	NewChatPane: prefix + ".newChatPane",
	OpenChatInEditor: prefix + ".openChatInEditor",
	// Cline Cubed: Button #3 — the Cline Cubed icon in the secondary chat header.
	OpenChatInSecondary: prefix + ".openChatInSecondary",
	// Cline Cubed: the chats panel's OWN title buttons. Separate commands from the chat views'
	// buttons so they act on the panel the user clicked in, rather than on some other chat.
	ChatsListMarketplace: prefix + ".chatsListMarketplace",
	ChatsListAccount: prefix + ".chatsListAccount",
	ChatsListSettings: prefix + ".chatsListSettings",
	OpenOnboarding: prefix + ".openOnboarding",
	McpButton: prefix + ".mcpButtonClicked",
	MarketplaceButton: prefix + ".marketplaceButtonClicked",
	SettingsButton: prefix + ".settingsButtonClicked",
	HistoryButton: prefix + ".historyButtonClicked",
	AccountButton: prefix + ".accountButtonClicked",
	WorktreesButton: prefix + ".worktreesButtonClicked",
	TerminalOutput: prefix + ".addTerminalOutputToChat",
	AddToChat: prefix + ".addToChat",
	FixWithCline: prefix + ".fixWithCline",
	ExplainCode: prefix + ".explainCode",
	ImproveCode: prefix + ".improveCode",
	FocusChatInput: prefix + ".focusChatInput",
	// Cline Cubed: reopen the What's New notes on demand, in the working chat view.
	ShowWhatsNew: prefix + ".showWhatsNew",
	Walkthrough: prefix + ".openWalkthrough",
	GenerateCommit: prefix + ".generateGitCommitMessage",
	AbortCommit: prefix + ".abortGitCommitMessage",
	// Jupyter Notebook commands
	JupyterGenerateCell: prefix + ".jupyterGenerateCell",
	JupyterExplainCell: prefix + ".jupyterExplainCell",
	JupyterImproveCell: prefix + ".jupyterImproveCell",
}

/**
 * IDs for the views registered by the extension.
 * These should match the name + view IDs defined in package.json.
 */
const ClineViewIds = {
	SidebarSecondary: name + ".SidebarProviderSecondary",
	SidebarChat: name + ".SidebarChatProvider",
	ActivityBarSecondary: name + "-ActivityBarSecondary",
	SessionsContainer: name + "-Sessions",
}

/**
 * The registry info for the extension, including its ID, name, version, commands, and views
 * registered for the current host.
 */
export const ExtensionRegistryInfo = {
	id: publisher + "." + name,
	name,
	version,
	publisher,
	commands: ClineCommands,
	views: ClineViewIds,
}

export interface HostInfo {
	/**
	 * The name of the host platform, e.g VSCode, IntelliJ Ultimate Edition, etc.
	 */
	platform: string
	/**
	 * The operating system platform, e.g. linux, darwin, win32
	 */
	os: string
	/**
	 * The type of the cline host environment, e.g. 'VSCode Extension', 'Cline for JetBrains', 'CLI'
	 * This is different from the platform because there are many JetBrains IDEs, but they all use the same
	 * plugin.
	 */
	ide: string
	/**
	 * A distinct ID for this installation of the host client
	 */
	distinctId: string
	/**
	 * The version of the host platform, e.g. 1.103.0 for VSCode, or 2025.1.1.1 for JetBrains IDEs.
	 */
	hostVersion?: string
	/**
	 * The version of Cline that the host client is running
	 */
	extensionVersion: string
}

let hostInfo = null as HostInfo | null

export const HostRegistryInfo = {
	init: async (distinctId: string) => {
		const host = await HostProvider.env.getHostVersion({})
		const hostVersion = host.version
		const extensionVersion = host.clineVersion || ExtensionRegistryInfo.version
		const platform = host.platform || "unknown"
		const os = process.platform || "unknown"
		const ide = host.clineType || "unknown"
		hostInfo = { hostVersion, extensionVersion, platform, os, ide, distinctId }
	},
	get: () => hostInfo,
}
