import { defineConfig } from "@vscode/test-cli"
import os from "os"
import path from "path"

const vscodeTestVersion = process.env.VSCODE_TEST_VERSION ?? "stable"

/**
 * Where VS Code keeps its profile during a test run — deliberately OUTSIDE the repo, and short.
 *
 * VS Code opens a Unix domain socket inside this directory, and such a path cannot exceed ~104
 * characters. The default that `@vscode/test-electron` supplies is
 * `<repo>/apps/vscode/.vscode-test/user-data`, which from a checkout of any depth pushes the
 * socket past that limit: VS Code then dies with `listen EINVAL` before a single test runs, after
 * printing a warning that is easy to read as harmless.
 *
 * `os.tmpdir()` is not the answer on macOS — it resolves to a long `/var/folders/...` path and
 * reintroduces the same fault — so POSIX gets a short fixed path and Windows, which has no such
 * socket-length limit, uses its temp directory.
 */
const userDataDir = process.platform === "win32" ? path.join(os.tmpdir(), "vsct-cc") : "/tmp/vsct-cc"

export default defineConfig({
	files: [
		"out/src/{core,test,utils,shared,integrations,hosts,services}/**/*.test.js",
		"src/{core,test,utils,shared,integrations,hosts,services}/**/*.test.js",
		// The bun unit suite (src/**/__tests__/* and src/test/services/**) runs under
		// `bun test` (run-bun-unit-tests.ts) and imports `bun:test`, which this
		// Node-based runner cannot load. Exclude it here.
		"!out/src/**/__tests__/**/*.test.js",
		"!out/src/test/services/**/*.test.js",
		"!src/**/__tests__/**/*.test.js",
		"!src/test/services/**/*.test.js",
	],
	mocha: {
		ui: "bdd",
		timeout: 20000, // Maximum time (in ms) that a test can run before failing
		/** Set up alias path resolution during tests
		 * @See {@link file://./test-setup.js}
		 */
		require: ["./test-setup.js"],
	},
	workspaceFolder: "test-workspace",
	version: vscodeTestVersion,
	extensionDevelopmentPath: path.resolve("./"),
	// `@vscode/test-electron` only supplies its own `--user-data-dir` when none is given
	// (its util.js checks `hasArg('user-data-dir', ...)`), so passing one here replaces it
	// rather than colliding with it.
	launchArgs: ["--disable-extensions", `--user-data-dir=${userDataDir}`],
})
