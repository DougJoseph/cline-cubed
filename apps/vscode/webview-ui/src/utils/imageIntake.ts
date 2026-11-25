import {
	hasImageExtension,
	isAnimatedGif,
	MAX_IMAGE_DIMENSION,
	SENDABLE_IMAGE_MIME_TYPES,
	sniffImageFormat,
} from "@shared/image-format"
import { ConvertImageRequest } from "@shared/proto/cline/file"
import { useSyncExternalStore } from "react"
import { FileServiceClient } from "@/services/grpc-client"

export type ImageIntakeResult = { ok: true; dataUrl: string; notice?: string } | { ok: false; message: string }

export interface ImageIntakeDeps {
	readDimensions: (dataUrl: string) => Promise<{ width: number; height: number }>
	/** Resolves to a PNG data URL, or null when the browser engine cannot decode the image. */
	decodeToPng: (dataUrl: string) => Promise<string | null>
	convertOnHost: (name: string, base64: string) => Promise<{ dataUrl?: string; error?: string }>
}

function toBase64(bytes: Uint8Array): string {
	let binary = ""
	const chunkSize = 0x8000
	for (let index = 0; index < bytes.length; index += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
	}
	return btoa(binary)
}

function fromBase64(base64: string): Uint8Array {
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index)
	}
	return bytes
}

function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
	return new Promise((resolve) => {
		const image = new Image()
		image.onload = () => resolve(image)
		image.onerror = () => resolve(null)
		image.src = dataUrl
	})
}

const browserDeps: ImageIntakeDeps = {
	readDimensions: async (dataUrl) => {
		const image = await loadImage(dataUrl)
		if (!image) {
			throw new Error("The image could not be decoded.")
		}
		return { width: image.naturalWidth, height: image.naturalHeight }
	},
	decodeToPng: async (dataUrl) => {
		// An image element never runs the scripts an SVG may contain.
		const image = await loadImage(dataUrl)
		if (!image || image.naturalWidth === 0 || image.naturalHeight === 0) {
			return null
		}
		if (image.naturalWidth > MAX_IMAGE_DIMENSION || image.naturalHeight > MAX_IMAGE_DIMENSION) {
			return dataUrl
		}
		const canvas = document.createElement("canvas")
		canvas.width = image.naturalWidth
		canvas.height = image.naturalHeight
		const context = canvas.getContext("2d")
		if (!context) {
			return null
		}
		context.drawImage(image, 0, 0)
		try {
			return canvas.toDataURL("image/png")
		} catch (error) {
			console.error("Could not convert an image to PNG:", error)
			return null
		}
	},
	convertOnHost: (name, base64) => FileServiceClient.convertImageToPng(ConvertImageRequest.create({ name, base64 })),
}

const BROWSER_DECODE_MIME_TYPES: Record<string, string> = {
	gif: "image/gif",
	bmp: "image/bmp",
	ico: "image/x-icon",
	cur: "image/x-icon",
	avif: "image/avif",
	svg: "image/svg+xml",
}

function hostErrorMessage(name: string, error: string | undefined, knownImage: boolean): string {
	if (error === "needs-macos") return `Couldn't attach ${name}: converting this image type needs macOS.`
	if (error === "too-large") return `Couldn't attach ${name}: the file is larger than 20 MB.`
	return knownImage
		? `Couldn't attach ${name}: the image could not be read.`
		: `Couldn't attach ${name}: this image type can't be converted.`
}

/** The one path every image takes into the chat: it arrives sendable, or the result names why not. */
export async function intakeImage(
	input: { name: string; bytes: Uint8Array },
	deps: ImageIntakeDeps = browserDeps,
): Promise<ImageIntakeResult> {
	const { name, bytes } = input
	const format = sniffImageFormat(bytes)
	const knownImage = format !== undefined || hasImageExtension(name)
	const base64 = toBase64(bytes)
	const sendableMime = format ? SENDABLE_IMAGE_MIME_TYPES[format] : undefined

	let dataUrl: string | null = sendableMime ? `data:${sendableMime};base64,${base64}` : null
	if (!dataUrl && format && BROWSER_DECODE_MIME_TYPES[format]) {
		dataUrl = await deps.decodeToPng(`data:${BROWSER_DECODE_MIME_TYPES[format]};base64,${base64}`).catch(() => null)
	} else if (!dataUrl) {
		dataUrl = await deps.decodeToPng(`data:application/octet-stream;base64,${base64}`).catch(() => null)
	}
	if (!dataUrl) {
		let converted: { dataUrl?: string; error?: string }
		try {
			converted = await deps.convertOnHost(name, base64)
		} catch (error) {
			console.error(`Could not convert ${name}:`, error)
			return { ok: false, message: hostErrorMessage(name, undefined, knownImage) }
		}
		if (!converted.dataUrl) {
			return { ok: false, message: hostErrorMessage(name, converted.error, knownImage) }
		}
		dataUrl = converted.dataUrl
	}

	let dimensions: { width: number; height: number }
	try {
		dimensions = await deps.readDimensions(dataUrl)
	} catch {
		return { ok: false, message: `Couldn't attach ${name}: the image could not be read.` }
	}
	if (dimensions.width > MAX_IMAGE_DIMENSION || dimensions.height > MAX_IMAGE_DIMENSION) {
		return { ok: false, message: `Couldn't attach ${name}: its dimensions exceed ${MAX_IMAGE_DIMENSION}px.` }
	}
	if (format === "gif" && isAnimatedGif(bytes)) {
		return { ok: true, dataUrl, notice: `${name} is animated, so only its first frame was attached.` }
	}
	return { ok: true, dataUrl }
}

function collect(results: ImageIntakeResult[]): { images: string[]; notices: string[] } {
	const images: string[] = []
	const notices: string[] = []
	for (const result of results) {
		if (result.ok) {
			images.push(result.dataUrl)
			if (result.notice) notices.push(result.notice)
		} else {
			notices.push(result.message)
		}
	}
	return { images, notices }
}

export async function intakeFiles(files: File[], deps: ImageIntakeDeps = browserDeps) {
	const results = await Promise.all(
		files.map(async (file) => {
			try {
				return await intakeImage({ name: file.name || "image", bytes: new Uint8Array(await file.arrayBuffer()) }, deps)
			} catch (error) {
				console.error(`Could not read ${file.name}:`, error)
				return { ok: false as const, message: `Couldn't attach ${file.name || "image"}: the image could not be read.` }
			}
		}),
	)
	return collect(results)
}

/** The file picker hands over data URLs that carry the file's name. */
export async function intakeDataUrls(urls: string[], deps: ImageIntakeDeps = browserDeps) {
	const results = await Promise.all(
		urls.map((url) => {
			const match = /^data:[^;,]*(?:;name=([^;,]*))?;base64,(.*)$/s.exec(url)
			const name = match?.[1] ? decodeURIComponent(match[1]) : "image"
			if (!match) {
				return { ok: false as const, message: `Couldn't attach ${name}: the image could not be read.` }
			}
			return intakeImage({ name, bytes: fromBase64(match[2]) }, deps)
		}),
	)
	return collect(results)
}

const FORMAT_PREFERENCE = ["image/png", "image/jpeg", "image/webp"]
const preference = (file: File) => {
	const index = FORMAT_PREFERENCE.indexOf(file.type)
	return index === -1 ? FORMAT_PREFERENCE.length : index
}

/**
 * The image files in a paste or drop. A clipboard can offer one picture in several formats under
 * one name, so each name keeps its most widely accepted format.
 */
export function pickImageFiles(files: File[]): File[] {
	const byName = new Map<string, File>()
	for (const file of files) {
		if (!file.type.startsWith("image/") && !hasImageExtension(file.name)) {
			continue
		}
		const key = file.name.replace(/\.[^.]+$/, "").toLowerCase()
		const existing = byName.get(key)
		if (!existing || preference(file) < preference(existing)) {
			byName.set(key, file)
		}
	}
	return [...byName.values()]
}

let notices: string[] = []
const listeners = new Set<() => void>()
const publish = (next: string[]) => {
	notices = next
	for (const listener of listeners) listener()
}

/** Each chat is its own webview, so this list belongs to one chat. */
export function reportImageIntakeNotices(next: string[]): void {
	if (next.length > 0) {
		publish(next)
	}
}

export const dismissImageIntakeNotices = () => publish([])

export function useImageIntakeNotices(): string[] {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		() => notices,
	)
}
