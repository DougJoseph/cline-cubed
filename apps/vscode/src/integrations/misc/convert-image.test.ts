import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { deflateSync } from "node:zlib"
import { afterAll, describe, expect, it } from "vitest"
import { convertImageBytesToPng } from "./convert-image"

const dir = mkdtempSync(path.join(tmpdir(), "convert-image-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function crc(buffer: Buffer): number {
	let c = 0xffffffff
	for (const byte of buffer) {
		c ^= byte
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
	}
	return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
	const typed = Buffer.concat([Buffer.from(type), data])
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const sum = Buffer.alloc(4)
	sum.writeUInt32BE(crc(typed))
	return Buffer.concat([length, typed, sum])
}
function samplePng(): Buffer {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(4, 0)
	header.writeUInt32BE(4, 4)
	header[8] = 8
	header[9] = 6
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0x80)])
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat([row, row, row, row]))),
		chunk("IEND", Buffer.alloc(0)),
	])
}

describe.runIf(process.platform === "darwin")("convertImageBytesToPng on macOS", () => {
	it.each(["tiff", "heic", "jp2", "psd", "tga", "exr", "bmp", "gif"])("converts a real %s file to PNG", async (format) => {
		const input = path.join(dir, "in.png")
		const output = path.join(dir, `out.${format}`)
		writeFileSync(input, samplePng())
		execFileSync("/usr/bin/sips", ["-s", "format", format, input, "--out", output], { stdio: "ignore" })

		const result = await convertImageBytesToPng(`sample.${format}`, readFileSync(output))

		expect(result.dataUrl?.startsWith("data:image/png;base64,iVBORw0KGgo")).toBe(true)
	})

	it("reports a file it cannot read", async () => {
		const result = await convertImageBytesToPng("broken.heic", Buffer.from("this is not an image"))

		expect(result).toEqual({ error: "unreadable" })
	})

	it("treats a hostile filename as data", async () => {
		const result = await convertImageBytesToPng("../../$(touch pwned);.tiff", Buffer.from("no"))

		expect(result).toEqual({ error: "unreadable" })
	})
})

describe("convertImageBytesToPng limits", () => {
	it("refuses a file over the size limit before running anything", async () => {
		const result = await convertImageBytesToPng("huge.tiff", Buffer.alloc(20 * 1024 * 1024 + 1))

		expect(result).toEqual({ error: "too-large" })
	})

	it("reports that conversion needs macOS on other systems", async () => {
		const result = await convertImageBytesToPng("a.heic", Buffer.from("x"), "linux")

		expect(result).toEqual({ error: "needs-macos" })
	})
})
