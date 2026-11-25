/** Identifies images from their bytes, because clipboard labels and file extensions can be wrong. */

export type ImageFormat =
	| "png"
	| "jpeg"
	| "webp"
	| "gif"
	| "bmp"
	| "ico"
	| "cur"
	| "tiff"
	| "heic"
	| "avif"
	| "jp2"
	| "psd"
	| "exr"
	| "jxl"
	| "svg"

/** Formats every provider path accepts, sent without conversion. */
export const SENDABLE_IMAGE_MIME_TYPES: Partial<Record<ImageFormat, string>> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
}

export const MAX_IMAGE_DIMENSION = 7500

export const IMAGE_FILE_EXTENSIONS = [
	"png",
	"jpg",
	"jpeg",
	"jpe",
	"webp",
	"gif",
	"bmp",
	"dib",
	"ico",
	"cur",
	"svg",
	"avif",
	"heic",
	"heif",
	"tif",
	"tiff",
	"jp2",
	"j2k",
	"jpx",
	"jxl",
	"psd",
	"tga",
	"exr",
	"hdr",
	"dds",
	"dng",
	"cr2",
	"cr3",
	"crw",
	"nef",
	"nrw",
	"arw",
	"srf",
	"sr2",
	"raf",
	"orf",
	"rw2",
	"pef",
	"srw",
	"raw",
] as const

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
	bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value)

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end))

export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png"
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg"
	if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp"
	if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return "gif"
	if (startsWith(bytes, [0x42, 0x4d])) return "bmp"
	if (startsWith(bytes, [0, 0, 1, 0]) && bytes[4] + bytes[5] > 0) return "ico"
	if (startsWith(bytes, [0, 0, 2, 0]) && bytes[4] + bytes[5] > 0) return "cur"
	if (startsWith(bytes, [0x4d, 0x4d, 0, 0x2a]) || startsWith(bytes, [0x49, 0x49, 0x2a, 0])) return "tiff"
	if (ascii(bytes, 4, 8) === "ftyp") {
		const brand = ascii(bytes, 8, 12)
		if (brand === "avif" || brand === "avis") return "avif"
		if (["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"].includes(brand)) return "heic"
	}
	if (startsWith(bytes, [0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20]) || startsWith(bytes, [0xff, 0x4f, 0xff, 0x51])) return "jp2"
	if (ascii(bytes, 0, 4) === "8BPS") return "psd"
	if (startsWith(bytes, [0x76, 0x2f, 0x31, 0x01])) return "exr"
	if (startsWith(bytes, [0xff, 0x0a]) || startsWith(bytes, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return "jxl"
	const head = new TextDecoder().decode(bytes.subarray(0, 1024)).trimStart()
	if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg"
	return undefined
}

/** Walks the GIF's blocks, so image data that happens to look like a frame marker is not counted. */
export function isAnimatedGif(bytes: Uint8Array): boolean {
	if (bytes.length < 13) return false
	let offset = 13
	if (bytes[10] & 0x80) offset += 3 * 2 ** ((bytes[10] & 0x07) + 1)
	const skipSubBlocks = () => {
		while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1
		offset += 1
	}
	let frames = 0
	while (offset < bytes.length) {
		const block = bytes[offset]
		if (block === 0x3b) break
		if (block === 0x21) {
			offset += 2
			skipSubBlocks()
		} else if (block === 0x2c) {
			frames += 1
			if (frames > 1) return true
			const flags = bytes[offset + 9]
			offset += 10
			if (flags & 0x80) offset += 3 * 2 ** ((flags & 0x07) + 1)
			offset += 1
			skipSubBlocks()
		} else {
			break
		}
	}
	return false
}

export function hasImageExtension(name: string): boolean {
	const match = /\.([a-z0-9]+)$/i.exec(name.trim())
	return Boolean(match) && (IMAGE_FILE_EXTENSIONS as readonly string[]).includes(match![1].toLowerCase())
}
