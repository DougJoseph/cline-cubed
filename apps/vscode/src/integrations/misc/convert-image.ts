import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Logger } from "@/shared/services/Logger"

const execFileAsync = promisify(execFile)
const SIPS_PATH = "/usr/bin/sips"
const SIPS_TIMEOUT_MS = 30_000
export const MAX_CONVERTIBLE_IMAGE_BYTES = 20 * 1024 * 1024

export type ImageConversionError = "needs-macos" | "too-large" | "unreadable"
export type ImageConversionResult = { dataUrl: string; error?: undefined } | { dataUrl?: undefined; error: ImageConversionError }

/**
 * Converts an image the webview's browser engine cannot decode (HEIC, TIFF, camera RAW, and others)
 * to PNG with macOS `sips`. It runs on a private temporary copy with no shell, and the file's own
 * name contributes only a sanitized extension.
 */
export async function convertImageBytesToPng(
	name: string,
	bytes: Uint8Array,
	platform: NodeJS.Platform = process.platform,
): Promise<ImageConversionResult> {
	if (bytes.byteLength > MAX_CONVERTIBLE_IMAGE_BYTES) {
		return { error: "too-large" }
	}
	if (platform !== "darwin") {
		return { error: "needs-macos" }
	}

	const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? "img"
	const directory = await mkdtemp(path.join(tmpdir(), "cline-image-"))
	try {
		const input = path.join(directory, `input.${extension}`)
		const output = path.join(directory, "output.png")
		await writeFile(input, bytes)
		await execFileAsync(SIPS_PATH, ["-s", "format", "png", input, "--out", output], { timeout: SIPS_TIMEOUT_MS })
		const png = await readFile(output)
		return { dataUrl: `data:image/png;base64,${png.toString("base64")}` }
	} catch (error) {
		Logger.error(`Could not convert image ${path.basename(name)}:`, error)
		return { error: "unreadable" }
	} finally {
		await rm(directory, { recursive: true, force: true }).catch((error) =>
			Logger.error("Could not remove the temporary image folder:", error),
		)
	}
}
