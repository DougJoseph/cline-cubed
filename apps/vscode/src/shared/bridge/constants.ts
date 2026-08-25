/**
 * Cline Cubed — shared image-bridge block helpers.
 *
 * The image bridge itself runs in the extension host (`src/core/bridge/`), but
 * the chat transcript renders the user message in the webview, so the block
 * marker and the parse helpers live here in `src/shared/` where both sides can
 * import them (`@shared/bridge/constants` in the webview, the same alias or a
 * relative path in the extension).
 */

/** Header line of the bridged-description block appended to a user message. */
export const IMAGE_BRIDGE_HEADER = "[Image description (from the image bridge):]"

/** Joins multiple per-image descriptions inside a single bridge block. */
export const IMAGE_BRIDGE_SEPARATOR = "\n\n---\n\n"

/**
 * Builds the bridge block appended to a user message's text.
 * `descriptions` is one description string per image, in order.
 * The header line stays in the text so the model understands what the block
 * is; the webview strips it for display.
 */
export function buildImageBridgeBlock(descriptions: string[]): string {
	return `\n\n${IMAGE_BRIDGE_HEADER}\n${descriptions.join(IMAGE_BRIDGE_SEPARATOR)}`
}

/**
 * Splits a user-message text into the user's own prompt and the bridged
 * description content (if any). The header line is stripped from
 * `bridgeText` — it is display-only; the full text (with header) is what the
 * model receives.
 *
 * @returns `{ userText, bridgeText }` where `bridgeText` is `""` when the
 * message carries no bridged description.
 */
export function splitImageBridgeBlock(text: string): { userText: string; bridgeText: string } {
	if (!text) {
		return { userText: text, bridgeText: "" }
	}
	// The bridge block is always appended last, so the last occurrence is the
	// one we own even if the user's own prompt contains the same wording.
	const markerIndex = text.lastIndexOf(IMAGE_BRIDGE_HEADER)
	if (markerIndex === -1) {
		return { userText: text, bridgeText: "" }
	}
	return {
		userText: text.slice(0, markerIndex),
		bridgeText: text.slice(markerIndex + IMAGE_BRIDGE_HEADER.length).replace(/^\n/, ""),
	}
}
