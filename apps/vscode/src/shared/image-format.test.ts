import { describe, expect, it } from "vitest"
import { hasImageExtension, isAnimatedGif, sniffImageFormat } from "./image-format"

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

describe("sniffImageFormat", () => {
	it.each([
		["png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
		["jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
		["webp", text("RIFF\0\0\0\0WEBPVP8 ")],
		["gif", text("GIF89a")],
		["bmp", text("BM\xca\0")],
		["ico", bytes(0, 0, 1, 0, 1, 0)],
		["cur", bytes(0, 0, 2, 0, 1, 0)],
		["tiff", bytes(0x4d, 0x4d, 0, 0x2a)],
		["tiff", bytes(0x49, 0x49, 0x2a, 0)],
		["heic", bytes(0, 0, 0, 0x28, ...text("ftypheic"))],
		["heic", bytes(0, 0, 0, 0x18, ...text("ftypmif1"))],
		["avif", bytes(0, 0, 0, 0x20, ...text("ftypavif"))],
		["jp2", bytes(0, 0, 0, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a)],
		["psd", text("8BPS\0\x01")],
		["exr", bytes(0x76, 0x2f, 0x31, 0x01)],
		["jxl", bytes(0xff, 0x0a, 0x01)],
		["svg", text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')],
		["svg", text("  <svg width='1'/>")],
	])("identifies %s from its bytes", (format, input) => {
		expect(sniffImageFormat(input)).toBe(format)
	})

	it("does not call a PDF or plain text an image", () => {
		expect(sniffImageFormat(text("%PDF-1.3"))).toBeUndefined()
		expect(sniffImageFormat(text("hello"))).toBeUndefined()
	})
})

describe("isAnimatedGif", () => {
	const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0x44, 0]
	const gif = (...frames: number[][]) => bytes(...text("GIF89a"), 1, 0, 1, 0, 0, 0, 0, ...frames.flat(), 0x3b)

	it("is false for one frame and true for two", () => {
		expect(isAnimatedGif(gif(frame))).toBe(false)
		expect(isAnimatedGif(gif(frame, frame))).toBe(true)
	})
})

describe("hasImageExtension", () => {
	it("recognizes image names in any case and rejects others", () => {
		expect(hasImageExtension("Photo.HEIC")).toBe(true)
		expect(hasImageExtension("imagebmp 2.bmp")).toBe(true)
		expect(hasImageExtension("notes.txt")).toBe(false)
		expect(hasImageExtension("bmp")).toBe(false)
	})
})
