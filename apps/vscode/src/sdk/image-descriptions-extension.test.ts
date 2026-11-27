import { describe, expect, it, vi } from "vitest"
import { createImageDescriber, mainModelDescribesInReply } from "./image-descriptions-extension"

const image = { type: "image" as const, data: "AAAA", mediaType: "image/png" }

function describer(overrides: {
	order?: "imageModeFirst" | "mainModelFirst"
	imageModeSet?: boolean
	mainSees?: "yes" | "no" | "unknown"
	bridge?: () => Promise<string>
	main?: () => Promise<string>
}) {
	const bridge = vi.fn(overrides.bridge ?? (async () => "from image mode"))
	const main = vi.fn(overrides.main ?? (async () => "from main model"))
	const describe = createImageDescriber({
		order: () => overrides.order ?? "imageModeFirst",
		imageMode: () => (overrides.imageModeSet === false ? undefined : { provider: "deepseek", modelId: "vision-x" }),
		mainModelSeesImages: () => overrides.mainSees ?? "yes",
		mainModelName: () => "qwen",
		describeWithImageMode: bridge,
		describeWithMainModel: main,
	})
	return { describe, bridge, main }
}

describe("createImageDescriber", () => {
	it("uses the Image Mode model first by default", async () => {
		const { describe, main } = describer({})
		expect(await describe(image)).toEqual({ description: "from image mode", describedBy: "the Image Mode model (vision-x)" })
		expect(main).not.toHaveBeenCalled()
	})

	it("uses the main model first when chosen", async () => {
		const { describe, bridge } = describer({ order: "mainModelFirst" })
		expect(await describe(image)).toEqual({ description: "from main model", describedBy: "the main model (qwen)" })
		expect(bridge).not.toHaveBeenCalled()
	})

	it("falls back to the other model when the first is not set", async () => {
		const { describe } = describer({ imageModeSet: false })
		expect((await describe(image))?.describedBy).toBe("the main model (qwen)")
	})

	it("falls back to the other model when the first fails", async () => {
		const { describe } = describer({
			bridge: async () => {
				throw new Error("down")
			},
		})
		expect((await describe(image))?.describedBy).toBe("the main model (qwen)")
	})

	it("does not use a main model that cannot see images, or whose capability is unknown", async () => {
		expect(await describer({ imageModeSet: false, mainSees: "no" }).describe(image)).toBeUndefined()
		expect(await describer({ imageModeSet: false, mainSees: "unknown" }).describe(image)).toBeUndefined()
	})
})

// Cline Cubed: the main model describes inside its own reply only when earlier images go as
// descriptions and the main model is the describer the user's order picks first.
describe("mainModelDescribesInReply", () => {
	const base = {
		earlierImages: "descriptions" as const,
		order: "mainModelFirst" as const,
		imageModeSet: true,
		mainModelSeesImages: "yes" as const,
	}

	it("is true when the main model is picked first", () => {
		expect(mainModelDescribesInReply(base)).toBe(true)
	})

	it("is true when the Image Mode model comes first but none is set", () => {
		expect(mainModelDescribesInReply({ ...base, order: "imageModeFirst", imageModeSet: false })).toBe(true)
	})

	it("is false when the Image Mode model describes", () => {
		expect(mainModelDescribesInReply({ ...base, order: "imageModeFirst" })).toBe(false)
	})

	it("is false when earlier images go as pictures, or the main model cannot see images", () => {
		expect(mainModelDescribesInReply({ ...base, earlierImages: "pictures" })).toBe(false)
		expect(mainModelDescribesInReply({ ...base, mainModelSeesImages: "unknown" })).toBe(false)
	})
})
