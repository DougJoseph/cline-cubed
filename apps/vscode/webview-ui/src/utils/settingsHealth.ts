import { useSyncExternalStore } from "react"

/** Settings reads measured at most 17 ms on a test install. */
export const SETTINGS_LOADING_NOTICE_MS = 250
export const SETTINGS_ANSWER_LIMIT_MS = 3_000
/** A save reports failure if unanswered for this long. */
export const SETTINGS_SAVE_LIMIT_MS = 10_000
/** Model lists measured at most 483 ms on a test install. The request keeps running after this. */
export const MODEL_LIST_SLOW_NOTICE_MS = 5_000

export class NoAnswerError extends Error {
	constructor() {
		super("The extension did not answer.")
		this.name = "NoAnswerError"
	}
}

/** Turns a request that would otherwise wait forever into a failure the panel can show. */
export function withAnswerLimit<T>(request: Promise<T>, limitMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new NoAnswerError()), limitMs)
		request.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

export interface SettingsHealth {
	loadFailed: boolean
	slowModelLists: string[]
	loadsInProgress: number
	saveFailures: string[]
	retryCount: number
}

const healthy: SettingsHealth = { loadFailed: false, slowModelLists: [], loadsInProgress: 0, saveFailures: [], retryCount: 0 }
let health = healthy
const listeners = new Set<() => void>()

function publish(next: SettingsHealth): void {
	health = next
	for (const listener of listeners) listener()
}

export const getSettingsHealth = () => health

export function reportSettingsLoadFailure(): void {
	if (!health.loadFailed) publish({ ...health, loadFailed: true })
}

export function beginSettingsLoad(): void {
	publish({ ...health, loadsInProgress: health.loadsInProgress + 1 })
}

export function endSettingsLoad(): void {
	publish({ ...health, loadsInProgress: Math.max(0, health.loadsInProgress - 1) })
}

export function reportModelListSlow(requestId: string): void {
	if (!health.slowModelLists.includes(requestId)) {
		publish({ ...health, slowModelLists: [...health.slowModelLists, requestId] })
	}
}

export function clearModelListSlow(requestId: string): void {
	if (health.slowModelLists.includes(requestId)) {
		publish({ ...health, slowModelLists: health.slowModelLists.filter((id) => id !== requestId) })
	}
}

export function reportSettingsSaveFailure(field: string): void {
	if (!health.saveFailures.includes(field)) {
		publish({ ...health, saveFailures: [...health.saveFailures, field] })
	}
}

/** Clears every failure; the panel remounts and loads again. */
export function retrySettingsLoad(): void {
	publish({ ...healthy, loadsInProgress: health.loadsInProgress, retryCount: health.retryCount + 1 })
}

export const resetSettingsHealth = () => publish(healthy)

export function useSettingsHealth(): SettingsHealth {
	return useSyncExternalStore((listener) => {
		listeners.add(listener)
		return () => listeners.delete(listener)
	}, getSettingsHealth)
}
