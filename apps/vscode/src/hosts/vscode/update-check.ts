import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"

/**
 * Cline Cubed: "A newer version, Cline Cubed 4.1.24, is available. Would you like to update?"
 *
 * Runs at activation, only when VS Code's `extensions.autoUpdate` is off — with it on (the
 * default) VS Code installs new versions itself and the What's New notice covers the person.
 * With it off, VS Code never installs the new build, so without this the person never gets it.
 *
 * VS Code's extension API says nothing about newer versions — it reports only what is installed
 * — so the fork asks the Marketplace's `extensionquery` service directly, the same service VS
 * Code uses for its own check. Yes updates in place through `workbench.extensions.installExtension`
 * — VS Code's Update path, which installs the Marketplace's newest, the version the toast named —
 * then offers the reload the new code needs (`extensions.autoRestart` is
 * off by default, so the old code keeps running until the window reloads). Not now dismisses it
 * until the next activation. Any failure — offline, blocked, an answer in an unexpected shape —
 * is logged and shows the person nothing.
 *
 * Verified at the 1.106 floor, 2026-09-03; plan:
 * Docs/2026-09-03_6.34pm_update-notices-whats-new-and-newer-version-available.md (private parent).
 */

const MARKETPLACE_QUERY_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"
const MARKETPLACE_QUERY_TIMEOUT_MS = 10_000
// Marketplace query constants: filterType 7 = by extension name (publisher.name); flags 103 =
// include versions, files, categories, statistics, and asset URIs.
const FILTER_TYPE_EXTENSION_NAME = 7
const QUERY_FLAGS = 103

const YES = "Yes"
const NOT_NOW = "Not now"
const RELOAD_WINDOW = "Reload Window"

/** True when the person has switched VS Code's automatic extension updates off. */
function autoUpdateIsOff(): boolean {
	const value = vscode.workspace.getConfiguration("extensions").get<boolean | string>("autoUpdate")
	// VS Code's own reading: `false` is off, and the legacy value "onlySelectedExtensions" is
	// treated as off too; `true` and "onlyEnabledExtensions" are on (a running extension is enabled).
	return value === false || value === "onlySelectedExtensions"
}

/** Part-by-part numeric comparison of dotted versions; true when `candidate` is newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
	const a = candidate.split(".").map(Number)
	const b = current.split(".").map(Number)
	if (a.some(Number.isNaN) || b.some(Number.isNaN)) {
		return false
	}
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const x = a[i] ?? 0
		const y = b[i] ?? 0
		if (x !== y) {
			return x > y
		}
	}
	return false
}

/** The newest version the Marketplace has published for this extension, or undefined if it cannot say. */
async function newestPublishedVersion(): Promise<string | undefined> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), MARKETPLACE_QUERY_TIMEOUT_MS)
	try {
		const response = await fetch(MARKETPLACE_QUERY_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=3.0-preview.1",
			},
			body: JSON.stringify({
				filters: [
					{
						criteria: [{ filterType: FILTER_TYPE_EXTENSION_NAME, value: ExtensionRegistryInfo.id }],
						pageNumber: 1,
						pageSize: 1,
					},
				],
				flags: QUERY_FLAGS,
			}),
			signal: controller.signal,
		})
		if (!response.ok) {
			throw new Error(`Marketplace answered ${response.status} ${response.statusText}`)
		}
		const body = (await response.json()) as {
			results?: Array<{ extensions?: Array<{ versions?: Array<{ version?: string }> }> }>
		}
		const version = body.results?.[0]?.extensions?.[0]?.versions?.[0]?.version
		if (typeof version !== "string" || version.length === 0) {
			throw new Error("Marketplace answer carried no version")
		}
		return version
	} finally {
		clearTimeout(timeout)
	}
}

export async function offerUpdateWhenAutoUpdateIsOff(): Promise<void> {
	try {
		if (!autoUpdateIsOff()) {
			Logger.debug("Newer-version check skipped: extensions.autoUpdate is on, VS Code updates the extension itself")
			return
		}
		const newest = await newestPublishedVersion()
		const running = ExtensionRegistryInfo.version
		if (!newest || !isNewerVersion(newest, running)) {
			Logger.debug(`Newer-version check: Marketplace newest ${newest ?? "unknown"}, running ${running} — nothing to offer`)
			return
		}
		Logger.debug(`Newer-version check: Marketplace newest ${newest}, running ${running} — offering the update`)
		const answer = await vscode.window.showInformationMessage(
			`A newer version, Cline Cubed ${newest}, is available. Would you like to update?`,
			YES,
			NOT_NOW,
		)
		if (answer !== YES) {
			return
		}
		// The bare id, never `id@version`: for an installed extension VS Code's install command takes
		// its Update path — fetch the Marketplace's newest and replace in place — which is the version
		// the toast just named. The `id@version` form is honored only on the command's branch for an
		// extension disabled by kind; on the ordinary branch the whole string is treated as the id and
		// the Marketplace answers "not found" (proven 2026-09-03 on a real installed 4.1.21).
		await vscode.commands.executeCommand("workbench.extensions.installExtension", ExtensionRegistryInfo.id)
		const reload = await vscode.window.showInformationMessage(
			`Cline Cubed ${newest} is installed. Reload the window to run it.`,
			RELOAD_WINDOW,
		)
		if (reload === RELOAD_WINDOW) {
			await vscode.commands.executeCommand("workbench.action.reloadWindow")
		}
	} catch (error) {
		Logger.error("Newer-version check failed:", error)
	}
}
