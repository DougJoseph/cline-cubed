import { readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { type CoreSessionConfig, readAlwaysRememberedFilesGlobally, resolveRulesConfigSearchPaths } from "@cline/core"
import { estimateTokens } from "@cline/shared"
import { Logger } from "@/shared/services/Logger"

export type AlwaysRememberedFileStatus = "ok" | "missing" | "unreadable" | "refused"

export interface AlwaysRememberedFile {
	/** The path as it appears on the list. */
	entry: string
	resolvedPath: string
	status: AlwaysRememberedFileStatus
	error?: string
	content?: string
	chars: number
	estimatedTokens: number
	/** The rules watcher already places this file in the system prompt. */
	alreadyLoadedAsRule: boolean
}

export interface AlwaysRememberedLoadOptions {
	workspaceRoot: string
	ruleSearchPaths: readonly string[]
}

export interface AlwaysRememberedEditResult {
	entries: string[]
	error?: string
}

const LOCAL_PROVIDERS_WITHOUT_BASE_URL = new Set(["ollama", "lmstudio"])
const RULE_FILE_EXTENSIONS = new Set([".md", ".markdown", ".txt"])

export function resolveAlwaysRememberedPath(entry: string, workspaceRoot: string): string {
	const trimmed = entry.trim()
	if (trimmed === "~") {
		return homedir()
	}
	if (trimmed.startsWith("~/")) {
		return join(homedir(), trimmed.slice(2))
	}
	return isAbsolute(trimmed) ? trimmed : resolve(workspaceRoot, trimmed)
}

export function isRefusedSecretsFile(filePath: string): boolean {
	const name = basename(filePath).toLowerCase()
	return name === ".env" || name.startsWith(".env.")
}

async function canonicalPath(filePath: string): Promise<string> {
	try {
		return await realpath(filePath)
	} catch {
		return filePath
	}
}

function isLoadedByRulesWatcher(canonical: string, content: string, ruleLocations: ReadonlySet<string>): boolean {
	// A file with frontmatter can disable itself as a rule, so only a file
	// without frontmatter is certain to be in the prompt already.
	if (content.startsWith("---")) {
		return false
	}
	return (
		ruleLocations.has(canonical) ||
		(RULE_FILE_EXTENSIONS.has(extname(canonical).toLowerCase()) && ruleLocations.has(dirname(canonical)))
	)
}

/** Split the rule search paths into per-workspace and global locations, shortened for display. */
export function groupAutomaticRuleLocations(
	workspaceSearchPaths: readonly string[],
	globalSearchPaths: readonly string[],
	workspaceRoot: string,
	home: string = homedir(),
): { workspace: string[]; global: string[] } {
	const globalPaths = new Set(globalSearchPaths)
	return {
		workspace: workspaceSearchPaths
			.filter((location) => !globalPaths.has(location))
			.map((location) => relative(workspaceRoot, location)),
		global: globalSearchPaths.map((location) =>
			location.startsWith(`${home}${sep}`) ? `~/${location.slice(home.length + 1)}` : location,
		),
	}
}

function failedFile(
	entry: string,
	resolvedPath: string,
	status: Exclude<AlwaysRememberedFileStatus, "ok">,
	error: string,
): AlwaysRememberedFile {
	return { entry, resolvedPath, status, error, chars: 0, estimatedTokens: 0, alreadyLoadedAsRule: false }
}

/** Load every listed file whole, in list order. A file that cannot load is reported, never skipped. */
export async function loadAlwaysRememberedFiles(
	entries: readonly string[],
	options: AlwaysRememberedLoadOptions,
): Promise<AlwaysRememberedFile[]> {
	const ruleLocations = new Set(await Promise.all(options.ruleSearchPaths.map(canonicalPath)))
	const seen = new Set<string>()
	const files: AlwaysRememberedFile[] = []

	for (const entry of entries) {
		const resolvedPath = resolveAlwaysRememberedPath(entry, options.workspaceRoot)
		const canonical = await canonicalPath(resolvedPath)
		if (seen.has(canonical)) {
			continue
		}
		seen.add(canonical)

		if (isRefusedSecretsFile(resolvedPath) || isRefusedSecretsFile(canonical)) {
			files.push(failedFile(entry, resolvedPath, "refused", "secrets files cannot be always remembered"))
			continue
		}

		try {
			const info = await stat(resolvedPath)
			if (!info.isFile()) {
				files.push(failedFile(entry, resolvedPath, "unreadable", "not a file"))
				continue
			}
			const content = await readFile(resolvedPath, "utf8")
			files.push({
				entry,
				resolvedPath,
				status: "ok",
				content,
				chars: content.length,
				estimatedTokens: estimateTokens(content.length),
				alreadyLoadedAsRule: isLoadedByRulesWatcher(canonical, content, ruleLocations),
			})
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code === "ENOENT" || code === "ENOTDIR") {
				files.push(failedFile(entry, resolvedPath, "missing", "file not found"))
			} else {
				Logger.error(`[AlwaysRememberedFiles] Failed to read ${resolvedPath}:`, error)
				files.push(failedFile(entry, resolvedPath, "unreadable", code ?? "could not be read"))
			}
		}
	}
	return files
}

/** Build the system prompt block. The output depends only on the files, so it stays byte-stable across runs. */
export function buildAlwaysRememberedPrompt(files: readonly AlwaysRememberedFile[]): string {
	const sections = files
		.filter((file) => !file.alreadyLoadedAsRule)
		.map((file) =>
			file.status === "ok"
				? `## ${file.resolvedPath}\n\n${file.content}`
				: `## ${file.resolvedPath} (failed to load)\n\nThis file is on the always-remembered list, but it failed to load: ${file.error}. You do not have its contents. Tell the user before relying on it.`,
		)
	if (sections.length === 0) {
		return ""
	}
	return [
		"# Always-Remembered Files",
		"The files below are your standing work contract. They bind you for this entire session and remain in force after any context compaction. Follow them over any conflicting summary of earlier conversation.",
		...sections,
	].join("\n\n")
}

function isPrivateIpv4(host: string): boolean {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
	if (!match) {
		return false
	}
	const first = Number(match[1])
	const second = Number(match[2])
	return (
		first === 127 ||
		first === 10 ||
		(first === 192 && second === 168) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 169 && second === 254)
	)
}

export function isLocalEndpoint(providerId: string | undefined, baseUrl: string | undefined): boolean {
	if (!baseUrl?.trim()) {
		return providerId !== undefined && LOCAL_PROVIDERS_WITHOUT_BASE_URL.has(providerId)
	}
	let host: string
	try {
		host = new URL(baseUrl).hostname.toLowerCase()
	} catch {
		return false
	}
	const unbracketed = host.replace(/^\[|\]$/g, "")
	return (
		unbracketed === "localhost" ||
		unbracketed.endsWith(".localhost") ||
		unbracketed.endsWith(".local") ||
		unbracketed === "::1" ||
		/^f[cd]/.test(unbracketed) ||
		isPrivateIpv4(unbracketed)
	)
}

export function shareOfContextWindow(tokens: number, contextWindow: number | undefined): number | undefined {
	return contextWindow && contextWindow > 0 ? tokens / contextWindow : undefined
}

export function totalAlwaysRememberedTokens(files: readonly AlwaysRememberedFile[]): number {
	return files.filter((file) => !file.alreadyLoadedAsRule).reduce((total, file) => total + file.estimatedTokens, 0)
}

export function describeAlwaysRememberedIssues(
	files: readonly AlwaysRememberedFile[],
	options: { endpointIsLocal: boolean; compactionTriggerTokens?: number },
): string[] {
	const issues = files
		.filter((file) => file.status !== "ok")
		.map((file) => `Always-remembered file failed to load: ${file.resolvedPath} (${file.error}).`)
	const totalTokens = totalAlwaysRememberedTokens(files)
	if (options.compactionTriggerTokens !== undefined && totalTokens >= options.compactionTriggerTokens) {
		issues.push(
			`Always-remembered files total about ${totalTokens} estimated tokens, which alone reaches the compaction trigger of ${Math.floor(options.compactionTriggerTokens)}. No compaction can make this conversation fit. Remove or shorten a file.`,
		)
	}
	const sentCount = files.filter((file) => file.status === "ok" && !file.alreadyLoadedAsRule).length
	if (!options.endpointIsLocal && sentCount > 0) {
		issues.push(`${sentCount} always-remembered file(s) are being sent to a remote model endpoint on every request.`)
	}
	return issues
}

export async function addAlwaysRememberedEntry(
	entries: readonly string[],
	rawPath: string,
	workspaceRoot: string,
): Promise<AlwaysRememberedEditResult> {
	const entry = rawPath.trim()
	const unchanged = [...entries]
	if (!entry) {
		return { entries: unchanged, error: "Enter a file path." }
	}
	const resolvedPath = resolveAlwaysRememberedPath(entry, workspaceRoot)
	const canonical = await canonicalPath(resolvedPath)
	if (isRefusedSecretsFile(resolvedPath) || isRefusedSecretsFile(canonical)) {
		return { entries: unchanged, error: `Refused: ${basename(resolvedPath)} is a secrets file.` }
	}
	try {
		const info = await stat(resolvedPath)
		if (!info.isFile()) {
			return { entries: unchanged, error: `${entry} is not a file.` }
		}
	} catch {
		return { entries: unchanged, error: `File not found: ${entry}` }
	}
	for (const existing of entries) {
		if ((await canonicalPath(resolveAlwaysRememberedPath(existing, workspaceRoot))) === canonical) {
			return { entries: unchanged, error: `${entry} is already on the list.` }
		}
	}
	return { entries: [...entries, entry] }
}

export function removeAlwaysRememberedEntry(entries: readonly string[], entry: string): string[] {
	return entries.filter((existing) => existing !== entry)
}

export function moveAlwaysRememberedEntry(entries: readonly string[], entry: string, delta: number): string[] {
	const next = [...entries]
	const from = next.indexOf(entry)
	const to = from + Math.sign(delta)
	if (from < 0 || to < 0 || to >= next.length) {
		return next
	}
	next.splice(from, 1)
	next.splice(to, 0, entry)
	return next
}

export interface AlwaysRememberedExtensionOptions {
	cwd: string
	endpointIsLocal: boolean
	compactionTriggerTokens?: number
	emitWarning: (text: string, sessionId: string | undefined) => void
}

/**
 * Registers one system-prompt rule. The orchestrator calls its content at the
 * start of every run, so list and file edits apply from the next message.
 */
export function createAlwaysRememberedFilesExtension(
	options: AlwaysRememberedExtensionOptions,
): NonNullable<CoreSessionConfig["extensions"]>[number] {
	let lastWarning = ""
	return {
		name: "cline-always-remembered-files",
		manifest: { capabilities: ["rules"] },
		setup(api, context) {
			const sessionId = context.session?.sessionId
			const warnOnChange = (warning: string) => {
				if (warning && warning !== lastWarning) {
					options.emitWarning(warning, sessionId)
				}
				lastWarning = warning
			}
			api.registerRule({
				id: "cline-always-remembered-files:rules",
				source: "always-remembered-files",
				content: async () => {
					try {
						const entries = readAlwaysRememberedFilesGlobally()
						if (entries.length === 0) {
							warnOnChange("")
							return ""
						}
						const files = await loadAlwaysRememberedFiles(entries, {
							workspaceRoot: options.cwd,
							ruleSearchPaths: resolveRulesConfigSearchPaths(options.cwd),
						})
						const issues = describeAlwaysRememberedIssues(files, options)
						for (const issue of issues) {
							Logger.warn(`[AlwaysRememberedFiles] ${issue}`)
						}
						warnOnChange(issues.join("\n"))
						return buildAlwaysRememberedPrompt(files)
					} catch (error) {
						Logger.error("[AlwaysRememberedFiles] Failed to build the always-remembered block:", error)
						warnOnChange("Always-remembered files could not be loaded for this message. Check Settings → Features.")
						return ""
					}
				},
			})
		},
	}
}
