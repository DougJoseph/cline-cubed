/**
 * Simple Logger utility for the extension's backend code.
 */
export class Logger {
	private static isVerbose = process.env.IS_DEV === "true"

	/**
	 * Cline Cubed: the ONE master debug-logging switch (General Settings → Debug logging),
	 * off by default and flipped at runtime on a shipped build.
	 *
	 * It is TOLD, never asks: `Logger` is called from code that has no controller and no
	 * async context, so the extension host pushes the value in — at activation from the
	 * persisted setting, and again whenever the user changes it.
	 *
	 * `error` and `warn` are never gated by it. Gating a real failure is how a live problem
	 * leaves no trace, which is the opposite of what a log is for.
	 */
	private static debugEnabled = false

	/** Set the master debug-logging switch. See `debugEnabled`. */
	static setDebugEnabled(enabled: boolean): void {
		Logger.debugEnabled = enabled
	}

	/** Whether debug-level output is currently being emitted. */
	static isDebugEnabled(): boolean {
		return Logger.debugEnabled
	}

	private static subscribers: Set<(msg: string) => void> = new Set()

	private static output(msg: string): void {
		for (const subscriber of Logger.subscribers) {
			try {
				subscriber(msg)
			} catch {
				// ignore errors from subscribers
			}
		}
	}

	/**
	 * Register a callback to receive log output messages.
	 */
	static subscribe(outputFn: (msg: string) => void) {
		Logger.subscribers.add(outputFn)
	}

	static error(message: string, ...args: any[]) {
		Logger.#output("ERROR", message, undefined, args)
	}

	static warn(message: string, ...args: any[]) {
		Logger.#output("WARN", message, undefined, args)
	}

	static log(message: string, ...args: any[]) {
		if (!Logger.debugEnabled) {
			return
		}
		Logger.#output("LOG", message, undefined, args)
	}

	static debug(message: string, ...args: any[]) {
		if (!Logger.debugEnabled) {
			return
		}
		Logger.#output("DEBUG", message, undefined, args)
	}

	static info(message: string, ...args: any[]) {
		if (!Logger.debugEnabled) {
			return
		}
		Logger.#output("INFO", message, undefined, args)
	}

	static trace(message: string, ...args: any[]) {
		if (!Logger.debugEnabled) {
			return
		}
		Logger.#output("TRACE", message, undefined, args)
	}

	/**
	 * Cline Cubed: value patterns that must never reach the output channel, whatever the
	 * debug switch says.
	 *
	 * Turning the volume down is not the same as it being acceptable to print credential
	 * material: someone who enables debug logging to diagnose a problem, and then pastes the
	 * channel into an issue, has published whatever it contained. So redaction happens at the
	 * SINK, once, rather than at each call site — it covers lines this fork does not own (the
	 * SDK's `providers.read` line, which prints `clineAccessTokenHash` / `clineRefreshTokenHash`,
	 * arrives here through `setSdkLogger`) and it keeps covering them across upstream pulls,
	 * with no patch to carry.
	 *
	 * The trade this accepts: matching only catches what it describes, so a new key holding
	 * secret-ish material prints until it is covered here. Treat this as maintained rather than
	 * complete. Both forms replace only the VALUE, so the line still says which key was seen: a
	 * redacted line is evidence, a deleted line is a mystery.
	 */
	static readonly #REDACTED_KEYS = [
		"accessToken",
		"refreshToken",
		"apiKey",
		"api_key",
		"authorization",
		// Who the person is. Not credentials — but a log someone pastes into an issue should not
		// carry their address and name because they turned debug logging on to diagnose something.
		"email",
		"displayName",
		"device_id",
		"deviceId",
	]

	/** Replace the VALUE of any sensitive key, keeping the key visible. See `#REDACTED_KEYS`. */
	static #redact(text: string): string {
		let out = text
		// ANY key whose NAME ends in `Hash` — the SDK's `hashSecret()` fingerprints. A pattern
		// rather than a list, because the same two credentials print under ELEVEN spellings in this
		// codebase: accessHash, accessTokenHash, clineAccessTokenHash, clineRefreshTokenHash,
		// currentTokenHash, newAccessTokenHash, newRefreshTokenHash, newTokenHash, refreshHash,
		// refreshTokenHash, tokenHash. A pattern covers every one of them, and covers the next
		// spelling someone adds without anyone having to notice it.
		// The digests are SHA-256 truncated to 8 hex digits (`sdk/.../logging/early-logger.ts`), so
		// they do not expose a token; they are stable per value, which is enough to correlate one
		// person's logs across time and files, and they cost nothing to withhold.
		out = out.replace(/(\b[A-Za-z_][A-Za-z0-9_]*Hash=)[^\s,;)\]}"']+/g, "$1<redacted>")
		out = out.replace(/(["'][A-Za-z_][A-Za-z0-9_]*Hash["']\s*:\s*)(["'])[^"']*\2/g, '$1"<redacted>"')
		for (const key of Logger.#REDACTED_KEYS) {
			// key=value — the value ends at whitespace, a comma, a semicolon, a closing bracket of
			// any kind, or a quote. The closing brackets matter: values are commonly written as
			// `(tokenHash=abc123)` or `keys=[apiKey=x]`, and a terminator set without `)` and `]`
			// swallows the bracket along with the value, leaving a line that reads as truncated.
			out = out.replace(new RegExp(`(\\b${key}=)[^\\s,;)\\]}"']+`, "gi"), "$1<redacted>")
			// "key": "value" and 'key': 'value'
			out = out.replace(new RegExp(`(["']${key}["']\\s*:\\s*)(["'])[^"']*\\2`, "gi"), '$1"<redacted>"')
		}
		return out
	}

	static #output(level: string, message: string, error: Error | undefined, args: any[]) {
		try {
			let fullMessage = message
			if (Logger.isVerbose && args.length > 0) {
				fullMessage += ` ${args.map((arg) => JSON.stringify(arg)).join(" ")}`
			}
			const errorSuffix = error?.message ? ` ${error.message}` : ""
			const ts = new Date().toISOString()
			Logger.output(Logger.#redact(`${ts} ${level} ${fullMessage}${errorSuffix}`.trimEnd()))
		} catch {
			// do nothing if Logger fails
		}
	}
}
