import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readFile, readlink, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Logger } from "@/shared/services/Logger"

const CARRIED_OVER_KEY = "legacyGlobalFolderCarriedOver"
const LEGACY_FOLDER_SEGMENTS = ["Webwork", "cline-cubed", "Cline"]
const CARRIED_FOLDERS = ["Rules", "Workflows", "Hooks", "Agents"]
const IGNORED_NAMES = new Set([".DS_Store"])

export interface LegacyCarryOverResult {
	copied: string[]
	identical: string[]
	conflicts: string[]
	failures: string[]
}

export interface LegacyCarryOverState {
	get<T>(key: string): T | undefined
	update(key: string, value: unknown): PromiseLike<void>
}

function isAlreadyExists(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "EEXIST"
}

async function isSameEntry(source: string, target: string, sourceIsLink: boolean): Promise<boolean> {
	const targetInfo = await lstat(target)
	if (sourceIsLink) {
		return targetInfo.isSymbolicLink() && (await readlink(source)) === (await readlink(target))
	}
	return targetInfo.isFile() && (await readFile(source)).equals(await readFile(target))
}

async function carryEntry(source: string, target: string, relativePath: string, result: LegacyCarryOverResult): Promise<void> {
	try {
		await mkdir(dirname(target), { recursive: true })
		const isLink = (await lstat(source)).isSymbolicLink()
		try {
			if (isLink) {
				await symlink(await readlink(source), target)
			} else {
				await copyFile(source, target, constants.COPYFILE_EXCL)
			}
			result.copied.push(relativePath)
		} catch (error) {
			if (!isAlreadyExists(error)) {
				throw error
			}
			const list = (await isSameEntry(source, target, isLink)) ? result.identical : result.conflicts
			list.push(relativePath)
		}
	} catch (error) {
		Logger.error(`[LegacyGlobalFolder] Failed to copy ${relativePath}:`, error)
		result.failures.push(relativePath)
	}
}

async function carryFolder(
	sourceDir: string,
	targetDir: string,
	relativeDir: string,
	result: LegacyCarryOverResult,
): Promise<void> {
	let entries: import("node:fs").Dirent[]
	try {
		entries = await readdir(sourceDir, { withFileTypes: true })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			Logger.error(`[LegacyGlobalFolder] Failed to read ${relativeDir}:`, error)
			result.failures.push(relativeDir)
		}
		return
	}
	entries.sort((a, b) => a.name.localeCompare(b.name))
	for (const entry of entries) {
		if (IGNORED_NAMES.has(entry.name)) {
			continue
		}
		const source = join(sourceDir, entry.name)
		const target = join(targetDir, entry.name)
		const relativePath = `${relativeDir}/${entry.name}`
		if (entry.isDirectory()) {
			await carryFolder(source, target, relativePath, result)
		} else {
			await carryEntry(source, target, relativePath, result)
		}
	}
}

/** Copy files from the earlier global folder. Never overwrites and never removes anything. */
export async function carryOverLegacyGlobalFolder(documentsPath: string): Promise<LegacyCarryOverResult> {
	const result: LegacyCarryOverResult = { copied: [], identical: [], conflicts: [], failures: [] }
	const legacyRoot = join(documentsPath, ...LEGACY_FOLDER_SEGMENTS)
	const globalRoot = join(documentsPath, "Cline")
	for (const folder of CARRIED_FOLDERS) {
		await carryFolder(join(legacyRoot, folder), join(globalRoot, folder), folder, result)
	}
	return result
}

/** Runs the carry-over once per install. A failed run is not recorded, so it retries on the next start. */
export async function runLegacyGlobalFolderCarryOver(
	state: LegacyCarryOverState,
	documentsPath: string,
	notify: (message: string) => void,
): Promise<void> {
	if (state.get<boolean>(CARRIED_OVER_KEY)) {
		return
	}
	const result = await carryOverLegacyGlobalFolder(documentsPath)
	const legacyRoot = join(documentsPath, ...LEGACY_FOLDER_SEGMENTS)
	const globalRoot = join(documentsPath, "Cline")
	const problems: string[] = []
	if (result.conflicts.length > 0) {
		problems.push(
			`Not copied to ${globalRoot} because a different file with the same name is already there: ${result.conflicts.join(", ")}.`,
		)
	}
	if (result.failures.length > 0) {
		problems.push(`Could not be copied to ${globalRoot}, and will be retried: ${result.failures.join(", ")}.`)
	}
	if (problems.length > 0) {
		notify(`${problems.join(" ")} The originals are still in ${legacyRoot}.`)
	}
	if (result.failures.length === 0) {
		await state.update(CARRIED_OVER_KEY, true)
	}
}
