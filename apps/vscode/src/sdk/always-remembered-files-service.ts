import { homedir } from "node:os"
import { sep } from "node:path"
import {
	readAlwaysRememberedFilesGlobally,
	resolveCompactionTriggerTokens,
	resolveRulesConfigSearchPaths,
	setAlwaysRememberedFilesGlobally,
} from "@cline/core"
import { HostProvider } from "@/hosts/host-provider"
import { AlwaysRememberedFiles } from "@/shared/proto/cline/file"
import { Logger } from "@/shared/services/Logger"
import {
	addAlwaysRememberedEntry,
	groupAutomaticRuleLocations,
	isLocalEndpoint,
	loadAlwaysRememberedFiles,
	moveAlwaysRememberedEntry,
	removeAlwaysRememberedEntry,
	totalAlwaysRememberedTokens,
} from "./always-remembered-files"
import { resolveActiveEndpointLimits } from "./cline-session-factory"
import { resolveWorkspaceRootPath } from "./workspace-root"

async function resolveSettingsWorkspaceRoot(): Promise<string> {
	try {
		const { paths } = await HostProvider.workspace.getWorkspacePaths({})
		return resolveWorkspaceRootPath(paths, homedir())
	} catch (error) {
		Logger.warn("[AlwaysRememberedFiles] Could not read workspace paths:", error)
		return homedir()
	}
}

function toHomeRelative(filePath: string): string {
	const home = homedir()
	return filePath.startsWith(`${home}${sep}`) ? `~/${filePath.slice(home.length + 1)}` : filePath
}

export async function getAlwaysRememberedFilesState(addError?: string): Promise<AlwaysRememberedFiles> {
	const workspaceRoot = await resolveSettingsWorkspaceRoot()
	const files = await loadAlwaysRememberedFiles(readAlwaysRememberedFilesGlobally(), {
		workspaceRoot,
		ruleSearchPaths: resolveRulesConfigSearchPaths(workspaceRoot),
	})
	const { providerId, baseUrl, contextWindow, maxInputTokens } = resolveActiveEndpointLimits()
	const totalEstimatedTokens = totalAlwaysRememberedTokens(files)
	const triggerTokens = resolveCompactionTriggerTokens({ contextWindow, maxInputTokens })
	const automaticLocations = groupAutomaticRuleLocations(
		resolveRulesConfigSearchPaths(workspaceRoot),
		resolveRulesConfigSearchPaths(),
		workspaceRoot,
	)
	return AlwaysRememberedFiles.create({
		automaticWorkspaceLocations: automaticLocations.workspace,
		automaticGlobalLocations: automaticLocations.global,
		files: files.map((file) => ({
			path: file.entry,
			resolvedPath: file.resolvedPath,
			status: file.status,
			error: file.error,
			chars: file.chars,
			estimatedTokens: file.estimatedTokens,
			alreadyLoadedAsRule: file.alreadyLoadedAsRule,
		})),
		totalEstimatedTokens,
		contextWindow,
		endpointIsLocal: isLocalEndpoint(providerId, baseUrl),
		addError,
		reachesCompactionTrigger: triggerTokens !== undefined && totalEstimatedTokens >= triggerTokens,
	})
}

export async function addAlwaysRememberedFile(rawPath: string): Promise<AlwaysRememberedFiles> {
	const workspaceRoot = await resolveSettingsWorkspaceRoot()
	const result = await addAlwaysRememberedEntry(readAlwaysRememberedFilesGlobally(), rawPath, workspaceRoot)
	if (!result.error) {
		setAlwaysRememberedFilesGlobally(result.entries)
	}
	return getAlwaysRememberedFilesState(result.error)
}

export async function pickAlwaysRememberedFile(): Promise<AlwaysRememberedFiles> {
	const { paths } = await HostProvider.window.showOpenDialogue({ canSelectMany: false, openLabel: "Always Remember" })
	const chosen = paths?.[0]
	return chosen ? addAlwaysRememberedFile(toHomeRelative(chosen)) : getAlwaysRememberedFilesState()
}

export async function removeAlwaysRememberedFile(entry: string): Promise<AlwaysRememberedFiles> {
	setAlwaysRememberedFilesGlobally(removeAlwaysRememberedEntry(readAlwaysRememberedFilesGlobally(), entry))
	return getAlwaysRememberedFilesState()
}

export async function moveAlwaysRememberedFile(entry: string, delta: number): Promise<AlwaysRememberedFiles> {
	setAlwaysRememberedFilesGlobally(moveAlwaysRememberedEntry(readAlwaysRememberedFilesGlobally(), entry, delta))
	return getAlwaysRememberedFilesState()
}
