import type * as LlmsProviders from "@cline/llms";
import type { MessageWithMetadata } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreCompactionContext } from "../../types/config";
import { createContextCompactionPrepareTurn } from "./compaction";
import {
	createTokenEstimator,
	resolveDefaultPreserveRecentTokens,
} from "./compaction-shared";

const createHandlerMock = vi.fn();

vi.mock("@cline/llms", () => ({
	createHandlerAsync: (config: unknown) => createHandlerMock(config),
}));

const MODEL_ID = "local-model";
const CONTEXT_WINDOW = 262_144;
const TRIGGER_TOKENS = CONTEXT_WINDOW * 0.9 * 0.9;

async function* summaryStream(): AsyncGenerator<Record<string, unknown>> {
	yield { type: "text", id: "summary", text: "## Goal\nKeep working" };
	yield { type: "done", id: "summary", success: true };
}

function assistantWithUsage(
	inputTokens: number,
	content = "answer",
): MessageWithMetadata {
	return {
		role: "assistant",
		content,
		modelInfo: { id: MODEL_ID, provider: "openai-compatible" },
		metrics: { inputTokens, outputTokens: 100 },
	};
}

function createCustomCompact() {
	return vi.fn((_context: CoreCompactionContext) => ({
		messages: [{ role: "user" as const, content: "compacted" }],
	}));
}

function createPrepareTurn(
	compaction: NonNullable<
		Parameters<typeof createContextCompactionPrepareTurn>[0]["compaction"]
	>,
) {
	return createContextCompactionPrepareTurn({
		providerId: "openai-compatible",
		modelId: MODEL_ID,
		providerConfig: {
			providerId: "openai-compatible",
			modelId: MODEL_ID,
		} as LlmsProviders.ProviderConfig,
		compaction,
		logger: undefined,
	});
}

function turn(
	messages: MessageWithMetadata[],
	extra: { overflowRecovery?: boolean; emitStatusNotice?: () => void } = {},
) {
	return {
		agentId: "agent-1",
		conversationId: "conv-1",
		parentAgentId: null,
		iteration: 1,
		abortSignal: new AbortController().signal,
		systemPrompt: "You are helpful.",
		tools: [],
		messages,
		apiMessages: messages,
		model: {
			id: MODEL_ID,
			provider: "openai-compatible",
			info: { id: MODEL_ID, contextWindow: CONTEXT_WINDOW, maxTokens: 32_768 },
		},
		...extra,
	};
}

beforeEach(() => {
	createHandlerMock.mockReset();
});

describe("compaction trigger from reported usage", () => {
	it("does not compact below the trigger when stored text is far larger", async () => {
		const compact = createCustomCompact();
		const prepareTurn = createPrepareTurn({ enabled: true, compact });

		const result = await prepareTurn?.(
			turn([
				{ role: "user", content: "x".repeat(900_000) },
				assistantWithUsage(130_000),
			]),
		);

		expect(result).toBeUndefined();
		expect(compact).not.toHaveBeenCalled();
	});

	it("compacts when reported usage reaches the trigger", async () => {
		const compact = createCustomCompact();
		const prepareTurn = createPrepareTurn({ enabled: true, compact });

		await prepareTurn?.(
			turn([
				{ role: "user", content: "short" },
				assistantWithUsage(Math.ceil(TRIGGER_TOKENS)),
			]),
		);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("compacts when newer messages carry reported usage over the trigger", async () => {
		const compact = createCustomCompact();
		const prepareTurn = createPrepareTurn({ enabled: true, compact });

		await prepareTurn?.(
			turn([
				assistantWithUsage(Math.floor(TRIGGER_TOKENS) - 1_000),
				{ role: "user", content: "y".repeat(9_000) },
			]),
		);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("falls back to the estimate when usage came from another model", async () => {
		const compact = createCustomCompact();
		const prepareTurn = createPrepareTurn({ enabled: true, compact });
		const otherModel: MessageWithMetadata = {
			...assistantWithUsage(1_000),
			modelInfo: { id: "another-model", provider: "openai-compatible" },
		};

		await prepareTurn?.(
			turn([{ role: "user", content: "x".repeat(900_000) }, otherModel]),
		);

		expect(compact).toHaveBeenCalledTimes(1);
	});

	it("does not let image data trigger compaction", async () => {
		const compact = createCustomCompact();
		const prepareTurn = createPrepareTurn({ enabled: true, compact });

		const result = await prepareTurn?.(
			turn([
				assistantWithUsage(63_000),
				{
					role: "user",
					content: [
						{ type: "text", text: "see these screenshots" },
						{
							type: "image",
							data: "A".repeat(2_800_000),
							mediaType: "image/png",
						},
					],
				},
			]),
		);

		expect(result).toBeUndefined();
		expect(compact).not.toHaveBeenCalled();
	});

	it("still runs overflow recovery for an image request the server rejects", async () => {
		const emitStatusNotice = vi.fn();
		const prepareTurn = createPrepareTurn({
			enabled: true,
			strategy: "basic",
		});

		const result = await prepareTurn?.(
			turn(
				[
					{ role: "user", content: `old request ${"o".repeat(4_000)}` },
					assistantWithUsage(63_000, `old answer ${"a".repeat(4_000)}`),
					{
						role: "user",
						content: [
							{ type: "text", text: "latest request" },
							{
								type: "image",
								data: "A".repeat(2_800_000),
								mediaType: "image/png",
							},
						],
					},
				],
				{ overflowRecovery: true, emitStatusNotice },
			),
		);

		expect(result?.messages).toBeDefined();
		expect(emitStatusNotice).toHaveBeenCalledWith(
			"overflow-recovery-compacting",
			expect.objectContaining({ phase: "started" }),
		);
	});

	it("reports before and after on the reported-usage scale", async () => {
		const emitStatusNotice = vi.fn();
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "s".repeat(30_000) }],
		}));
		const prepareTurn = createPrepareTurn({ enabled: true, compact });
		const reportedInput = Math.ceil(TRIGGER_TOKENS);
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "x".repeat(600_000) },
			assistantWithUsage(reportedInput),
		];

		await prepareTurn?.(turn(messages, { emitStatusNotice }));

		const completed = emitStatusNotice.mock.calls.find(
			([message]) => message === "auto-compacted",
		)?.[1] as { tokensBefore: number; tokensAfter: number };
		const context = compact.mock.calls[0]?.[0] as CoreCompactionContext;
		const estimatedBefore = context.budget.request.inputTokens;
		const estimatedAfter =
			context.budget.request.overheadTokens +
			createTokenEstimator()({ role: "user", content: "s".repeat(30_000) });

		expect(completed.tokensBefore).toBe(reportedInput + 100);
		expect(completed.tokensAfter).toBe(
			Math.ceil((reportedInput + 100) * (estimatedAfter / estimatedBefore)),
		);
	});

	it("drops usage from messages kept through a compaction", async () => {
		const kept = assistantWithUsage(Math.ceil(TRIGGER_TOKENS));
		const compact = vi.fn((_context: CoreCompactionContext) => ({
			messages: [{ role: "user" as const, content: "summary" }, kept],
		}));
		const prepareTurn = createPrepareTurn({ enabled: true, compact });

		const result = await prepareTurn?.(
			turn([{ role: "user", content: "short" }, kept]),
		);

		expect(result?.messages).toHaveLength(2);
		expect(result?.messages[1]?.metrics).toBeUndefined();
		expect(result?.messages[1]?.content).toBe("answer");
	});
});

describe("recent conversation kept by agentic compaction", () => {
	it("keeps at least the existing minimum for small windows", () => {
		expect(resolveDefaultPreserveRecentTokens(40_000)).toBe(20_000);
	});

	it("scales with the usable window", () => {
		expect(resolveDefaultPreserveRecentTokens(235_929)).toBe(58_983);
	});

	/** Each message is about 10k estimated tokens. */
	function longTranscript(): MessageWithMetadata[] {
		const messages: MessageWithMetadata[] = [
			{ role: "user", content: "first request" },
		];
		for (let index = 0; index < 22; index += 1) {
			messages.push(
				{ role: "assistant", content: `step ${index} ${"a".repeat(30_000)}` },
				{ role: "user", content: `result ${index} ${"r".repeat(30_000)}` },
			);
		}
		return messages;
	}

	it("keeps more than the flat minimum on a large window", async () => {
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() => summaryStream()),
		});
		const prepareTurn = createPrepareTurn({
			enabled: true,
			strategy: "agentic",
		});

		const result = await prepareTurn?.(turn(longTranscript()));

		const estimate = createTokenEstimator();
		const keptTokens = (result?.messages ?? [])
			.slice(1)
			.reduce((total, message) => total + estimate(message), 0);
		expect(keptTokens).toBeGreaterThanOrEqual(58_983);
	});

	it("still honors an explicit preserveRecentTokens", async () => {
		createHandlerMock.mockReturnValue({
			createMessage: vi.fn(() => summaryStream()),
		});
		const prepareTurn = createPrepareTurn({
			enabled: true,
			strategy: "agentic",
			preserveRecentTokens: 1,
		});

		const result = await prepareTurn?.(turn(longTranscript()));

		const estimate = createTokenEstimator();
		const keptTokens = (result?.messages ?? [])
			.slice(1)
			.reduce((total, message) => total + estimate(message), 0);
		expect(keptTokens).toBeLessThan(20_000);
	});
});
