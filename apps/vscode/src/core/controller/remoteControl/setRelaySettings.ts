import { readRelaySettingsGlobally, setRelaySettingsGlobally } from "@cline/core"
import type { RelaySettings, RelaySettingsRequest } from "@shared/proto/cline/remote_control"
import { validateRelayUrl } from "../../relay/relayClient"
import { describeRelaySettings } from "../../relay/relaySettingsView"
import type { Controller } from ".."
import { remoteControlManager } from "./remoteControlManager"

const MIN_POLL_MS = 200
const MAX_POLL_MS = 60_000

/**
 * Change any part of the relay configuration. A field that is absent keeps its stored value, so the
 * interface can save one input without resending the others. A rejected value is refused with a named
 * reason and nothing is written.
 */
export async function setRelaySettings(_controller: Controller, request: RelaySettingsRequest): Promise<RelaySettings> {
	if (request.url !== undefined) {
		const { error } = validateRelayUrl(request.url)
		if (error) {
			return { ...describeRelaySettings(readRelaySettingsGlobally()), error }
		}
	}
	if (request.pollIntervalMs !== undefined && (request.pollIntervalMs < MIN_POLL_MS || request.pollIntervalMs > MAX_POLL_MS)) {
		return {
			...describeRelaySettings(readRelaySettingsGlobally()),
			error: `poll_interval_out_of_range: expected ${MIN_POLL_MS} to ${MAX_POLL_MS} ms`,
		}
	}

	const patch: Parameters<typeof setRelaySettingsGlobally>[0] = {}
	if (request.url !== undefined) {
		patch.url = request.url
	}
	if (request.key !== undefined) {
		patch.key = request.key
	}
	if (request.pollIntervalMs !== undefined) {
		patch.pollIntervalMs = request.pollIntervalMs
	}

	const saved = setRelaySettingsGlobally(patch)
	// The link is re-opened from the new values, and the fresh state is pushed so the badge and every
	// other surface agree with the host immediately.
	await remoteControlManager.applyRelaySettings()
	await _controller.postStateToWebview()

	return describeRelaySettings(saved)
}
