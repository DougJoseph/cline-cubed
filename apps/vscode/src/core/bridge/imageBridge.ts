/**
 * Cline Cubed — the image bridge.
 *
 * The bridge is the third-model channel: a vision-capable "Image Mode" model
 * reads an image attachment and produces an exhaustive text-only description,
 * which is injected into the request when the Plan/Act model cannot view
 * images (e.g. DeepSeek Reasoner). This module is the vision-leg client.
 */

export const IMAGE_BRIDGE_PROMPT = `You are the image bridge — the eyes for a text-only AI model that cannot see this image. That model's spatial and visual reasoning depends entirely on your description, so be exhaustive, precise, and structured.

FIRST — the canvas:
- Image dimensions in pixels and the aspect ratio.
- One sentence stating what the image IS (screenshot of a webpage / error dialog / form / photo / chart / document / terminal...).

THEN — a structured description in top-to-bottom, left-to-right reading order. Tag EVERY element you describe with:
- GRID CELL on an 8x8 grid: columns A-H, rows 1-8. A1 = top-left, H8 = bottom-right. A wide element spans cells, e.g. B1-C1.
- POSITION as percentages of the full canvas: x%-y% horizontal, y%-y% vertical.
- RELATIONSHIPS to neighbors: above / below / left of / right of / centered / overlapping / on top of.

COVER ALL OF THESE SECTIONS:
1. LAYOUT — the overall arrangement and visual hierarchy, top-to-bottom.
2. TEXT — every visible string, verbatim and character-for-character, in reading order, each with its grid cell and position. Include URLs, error messages, placeholder text, labels, partial or truncated text. This is the index the text-only model will quote from.
3. UI / STATE — buttons, inputs, tabs, toggles, selected / hover / disabled states, banners, toasts, modals, dialogs — and what is interactive.
4. VISUALS — photos, icons, logos, colors, diagrams, charts (read and quote the data values, axes, labels, and trends), tables, graphs. Describe what they depict, not just that they exist.
5. LAYERS / Z-ORDER — what sits on top of what (a modal over a dimmed page, a dropdown over content).
6. SUMMARY — three to five sentences synthesizing the most important facts a text-only model must not miss.

Never guess, infer, or editorialize beyond what is visible. If something is ambiguous or illegible, say so explicitly. Output only the structured description.`

/**
 * Builds the bridge prompt. With a focus region, the vision model is asked to
 * zoom in on one 8x8 grid region and describe it in maximal detail — the
 * reasoner's "second look" that closes most of the gap to real vision.
 */
export function buildImageBridgePrompt(focusRegion?: string): string {
	if (focusRegion) {
		return `You are the image bridge — the eyes for a text-only AI model that cannot see this image. Focus ONLY on grid region ${focusRegion} of the 8x8 grid (columns A-H, rows 1-8; A1 = top-left, H8 = bottom-right).

Describe that region in MAXIMAL detail:
- Every character of text verbatim, including partial text at the region edges.
- Every UI element: type, state, colors, spacing, borders.
- How the region relates to the rest of the image (is it part of a larger control? what is above/below/left/right of it?).
- Give grid-cell positions within the region (e.g. "upper-left of the region") and percentage positions on the full canvas.

Never guess beyond what is visible; if the region edge cuts something off, say so. Output only the focused description.`
	}
	return IMAGE_BRIDGE_PROMPT
}

const DEFAULT_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	"openai-native": "https://api.openai.com/v1",
	deepseek: "https://api.deepseek.com/v1",
	openrouter: "https://openrouter.ai/api/v1",
	gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
}

export interface ImageBridgeParams {
	/** Base64 image payload (without the data: prefix). */
	base64: string
	/** MIME type of the image, e.g. "image/png". */
	mediaType: string
	/** The Image Mode provider id (from the ApiProvider union). */
	provider: string
	/** The Image Mode model id. */
	modelId?: string
	/** The Image Mode API key (resolved from secret storage by the caller). */
	apiKey?: string
	/** The Image Mode base URL override. */
	apiUri?: string
	/** The Image Mode API format. "openai" (OpenAI-compatible) is supported. */
	apiFormat?: string
	/** Reasoning effort for reasoning-capable image models (forwarded as `reasoning_effort`). */
	reasoningEffort?: string
	/**
	 * Optional debug recorder: invoked once per request with the human-readable
	 * log line (used by the in-memory bridge debug buffer; the output channel
	 * gating is handled by the caller via `recordBridgeDebug`).
	 */
	recordDebug?: (line: string, failed?: boolean) => void
	/**
	 * Optional 8x8 grid region to zoom into (e.g. "C2-D3") for a second,
	 * maximal-detail bridge pass — the reasoner's "second look".
	 */
	focusRegion?: string
}

/**
 * Sends the image to the Image Mode model and returns its text description.
 * v1 supports OpenAI-compatible chat completions (covers DeepSeek Vision via
 * its OpenAI-compatible endpoint, OpenAI, OpenRouter, Gemini's compatible
 * endpoint, etc.). Other formats throw a clear "not supported yet" error.
 */
export async function bridgeImage(params: ImageBridgeParams): Promise<string> {
	const { base64, mediaType, modelId, provider } = params
	if (!modelId) {
		throw new Error("Image Mode model is not configured — set one in Settings → API Configuration → Image Mode")
	}

	// OpenRouter names models "provider/model-id" (e.g. deepseek/deepseek-v4-flash-vision-exp).
	// Native provider endpoints (deepseek, openai, gemini, ...) use BARE ids, so a model id
	// copied from an OpenRouter listing into a native provider's Image Mode field must have the
	// provider prefix stripped — otherwise the native endpoint answers from a text-only fallback
	// (the "I cannot see an image" symptom) or 404s. OpenRouter keeps its prefix.
	const effectiveModelId = provider === "openrouter" ? modelId : modelId.replace(/^[^/]+\//, "")

	const format = (params.apiFormat ?? "openai").toLowerCase()
	if (format !== "openai") {
		throw new Error(`Image Mode API format "${format}" is not supported yet — use "openai" (OpenAI-compatible) for now.`)
	}

	const baseUrl = (params.apiUri ?? DEFAULT_BASE_URLS[provider] ?? "").replace(/\/+$/, "")
	if (!baseUrl) {
		throw new Error(`No base URL for Image Mode provider "${provider}" — set one in Image Mode settings.`)
	}

	const url = `${baseUrl}/chat/completions`
	const body: Record<string, unknown> = {
		model: effectiveModelId,
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: buildImageBridgePrompt(params.focusRegion) },
					{
						type: "image_url",
						image_url: { url: `data:${mediaType};base64,${base64}` },
					},
				],
			},
		],
		max_tokens: 4096,
	}
	// Only forward reasoning effort when the caller knows the model supports it
	// (resolved from catalog metadata); unknown/unset effort stays omitted so
	// non-reasoning vision models never receive an unsupported parameter.
	if (params.reasoningEffort) {
		body.reasoning_effort = params.reasoningEffort
	}

	const headers: Record<string, string> = { "Content-Type": "application/json" }
	if (params.apiKey) {
		headers.Authorization = `Bearer ${params.apiKey}`
	}

	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	})
	const debugLine =
		`${provider} ${effectiveModelId} -> ${url} (image ${mediaType}, base64 ${base64.length} chars, ` +
		`auth ${params.apiKey ? "yes" : "no"}, status ${response.status})`
	params.recordDebug?.(debugLine, !response.ok)
	if (!response.ok) {
		const detail = await response.text().catch(() => "")
		// OpenRouter returns 404 with a guardrail/data-policy message when the
		// account's privacy settings block the model endpoint — the request and
		// auth worked, so the fix is account-side. Surface that clearly instead
		// of a bare 404.
		if (response.status === 404 && provider === "openrouter" && detail.includes("guardrail")) {
			throw new Error(
				`OpenRouter blocked this model under your account's privacy/guardrail settings — allow it at ` +
					`https://openrouter.ai/settings/privacy (the model id may also need its provider prefix, ` +
					`e.g. "deepseek/deepseek-v4-flash-vision-exp"). Raw response: ${detail.slice(0, 400)}`,
			)
		}
		throw new Error(`Image bridge request failed (${response.status}): ${detail.slice(0, 500)}`)
	}

	const data = (await response.json()) as {
		choices?: { message?: { content?: string } }[]
	}
	const content = data.choices?.[0]?.message?.content
	if (!content) {
		throw new Error("Image bridge returned no content")
	}
	return content
}
