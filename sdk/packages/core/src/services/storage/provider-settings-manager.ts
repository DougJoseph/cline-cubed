import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { resolveProviderSettingsPath } from "@cline/shared/storage";
import { getLiveModelsCatalog } from "../..";
import { getProviderAuthHandler } from "../../auth/provider-auth-registry";
import { hashSecret, sdkDebug } from "../../logging/early-logger";
import {
	emptyStoredProviderSettings,
	type ProviderConfig,
	type ProviderSettings,
	ProviderSettingsSchemaTyped as ProviderSettingsSchema,
	type ProviderTokenSource,
	type StoredProviderSettings,
	StoredProviderSettingsSchema,
	type ToProviderConfigOptions,
	toProviderConfig,
	type VoiceInputSettings,
	VoiceInputSettingsSchema,
} from "../../types/provider-settings";
import {
	ensureCustomProvidersLoadedSync,
	registerConfiguredProvidersFromSettings,
} from "../providers/local-provider-registry";
import { migrateLegacyProviderSettings } from "./provider-settings-legacy-migration";

function nowIso(): string {
	return new Date().toISOString();
}

export interface ProviderSettingsManagerOptions {
	filePath?: string;
	dataDir?: string;
}

export interface SaveProviderSettingsOptions {
	setLastUsed?: boolean;
	tokenSource?: ProviderTokenSource;
}

export interface ResolveLastUsedProviderSettingsOptions {
	isClinePassEnabled?: boolean;
}

const CLINE_PROVIDER_ID = "cline";
const CLINE_PASS_PROVIDER_ID = "cline-pass";

function inferLegacyDataDir(filePath: string): string | undefined {
	if (basename(filePath) !== "providers.json") {
		return undefined;
	}
	const settingsDir = dirname(filePath);
	if (basename(settingsDir) !== "settings") {
		return undefined;
	}
	return dirname(settingsDir);
}

export class ProviderSettingsManager {
	private readonly filePath: string;
	private readonly dataDir?: string;
	/**
	 * LOCAL PATCH (2026-09-03): the last `providers.read` line printed, so an identical one is not
	 * printed again. Static, because the repetition comes from many managers and many call sites
	 * within one action, not from one instance calling itself.
	 */
	private static lastReadLine: string | undefined;

	constructor(options: ProviderSettingsManagerOptions = {}) {
		this.filePath = options.filePath ?? resolveProviderSettingsPath();
		this.dataDir = options.dataDir ?? inferLegacyDataDir(this.filePath);
		if (this.dataDir || !options.filePath) {
			migrateLegacyProviderSettings({
				providerSettingsManager: this,
				dataDir: this.dataDir,
			});
		}
		ensureCustomProvidersLoadedSync(this);
		registerConfiguredProvidersFromSettings(this.read());
		// Harden permissions on any existing file at startup so that
		// pre-existing installations are also protected (best-effort; no-op on Windows).
		if (existsSync(this.filePath)) {
			try {
				chmodSync(this.filePath, 0o600);
			} catch {
				// Ignore — Windows does not support POSIX chmod.
			}
		}
	}

	getFilePath(): string {
		return this.filePath;
	}

	read(): StoredProviderSettings {
		if (!existsSync(this.filePath)) {
			return emptyStoredProviderSettings();
		}

		try {
			const raw = readFileSync(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			const result = StoredProviderSettingsSchema.safeParse(parsed);
			if (result.success) {
				registerConfiguredProvidersFromSettings(result.data);
				const clineAuth = result.data.providers["cline"]?.settings?.auth;
				// LOCAL PATCH (2026-09-03): print this line only when it says something new.
				//
				// `read()` is called many times for a single user action — fourteen call sites,
				// several inside loops — so one action produced about 150 identical copies of this
				// line, which buried everything else in the log. The reading itself is left
				// exactly as it was: the file is still read, parsed and validated on every call,
				// and the providers are still re-registered each time. Only the repetition of an
				// unchanged line is suppressed, so a line that appears is a line that changed.
				const line = `providers.read providers=[${Object.keys(result.data.providers).join(",")}] lastUsed=${result.data.lastUsedProvider ?? "none"} clineAuthPresent=${!!clineAuth?.accessToken} clineAccessTokenHash=${hashSecret(clineAuth?.accessToken)} clineRefreshTokenHash=${hashSecret(clineAuth?.refreshToken)}`;
				if (line !== ProviderSettingsManager.lastReadLine && sdkDebug(line)) {
					ProviderSettingsManager.lastReadLine = line;
				}
				return result.data;
			}
		} catch {
			// Invalid content falls back to a clean state.
		}

		return emptyStoredProviderSettings();
	}

	write(state: StoredProviderSettings): void {
		const normalized = StoredProviderSettingsSchema.parse(state);
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		// Stage to a pid-unique temp file and rename into place. Concurrent
		// Cline processes (CLI, extension, hub) share this file; a bare
		// writeFileSync lets readers catch a partial file, which read() treats
		// as empty settings — indistinguishable from being logged out.
		const tempPath = `${this.filePath}.${process.pid}.tmp`;
		try {
			writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			});
			renameSync(tempPath, this.filePath);
		} catch (error) {
			rmSync(tempPath, { force: true });
			throw error;
		}
		// Restrict file to owner-only read/write (best-effort; no-op on Windows).
		try {
			chmodSync(this.filePath, 0o600);
		} catch {
			// Ignore — Windows does not support POSIX chmod.
		}
		registerConfiguredProvidersFromSettings(normalized);
	}

	saveProviderSettings(
		settings: unknown,
		options: SaveProviderSettingsOptions = {},
	): StoredProviderSettings {
		const validatedSettings = ProviderSettingsSchema.parse(settings);
		const previous = this.read();
		const providerId = validatedSettings.provider;
		const shouldSetLastUsed = options.setLastUsed !== false;
		const previousEntry = previous.providers[providerId];
		const tokenSource =
			options.tokenSource ?? previousEntry?.tokenSource ?? "manual";
		const next: StoredProviderSettings = {
			...previous,
			providers: {
				...previous.providers,
				[providerId]: {
					settings: validatedSettings,
					updatedAt: nowIso(),
					tokenSource,
				},
			},
			lastUsedProvider: shouldSetLastUsed
				? providerId
				: previous.lastUsedProvider,
		};
		this.write(next);
		const prevClineAuth = previous.providers["cline"]?.settings?.auth;
		const nextClineAuth =
			validatedSettings.provider === "cline"
				? validatedSettings.auth
				: next.providers["cline"]?.settings?.auth;
		const authDropped =
			!!prevClineAuth?.accessToken && !nextClineAuth?.accessToken;
		sdkDebug(
			`providers.save providerId=${providerId} tokenSource=${tokenSource} clineAuthWasPresent=${!!prevClineAuth?.accessToken} clineAuthIsPresent=${!!nextClineAuth?.accessToken} authDropped=${authDropped}`,
		);
		return next;
	}

	private resolveProviderSettings(
		state: StoredProviderSettings,
		providerId: string,
	): ProviderSettings | undefined {
		const directSettings = state.providers[providerId]?.settings;
		const authHandler = getProviderAuthHandler(providerId);
		const storageProviderId = authHandler?.storageProviderId;
		if (!storageProviderId || storageProviderId === providerId) {
			return directSettings;
		}

		const authSettings = state.providers[storageProviderId]?.settings;
		if (!authSettings) {
			return directSettings;
		}

		return ProviderSettingsSchema.parse({
			...(authSettings.auth ? { auth: authSettings.auth } : {}),
			...(authSettings.apiKey ? { apiKey: authSettings.apiKey } : {}),
			...(authSettings.baseUrl ? { baseUrl: authSettings.baseUrl } : {}),
			...(directSettings ?? {}),
			provider: providerId,
		});
	}

	getProviderSettings(providerId: string): ProviderSettings | undefined {
		const state = this.read();
		return this.resolveProviderSettings(state, providerId);
	}

	getVoiceInputSettings(): VoiceInputSettings | undefined {
		return this.read().modes.voiceInput;
	}

	setVoiceInputSettings(
		settings: VoiceInputSettings | undefined,
	): StoredProviderSettings {
		const state = this.read();
		if (settings) {
			state.modes.voiceInput = VoiceInputSettingsSchema.parse(settings);
		} else {
			delete state.modes.voiceInput;
		}
		this.write(state);
		return state;
	}

	private resolveLastUsedProviderId(
		state: StoredProviderSettings,
		options: ResolveLastUsedProviderSettingsOptions,
	): string | undefined {
		const providerId = state.lastUsedProvider;
		if (
			providerId === CLINE_PASS_PROVIDER_ID &&
			options.isClinePassEnabled === false
		) {
			return CLINE_PROVIDER_ID;
		}

		return providerId;
	}

	getLastUsedProviderSettings(
		options: ResolveLastUsedProviderSettingsOptions = {},
	): ProviderSettings | undefined {
		const state = this.read();
		const providerId = this.resolveLastUsedProviderId(state, options);
		if (!providerId) {
			return undefined;
		}
		return this.resolveProviderSettings(state, providerId);
	}

	getProviderConfig(
		providerId: string,
		options?: ToProviderConfigOptions,
	): ProviderConfig | undefined {
		const settings = this.getProviderSettings(providerId);
		if (!settings) {
			return undefined;
		}
		return toProviderConfig(settings, options);
	}

	getLastUsedProviderConfig(
		options: ToProviderConfigOptions &
			ResolveLastUsedProviderSettingsOptions = {},
	): ProviderConfig | undefined {
		const settings = this.getLastUsedProviderSettings(options);
		if (!settings) {
			return undefined;
		}
		return toProviderConfig(settings, options);
	}

	async refreshCatalog(): Promise<void> {
		try {
			await getLiveModelsCatalog({});
		} catch {
			// Ignore errors
		}
	}
}
