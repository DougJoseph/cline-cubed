/**
 * Conservative chars-per-token approximation used for compaction triggering
 * and request-size diagnostics. Uses 3 chars/token (slightly over-counts vs
 * the conventional 4) so trigger thresholds fire before provider rejection
 * rather than after.
 */

export const CHARS_PER_TOKEN = 3;

export function estimateTokens(chars: number): number {
	return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export interface TokenEstimatedRequest {
	systemPrompt?: string;
	messages: readonly unknown[];
	tools?: readonly unknown[];
}

/**
 * Encoded image bytes are not text: a model's vision encoder decides their
 * token cost, so their length says nothing about it. They are left out of
 * character-based estimates, and provider-reported usage carries their real
 * cost once the request has been sent.
 */
function omitImageData(value: unknown): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const block = value as Record<string, unknown>;
	const holdsEncodedBytes =
		(block.type === "image" && ("data" in block || "image" in block)) ||
		(block.type === "base64" && "data" in block);
	if (!holdsEncodedBytes) {
		return value;
	}
	const { data: _data, image: _image, ...rest } = block;
	return rest;
}

/** Serialize a message or request for character-based token estimation. */
export function serializeForTokenEstimate(value: unknown): string {
	return (
		JSON.stringify(value, (_key, nestedValue: unknown) =>
			omitImageData(nestedValue),
		) ?? ""
	);
}

function safeStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	try {
		return (
			JSON.stringify(value, (_key, nestedValue: unknown) => {
				if (typeof nestedValue === "bigint") {
					return nestedValue.toString();
				}
				if (typeof nestedValue !== "object" || nestedValue === null) {
					return nestedValue;
				}
				if (seen.has(nestedValue)) {
					return "[Circular]";
				}
				seen.add(nestedValue);
				return omitImageData(nestedValue);
			}) ?? ""
		);
	} catch {
		return String(value ?? "");
	}
}

function positiveTokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

export interface MeasuredTokenRequest {
	messages: readonly unknown[];
	/** The model about to receive the request. */
	modelId: string;
}

/**
 * Size a request from the newest provider-reported usage: that request's input
 * and output, plus an estimate of only the messages added since. Returns
 * undefined when no usage from this model is available, so callers fall back
 * to {@link estimateRequestInputTokens}.
 */
export function resolveMeasuredRequestInputTokens(
	request: MeasuredTokenRequest,
): number | undefined {
	for (let index = request.messages.length - 1; index >= 0; index -= 1) {
		const message = request.messages[index] as {
			role?: unknown;
			modelInfo?: { id?: unknown };
			metrics?: { inputTokens?: unknown; outputTokens?: unknown };
		} | null;
		if (message?.role !== "assistant") {
			continue;
		}
		const inputTokens = positiveTokenCount(message.metrics?.inputTokens);
		if (inputTokens === undefined) {
			continue;
		}
		if (message.modelInfo?.id !== request.modelId) {
			return undefined;
		}
		const reportedOutput = positiveTokenCount(message.metrics?.outputTokens);
		const newerMessages = request.messages.slice(
			reportedOutput === undefined ? index : index + 1,
		);
		const newerTokens =
			newerMessages.length > 0
				? estimateRequestInputTokens({ messages: newerMessages })
				: 0;
		return inputTokens + (reportedOutput ?? 0) + newerTokens;
	}
	return undefined;
}

/**
 * Estimate the complete provider request payload so request execution and
 * pre-request policies use the same definition of input utilization.
 */
export function estimateRequestInputTokens(
	request: TokenEstimatedRequest,
): number {
	let serialized: string;
	try {
		serialized = serializeForTokenEstimate({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		});
	} catch {
		serialized = [
			safeStringify(request.systemPrompt),
			safeStringify(request.messages),
			safeStringify(request.tools),
		].join("\n");
	}
	// Deliberately over-estimate slightly to leave room for provider formatting,
	// tool schema overhead, and tokenizer drift.
	return estimateTokens(serialized.length);
}
