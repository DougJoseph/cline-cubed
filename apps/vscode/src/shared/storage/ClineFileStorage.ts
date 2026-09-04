import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "../services/Logger"
import { ClineSyncStorage } from "./ClineStorage"

export interface ClineFileStorageOptions {
	/**
	 * File permissions mode (e.g., 0o600 for owner read/write only).
	 * If not set, uses the system default.
	 */
	fileMode?: number
}

/**
 * Synchronous file-backed JSON storage.
 * Stores any JSON-serializable values with sync read and write.
 * Used for VSCode Memento compatibility and CLI environments.
 */
export class ClineFileStorage<T = any> extends ClineSyncStorage<T> {
	protected name: string
	private data: Record<string, T>
	private readonly fsPath: string
	private readonly fileMode?: number

	constructor(filePath: string, name = "ClineFileStorage", options?: ClineFileStorageOptions) {
		super()
		this.fsPath = filePath
		this.name = name
		this.fileMode = options?.fileMode
		this.data = this.readFromDisk()
	}

	protected _get(key: string): T | undefined {
		return this.data[key]
	}

	protected _set(key: string, value: T | undefined): void {
		// Use setBatch for consistency - all writes go through one path
		this.setBatch({ [key]: value })
	}

	protected _delete(key: string): void {
		this.setBatch({ [key]: undefined })
	}

	/**
	 * Set multiple keys in a single write operation.
	 * More efficient than calling set() for each key individually,
	 * since it only writes to disk once.
	 *
	 * Cline Cubed: the changed keys are applied onto the file's CURRENT contents, re-read here,
	 * rather than onto the copy this instance loaded at construction.
	 *
	 * Every process using this file has its own instance, and an instance's `data` is a snapshot
	 * of the moment it was constructed. Writing that snapshot back — which is what serialising
	 * `this.data` does — restores it over the file, erasing every key anything else has changed
	 * since. Each VS Code window runs its own extension host with its own instance over the same
	 * `globalState.json`, and ordinary startup writes (a version stamp, a distinct-id update) are
	 * enough to fire it, so a window that has been open a while can silently undo settings changed
	 * in another one.
	 *
	 * Re-reading makes last-writer-wins apply per KEY instead of per FILE: an instance can only
	 * overwrite what it actually changed, never keys it has never heard of. The cost is one
	 * synchronous read of a small JSON file on a path that already writes synchronously, and
	 * `StateManager` debounces callers, so it is not per keystroke.
	 *
	 * This does NOT make instances agree with each other — a second window still shows its own
	 * cached values until it restarts, which `StateManager` documents as deliberate. It stops that
	 * staleness from destroying data.
	 */
	public setBatch(entries: Record<string, T | undefined>): Thenable<void> {
		const onDisk = this.readFromDisk()
		const changedKeys: string[] = []
		for (const [key, value] of Object.entries(entries)) {
			if (value === undefined) {
				// Report the delete as a change if EITHER view still holds the key: this instance's
				// listeners care about its own view, and the file is what has to end up without it.
				if (key in onDisk || key in this.data) {
					changedKeys.push(key)
				}
				delete onDisk[key]
			} else {
				onDisk[key] = value
				changedKeys.push(key)
			}
		}
		// The merged result becomes this instance's view — its own writes are reflected, and it
		// picks up whatever else the file gained. Reads between writes stay in memory as before.
		this.data = onDisk
		if (changedKeys.length > 0) {
			this.writeToDisk()
			for (const key of changedKeys) {
				this.fireChange(key)
			}
		}
		return Promise.resolve()
	}

	protected _keys(): readonly string[] {
		return Object.keys(this.data)
	}

	private readFromDisk(): Record<string, T> {
		try {
			if (fs.existsSync(this.fsPath)) {
				return JSON.parse(fs.readFileSync(this.fsPath, "utf-8"))
			}
		} catch (error) {
			Logger.error(`[${this.name}] failed to read from ${this.fsPath}:`, error)
		}
		return {}
	}

	private writeToDisk(): void {
		try {
			const dir = path.dirname(this.fsPath)
			fs.mkdirSync(dir, { recursive: true })
			atomicWriteFileSync(this.fsPath, JSON.stringify(this.data, null, 2), this.fileMode)
		} catch (error) {
			Logger.error(`[${this.name}] failed to write to ${this.fsPath}:`, error)
		}
	}
}

/**
 * Synchronously, atomically write data to a file using temp file + rename pattern.
 * Prefer core/storage's async atomicWriteFile to this.
 */
function atomicWriteFileSync(filePath: string, data: string, mode?: fs.Mode | undefined): void {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}.json`
	try {
		fs.writeFileSync(tmpPath, data, {
			flag: "wx",
			encoding: "utf-8",
			mode,
		})
		// Rename temp file to target (atomic in most cases)
		fs.renameSync(tmpPath, filePath)
	} catch (error) {
		// Clean up temp file if it exists
		try {
			fs.unlinkSync(tmpPath)
		} catch {}
		throw error
	}
}
