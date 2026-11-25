import { describe, expect, it, vi } from "vitest"
import { createImageDescriber } from "./image-descriptions-extension"

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
