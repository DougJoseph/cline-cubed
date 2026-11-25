import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"

/**
 * Cline Cubed: a change to a provider's connection (Base URL, key, or headers) saved in Settings
 * reaches the chats already open on that provider, in place, without restarting them. Without
 * this, an open chat kept the address it started with until the window was reloaded.
 */

export interface ProviderConnectionChanges {
	baseUrl?: string
	apiKey?: string
	headers?: Record<string, string>
}

/** The fields of a provider-config write that can change a connection. */
export interface ConnectionWritePatch {
	baseUrl?: string
	apiKey?: string
	headers?: Record<string, string>
	clearHeaders?: boolean
}

/** The stored provider record after the write. */
export interface StoredConnection {
	baseUrl?: string
	apiKey?: string
	headers?: Record<string, string>
}

/**
 * The connection fields a write changed, with their stored values, or undefined when the write
 * touched no connection field.
 */
export function connectionChangesFromWrite(
	patch: ConnectionWritePatch | undefined,
	stored: StoredConnection,
): ProviderConnectionChanges | undefined {
	if (!patch) {
		return undefined
	}
	const changes: ProviderConnectionChanges = {}
	if (patch.baseUrl !== undefined) {
		changes.baseUrl = stored.baseUrl ?? ""
	}
	if (patch.apiKey !== undefined) {
		changes.apiKey = stored.apiKey ?? ""
	}
	if (patch.clearHeaders === true || (patch.headers !== undefined && Object.keys(patch.headers).length > 0)) {
		changes.headers = stored.headers ?? {}
	}
	return Object.keys(changes).length > 0 ? changes : undefined
}

export interface ConnectionUpdatableSession {
	sessionId: string
	providerId: string | undefined
	update: (changes: ProviderConnectionChanges) => Promise<void>
}

/**
 * Applies `changes` to every open session on `providerId` (Settings and session ids are compared
 * after folding SDK aliases, so `openai-compatible` matches `openai`). A failed update is passed to
 * `report` for that chat and does not stop the others. Returns the sessions updated.
 */
export async function applyProviderConnectionChange(
	sessions: Iterable<ConnectionUpdatableSession>,
	providerId: string,
	changes: ProviderConnectionChanges,
	report: (sessionId: string, error: unknown) => void,
): Promise<string[]> {
	const target = toLegacyApiProvider(providerId)
	const updated: string[] = []
	for (const session of sessions) {
		if (!session.providerId || toLegacyApiProvider(session.providerId) !== target) {
			continue
		}
		try {
			await session.update(changes)
			updated.push(session.sessionId)
		} catch (error) {
			report(session.sessionId, error)
		}
	}
	return updated
}
