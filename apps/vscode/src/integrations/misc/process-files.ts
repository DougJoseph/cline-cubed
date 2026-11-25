import { MAX_CONVERTIBLE_IMAGE_BYTES } from "@integrations/misc/convert-image"
import { hasImageExtension, IMAGE_FILE_EXTENSIONS } from "@shared/image-format"
import fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"

/**
 * Supports processing of images and other file types
 * For models which don't support images, will not allow them to be selected
 */
export async function selectFiles(imagesAllowed: boolean): Promise<{ images: string[]; files: string[] }> {
	const OTHER_FILE_EXTENSIONS = ["xml", "json", "txt", "log", "md", "docx", "ipynb", "pdf", "xlsx", "csv"]

	const showDialogueResponse = await HostProvider.window.showOpenDialogue({
		canSelectMany: true,
		openLabel: "Select",
		filters: {
			files: imagesAllowed ? [...IMAGE_FILE_EXTENSIONS, ...OTHER_FILE_EXTENSIONS] : OTHER_FILE_EXTENSIONS,
		},
	})

	const filePaths = showDialogueResponse.paths

	if (!filePaths || filePaths.length === 0) {
		return { images: [], files: [] }
	}

	const processFilesPromises = filePaths.map(async (filePath) => {
		if (hasImageExtension(filePath)) {
			try {
				const stats = await fs.stat(filePath)
				if (stats.size > MAX_CONVERTIBLE_IMAGE_BYTES) {
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Image too large: ${path.basename(filePath)} was skipped (size exceeds 20MB).`,
					})
					return null
				}
				const buffer = await fs.readFile(filePath)
				// The chat's image intake identifies, converts, and size-checks it, using this name in any message.
				const name = encodeURIComponent(path.basename(filePath))
				return { type: "image", data: `data:application/octet-stream;name=${name};base64,${buffer.toString("base64")}` }
			} catch (error) {
				Logger.error(`Error reading image ${filePath}:`, error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Could not read ${path.basename(filePath)}, skipping.`,
				})
				return null
			}
		}
		// for standard models we will check the size of the file to ensure its not too large
		try {
			const stats = await fs.stat(filePath)
			if (stats.size > 20 * 1000 * 1024) {
				Logger.warn(`File too large, skipping: ${filePath}`)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `File too large: ${path.basename(filePath)} was skipped (size exceeds 20MB).`,
				})
				return null
			}
		} catch (error) {
			Logger.error(`Error checking file size for ${filePath}:`, error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Could not check file size for ${path.basename(filePath)}, skipping.`,
			})
			return null
		}
		return { type: "file", data: filePath }
	})

	const dataUrlsWithNulls = await Promise.all(processFilesPromises)
	const dataUrlsWithoutNulls = dataUrlsWithNulls.filter((item) => item !== null)

	const images: string[] = []
	const files: string[] = []

	for (const item of dataUrlsWithoutNulls) {
		if (item.type === "image") {
			images.push(item.data)
		} else {
			files.push(item.data)
		}
	}

	return { images, files }
}
