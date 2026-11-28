import type { RelaySettings } from "@cline/core"
import type { RelaySettings as ProtoRelaySettings } from "@shared/proto/cline/remote_control"

/** Only the tail of the credential is ever shown, and only so a person can tell which key is in force. */
export function maskRelayKey(key: string): string {
	if (!key) {
		return ""
	}
	return `••••${key.slice(-4)}`
}

/**
 * The relay settings as the webview is allowed to see them. The credential itself is not part of the
 * result — a masked tail and a presence flag carry everything the interface needs, and the value stays
 * in the host's settings file.
 */
export function describeRelaySettings(settings: RelaySettings): ProtoRelaySettings {
	return {
		url: settings.url,
		hasKey: settings.key.length > 0,
		keyMasked: maskRelayKey(settings.key),
		pollIntervalMs: settings.pollIntervalMs,
		autoUpdate: settings.autoUpdate,
		error: "",
	}
}
