import {
	formatMessagesForAiSdk,
	IMAGE_OMITTED_PLACEHOLDER,
	type Message,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { MessageBuilder, omittedImageNotice } from "./message-builder";

function imageData(byteLength: number, fill: number): string {
	return Buffer.alloc(byteLength, fill).toString("base64");
}

function image(data: string) {
	return { type: "image" as const, data, mediaType: "image/png" };
}

function userMessage(...data: string[]): Message {
	return {
		role: "user",
		content: [{ type: "text", text: "see images" }, ...data.map(image)],
	};
}

function assistantMessage(text: string): Message {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function builderWithTotal(maxTotalMediaBytes: number): MessageBuilder {
	return new MessageBuilder({
		mediaBudget: {
			maxImageEncodedBytes: 1_000,
			maxImageDecodedBytes: 1_000,
			maxTotalMediaBytes,
		},
	});
}

function imagesIn(messages: Message[]): string[] {
	return messages.flatMap((message) =>
		Array.isArray(message.content)
			? message.content.flatMap((block) =>
					block.type === "image" ? [block.data] : [],
				)
			: [],
	);
}

const oldest = imageData(30, 1);
const middle = imageData(30, 2);
const newest = imageData(30, 3);

describe("MessageBuilder media budget priority", () => {
	it("keeps a new image when older images already fill the budget", () => {
		const builder = builderWithTotal(80);
		const result = builder.buildForApi([
			userMessage(oldest),
			assistantMessage("one"),
			userMessage(middle),
			assistantMessage("two"),
			userMessage(newest),
		]);

		expect(imagesIn(result)).toEqual([middle, newest]);
		expect(JSON.stringify(result[0])).toContain(IMAGE_OMITTED_PLACEHOLDER);
		expect(builder.getLastOmittedImageCount()).toBe(1);
	});

	it("prefers the first images of a batch inside one message", () => {
		const builder = builderWithTotal(80);
		const result = builder.buildForApi([userMessage(oldest, middle, newest)]);

		expect(imagesIn(result)).toEqual([oldest, middle]);
		expect(builder.getLastOmittedImageCount()).toBe(1);
	});

	it("still fits a smaller older image after a larger one is left out", () => {
		const small = imageData(3, 4);
		const large = imageData(30, 5);
		const builder = builderWithTotal(85);
		const result = builder.buildForApi([
			userMessage(small),
			assistantMessage("one"),
			userMessage(large),
			assistantMessage("two"),
			userMessage(middle),
			assistantMessage("three"),
			userMessage(newest),
		]);

		expect(imagesIn(result)).toEqual([small, middle, newest]);
		expect(builder.getLastOmittedImageCount()).toBe(1);
	});

	it("keeps message order and does not change the stored messages", () => {
		const messages = [
			userMessage(oldest),
			assistantMessage("one"),
			userMessage(newest),
		];
		const before = JSON.stringify(messages);

		const result = builderWithTotal(40).buildForApi(messages);

		expect(result.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		expect(JSON.stringify(messages)).toBe(before);
	});

	it("leaves a request under the budget identical", () => {
		const messages = [
			userMessage(oldest),
			assistantMessage("one"),
			userMessage(newest),
		];
		const builder = builderWithTotal(1_000);

		expect(builder.buildForApi(messages)).toEqual(messages);
		expect(builder.getLastOmittedImageCount()).toBe(0);
	});

	it("passes the selected images through the formatter with nothing further dropped", () => {
		const fourMegabytesEncoded = 3 * 1024 * 1024;
		const first = imageData(fourMegabytesEncoded, 1);
		const second = imageData(fourMegabytesEncoded, 2);
		const third = imageData(fourMegabytesEncoded, 3);
		const built = new MessageBuilder().buildForApi([
			userMessage(first),
			assistantMessage("one"),
			userMessage(second),
			assistantMessage("two"),
			userMessage(third),
		]);

		const formatterInput = built.map((message) => ({
			role: message.role,
			content: Array.isArray(message.content)
				? message.content.map((block) =>
						block.type === "image"
							? {
									type: "image" as const,
									image: block.data,
									mediaType: block.mediaType,
								}
							: block,
					)
				: message.content,
		}));
		const formatted = JSON.stringify(
			formatMessagesForAiSdk(undefined, formatterInput as never),
		);

		expect(imagesIn(built)).toEqual([second, third]);
		expect(formatted).toContain(second);
		expect(formatted).toContain(third);
		expect(formatted.split(IMAGE_OMITTED_PLACEHOLDER)).toHaveLength(2);
	});
});

describe("omittedImageNotice", () => {
	const limit = 8 * 1024 * 1024;

	it("states the count and the limit", () => {
		expect(omittedImageNotice(0, 3, limit)).toBe(
			"3 images did not reach the model because they were invalid or over this request's 8 MB image limit. Newest images are sent first.",
		);
		expect(omittedImageNotice(0, 1, limit)).toContain("1 image did not reach");
	});

	it("does not repeat while the count is unchanged", () => {
		expect(omittedImageNotice(3, 3, limit)).toBeUndefined();
	});

	it("reports a changed count and stays quiet at zero", () => {
		expect(omittedImageNotice(3, 4, limit)).toContain("4 images");
		expect(omittedImageNotice(3, 0, limit)).toBeUndefined();
	});
});
