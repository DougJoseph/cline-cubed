import { describe, expect, it } from "vitest";
import {
	estimateRequestInputTokens,
	resolveMeasuredRequestInputTokens,
	serializeForTokenEstimate,
} from "./tokens";

const IMAGE_DATA = "A".repeat(300_000);

describe("serializeForTokenEstimate", () => {
	it("matches JSON.stringify for content without image data", () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
		};

		expect(serializeForTokenEstimate(message)).toBe(JSON.stringify(message));
	});

	it("omits stored image data and keeps surrounding text", () => {
		const serialized = serializeForTokenEstimate({
			role: "user",
			content: [
				{ type: "text", text: "describe this" },
				{ type: "image", data: IMAGE_DATA, mediaType: "image/png" },
			],
		});

		expect(serialized).toContain("describe this");
		expect(serialized).not.toContain("AAAA");
	});

	it("omits runtime image parts and images nested in tool results", () => {
		const serialized = serializeForTokenEstimate({
			role: "user",
			content: [
				{ type: "image", image: IMAGE_DATA, mediaType: "image/png" },
				{
					type: "tool_result",
					tool_use_id: "tool-1",
					content: [
						{ type: "text", text: "tool text" },
						{ type: "image", data: IMAGE_DATA, mediaType: "image/png" },
					],
				},
			],
		});

		expect(serialized).toContain("tool text");
		expect(serialized).not.toContain("AAAA");
	});

	it("omits the base64 source of model-generated media", () => {
		const serialized = serializeForTokenEstimate({
			role: "assistant",
			content: [
				{
					type: "media",
					media: {
						id: "media-1",
						modality: "image",
						mediaType: "image/png",
						source: { type: "base64", data: IMAGE_DATA },
					},
				},
			],
		});

		expect(serialized).toContain("media-1");
		expect(serialized).not.toContain("AAAA");
	});

	it("omits image data when the value is circular", () => {
		const circular: Record<string, unknown> = {
			type: "image",
			data: IMAGE_DATA,
		};
		const holder: Record<string, unknown> = { circular, text: "kept" };
		holder.self = holder;

		const estimated = estimateRequestInputTokens({
			messages: [holder],
		});

		expect(estimated).toBeLessThan(1_000);
	});
});

describe("resolveMeasuredRequestInputTokens", () => {
	const reported = {
		role: "assistant",
		content: "answer",
		modelInfo: { id: "local-model", provider: "openai-compatible" },
		metrics: { inputTokens: 100_000, outputTokens: 500 },
	};

	it("adds the reported output to the reported input", () => {
		expect(
			resolveMeasuredRequestInputTokens({
				messages: [{ role: "user", content: "hi" }, reported],
				modelId: "local-model",
			}),
		).toBe(100_500);
	});

	it("adds an estimate of only the messages after the reported request", () => {
		const later = { role: "user", content: "x".repeat(3_000) };

		expect(
			resolveMeasuredRequestInputTokens({
				messages: [reported, later],
				modelId: "local-model",
			}),
		).toBe(100_500 + estimateRequestInputTokens({ messages: [later] }));
	});

	it("charges nothing for image data added after the reported request", () => {
		const later = {
			role: "user",
			content: [{ type: "image", data: IMAGE_DATA, mediaType: "image/png" }],
		};

		const measured = resolveMeasuredRequestInputTokens({
			messages: [reported, later],
			modelId: "local-model",
		});

		expect(measured).toBeLessThan(100_600);
	});

	it("estimates the reported message when the server gave no output count", () => {
		const noOutput = { ...reported, metrics: { inputTokens: 100_000 } };

		expect(
			resolveMeasuredRequestInputTokens({
				messages: [noOutput],
				modelId: "local-model",
			}),
		).toBe(100_000 + estimateRequestInputTokens({ messages: [noOutput] }));
	});

	it("uses the newest assistant message that carries usage", () => {
		const older = {
			...reported,
			metrics: { inputTokens: 5, outputTokens: 5 },
		};
		const withoutUsage = { role: "assistant", content: "no usage" };

		const measured = resolveMeasuredRequestInputTokens({
			messages: [older, reported, withoutUsage],
			modelId: "local-model",
		});

		expect(measured).toBe(
			100_500 + estimateRequestInputTokens({ messages: [withoutUsage] }),
		);
	});

	it("returns undefined when no message carries usage", () => {
		expect(
			resolveMeasuredRequestInputTokens({
				messages: [{ role: "assistant", content: "no usage" }],
				modelId: "local-model",
			}),
		).toBeUndefined();
	});

	it("returns undefined when the usage came from a different model", () => {
		expect(
			resolveMeasuredRequestInputTokens({
				messages: [reported],
				modelId: "another-model",
			}),
		).toBeUndefined();
	});

	it("returns undefined when the usage has no model identity", () => {
		const { modelInfo: _modelInfo, ...anonymous } = reported;

		expect(
			resolveMeasuredRequestInputTokens({
				messages: [anonymous],
				modelId: "local-model",
			}),
		).toBeUndefined();
	});

	it("returns undefined when the reported input is not positive", () => {
		expect(
			resolveMeasuredRequestInputTokens({
				messages: [{ ...reported, metrics: { inputTokens: 0 } }],
				modelId: "local-model",
			}),
		).toBeUndefined();
	});
});
