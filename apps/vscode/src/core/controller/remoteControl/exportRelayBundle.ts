import { existsSync } from "node:fs"
import * as path from "node:path"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { RelayBundleExportResult } from "@shared/proto/cline/remote_control"
import { getDocumentsPath } from "@/core/storage/documents-path"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { createInstallToken, RELAY_INSTALLER_FILES, writeRelayInstallerFiles } from "../../relay/relayBundle"
import type { Controller } from ".."

/** The reveal button, named the way the platform names it. */
function revealLabel(): string {
	if (process.platform === "darwin") return "Show in Finder"
	if (process.platform === "win32") return "Show in File Explorer"
	return "Show in Folder"
}

/**
 * Write the relay installer, `index.php`, and its instructions, `INSTALL.txt`, into a folder the user
 * chooses. The extension never chooses a location. A cancelled dialog, or a declined replace, writes
 * nothing. When the files are written, INSTALL.txt opens in an editor, and a notice names both files
 * and offers to show them in the file manager.
 */
export async function exportRelayBundle(_controller: Controller, _request: EmptyRequest): Promise<RelayBundleExportResult> {
	const version = ExtensionRegistryInfo.version
	const cancelled: RelayBundleExportResult = { path: "", files: [], version, error: "cancelled", installToken: "" }
	const { paths } = await HostProvider.window.showOpenDialogue({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		openLabel: "Save installer here",
		defaultPath: await getDocumentsPath(),
	})
	const folder = paths[0]
	if (!folder) {
		return cancelled
	}

	const existing = RELAY_INSTALLER_FILES.filter((name) => existsSync(path.join(folder, name)))
	if (existing.length > 0) {
		const { selectedOption } = await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: `${existing.join(" and ")} already ${existing.length === 1 ? "exists" : "exist"} in ${folder}. Replace ${existing.length === 1 ? "it" : "them"}?`,
			options: { modal: true, items: ["Replace"] },
		})
		if (selectedOption !== "Replace") {
			return cancelled
		}
	}

	const installToken = createInstallToken()
	try {
		const files = writeRelayInstallerFiles(folder, version, installToken)
		// The instructions on screen right away.
		await HostProvider.window.openFile({ filePath: files[1] }).catch((error) => {
			Logger.error(`Could not open INSTALL.txt: ${error instanceof Error ? error.message : String(error)}`)
		})
		const reveal = revealLabel()
		void HostProvider.window
			.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `Relay installer saved: index.php and INSTALL.txt in ${folder}`,
				options: { items: [reveal] },
			})
			.then(({ selectedOption }) => {
				if (selectedOption === reveal) {
					void HostProvider.window.revealFileInOs({ filePath: files[0] })
				}
			})
		return { path: folder, files, version, error: "", installToken }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`Failed to save the relay installer: ${message}`)
		return { path: "", files: [], version, error: message, installToken: "" }
	}
}
