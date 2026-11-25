import { describe, expect, it, vi } from "vitest"
import { type ImageIntakeDeps, intakeDataUrls, intakeImage, pickImageFiles } from "./imageIntake"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1])
const BMP = new Uint8Array([0x42, 0x4d, 1, 2])
const HEIC = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 1])
const GIF = (frames: number) => {
	const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 1, 0x44, 0]
	return new Uint8Array([...new TextEncoder().encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0, ...Array(frames).fill(frame).flat(), 0x3b])
}
const CONVERTED = "data:image/png;base64,Y29udmVydGVk"

function deps(overrides: Partial<ImageIntakeDeps> = {}): ImageIntakeDeps {
	return {
		readDimensions: vi.fn(async () => ({ width: 10, height: 10 })),
		decodeToPng: vi.fn(async () => CONVERTED),
		convertOnHost: vi.fn(async () => ({ dataUrl: CONVERTED })),
		...overrides,
	}
}

describe("intakeImage", () => {
	it("passes PNG and JPEG through unchanged, labeled from their bytes", async () => {
		const d = deps()
		const png = await intakeImage({ name: "wrong-label.jpg", bytes: PNG }, d)
		const jpeg = await intakeImage({ name: "a.jpg", bytes: JPEG }, d)

		expect(png).toMatchObject({ ok: true })
		expect(png.ok && png.dataUrl.startsWith("data:image/png;base64,")).toBe(true)
		expect(jpeg.ok && jpeg.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true)
		expect(d.decodeToPng).not.toHaveBeenCalled()
		expect(d.convertOnHost).not.toHaveBeenCalled()
	})

	it("converts a BMP in the webview without calling the host", async () => {
		const d = deps()

		expect(await intakeImage({ name: "imagebmp 2.bmp", bytes: BMP }, d)).toEqual({ ok: true, dataUrl: CONVERTED })
		expect(d.convertOnHost).not.toHaveBeenCalled()
	})

	it("sends what the browser cannot decode to the host", async () => {
		const d = deps({ decodeToPng: vi.fn(async () => null) })

		expect(await intakeImage({ name: "phone.heic", bytes: HEIC }, d)).toEqual({ ok: true, dataUrl: CONVERTED })
		expect(d.convertOnHost).toHaveBeenCalledWith("phone.heic", expect.any(String))
	})

	it("names an animated GIF's first-frame limit", async () => {
		const result = await intakeImage({ name: "loop.gif", bytes: GIF(2) }, deps())

		expect(result).toMatchObject({ ok: true, notice: "loop.gif is animated, so only its first frame was attached." })
	})

	it("adds no notice for a single-frame GIF", async () => {
		const result = await intakeImage({ name: "still.gif", bytes: GIF(1) }, deps())

		expect(result).toEqual({ ok: true, dataUrl: CONVERTED })
	})

	it.each([
		["needs-macos", "Couldn't attach a.heic: converting this image type needs macOS."],
		["too-large", "Couldn't attach a.heic: the file is larger than 20 MB."],
		["unreadable", "Couldn't attach a.heic: the image could not be read."],
	])("names the file when the host reports %s", async (error, message) => {
		const d = deps({ decodeToPng: vi.fn(async () => null), convertOnHost: vi.fn(async () => ({ error })) })

		expect(await intakeImage({ name: "a.heic", bytes: HEIC }, d)).toEqual({ ok: false, message })
	})

	it("refuses an oversized image by name", async () => {
		const d = deps({ readDimensions: vi.fn(async () => ({ width: 8000, height: 10 })) })

		expect(await intakeImage({ name: "big.png", bytes: PNG }, d)).toEqual({
			ok: false,
			message: "Couldn't attach big.png: its dimensions exceed 7500px.",
		})
	})

	it("names a file that is not a known image and cannot be converted", async () => {
		const d = deps({ decodeToPng: vi.fn(async () => null), convertOnHost: vi.fn(async () => ({ error: "unreadable" })) })

		expect(await intakeImage({ name: "photo.xyz", bytes: new Uint8Array([1, 2, 3]) }, d)).toEqual({
			ok: false,
			message: "Couldn't attach photo.xyz: this image type can't be converted.",
		})
	})

	it("reports a host call that fails", async () => {
		const d = deps({
			decodeToPng: vi.fn(async () => null),
			convertOnHost: vi.fn(async () => {
				throw new Error("offline")
			}),
		})

		expect(await intakeImage({ name: "a.heic", bytes: HEIC }, d)).toEqual({
			ok: false,
			message: "Couldn't attach a.heic: the image could not be read.",
		})
	})
})

describe("intakeDataUrls", () => {
	it("reads the name the file picker put in the data URL", async () => {
		const base64 = btoa(String.fromCharCode(...BMP))
		const { images, notices } = await intakeDataUrls(
			[`data:application/octet-stream;name=my%20photo.bmp;base64,${base64}`],
			deps({ decodeToPng: vi.fn(async () => null), convertOnHost: vi.fn(async () => ({ error: "unreadable" })) }),
		)

		expect(images).toEqual([])
		expect(notices).toEqual(["Couldn't attach my photo.bmp: the image could not be read."])
	})
})

describe("pickImageFiles", () => {
	const file = (name: string, type: string) => new File(["x"], name, { type })

	it("keeps images by type or extension and leaves other files alone", () => {
		const picked = pickImageFiles([file("a.bmp", "image/bmp"), file("raw.dng", ""), file("notes.pdf", "application/pdf")])

		expect(picked.map((f) => f.name)).toEqual(["a.bmp", "raw.dng"])
	})

	it("keeps one copy when the clipboard offers the same image in several formats", () => {
		const picked = pickImageFiles([file("image.tiff", "image/tiff"), file("image.png", "image/png")])

		expect(picked.map((f) => f.name)).toEqual(["image.png"])
	})

	it("keeps separate files with different names", () => {
		const picked = pickImageFiles([file("a.png", "image/png"), file("b.bmp", "image/bmp")])

		expect(picked).toHaveLength(2)
	})
})
