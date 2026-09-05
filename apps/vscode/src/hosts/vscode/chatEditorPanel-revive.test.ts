/**
 * Cline Cubed: a chat tab that VS Code revives after a window reload must render.
 *
 * VS Code builds a revived webview from the options it SERIALIZED last session — 1.106's
 * `deserializeWebviewPanel` constructs it from `r.webviewOptions` — and hands the extension that
 * panel with no say in the matter. So a revived panel arrives still restricted to the install
 * directory of the version that was running when the window closed. After an UPDATE that
 * directory is gone, the new build lives in its own, and the HTML the fork writes points at
 * assets outside the panel's allowed root. The webview refuses them SILENTLY: nothing throws,
 * nothing reaches any log, and the tab comes back with its title and a black body. That is what
 * Doug hit on 2026-09-04 installing 4.1.24 over 4.1.23 with a chat open at Home.
 *
 * So the revive path must re-root the panel in the extension that is ACTUALLY running, and it
 * must do so BEFORE the HTML is written — HTML naming assets outside the current root is refused
 * whatever is set afterwards.
 */

import { beforeEach, describe, expect, it, vi } from "vitest"

const RUNNING_EXTENSION_DIR = "/Applications/exts/DougJoseph.cline-cubed-4.1.24"

vi.mock("vscode", () => {
	class Uri {
		constructor(public fsPath: string) {}
		static file(fsPath: string) {
			return new Uri(fsPath)
		}
		static joinPath(base: Uri, ...parts: string[]) {
			return new Uri([base.fsPath, ...parts].join("/"))
		}
		toString() {
			return this.fsPath
		}
	}
	return {
		Uri,
		ViewColumn: { Active: -1, Beside: -2, One: 1 },
		window: { createWebviewPanel: vi.fn(), onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })) },
		commands: { executeCommand: vi.fn() },
		workspace: { getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
	}
})

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { get: () => ({ extensionFsPath: RUNNING_EXTENSION_DIR }) },
}))

vi.mock("@core/controller/chat-surfaces", () => ({
	bindChatSurfaceToSession: vi.fn(),
	chatSurfaceForSession: vi.fn(),
	clearSessionRestoring: vi.fn(),
	markSessionRestoring: vi.fn(),
	onChatTitleChanged: vi.fn(() => vi.fn()),
	registerChatSurface: vi.fn(),
	sessionForChatSurface: vi.fn(),
	setActiveChatSurface: vi.fn(),
	setChatSurfaceEvictionNotifier: vi.fn(),
	unregisterChatSurface: vi.fn(),
}))

vi.mock("@core/webview/WebviewProvider", () => ({ mintSurfaceId: vi.fn(() => "surface-1") }))
vi.mock("@hosts/vscode/lifecycle-table", () => ({ recordLifecycleEvent: vi.fn() }))
vi.mock("@/core/controller/grpc-handler", () => ({ handleGrpcRequest: vi.fn(), handleGrpcRequestCancel: vi.fn() }))
vi.mock("@/registry", () => ({ ExtensionRegistryInfo: { id: "DougJoseph.cline-cubed", commands: {} } }))
vi.mock("@/shared/services/Logger", () => ({
	Logger: { debug: vi.fn(), error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))
vi.mock("./VscodeWebviewProvider", () => ({ VscodeWebviewProvider: class {} }))

/** What a webview's own options carry — the root is the part an update invalidates. */
interface WebviewOptions {
	enableScripts?: boolean
	localResourceRoots?: { fsPath: string }[]
}

/** A panel shaped like the one VS Code hands `deserializeWebviewPanel`, recording write order. */
function revivedPanel(writes: string[]) {
	const webview = {
		// What VS Code restores: the PREVIOUS version's install directory.
		_options: {
			enableScripts: true,
			localResourceRoots: [{ fsPath: "/Applications/exts/DougJoseph.cline-cubed-4.1.23" }],
		} as WebviewOptions,
		_html: "",
		get options(): WebviewOptions {
			return this._options
		},
		set options(value: WebviewOptions) {
			writes.push("options")
			this._options = value
		},
		get html() {
			return this._html
		},
		set html(value: string) {
			writes.push("html")
			this._html = value
		},
		cspSource: "vscode-webview:",
		asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `webview://${uri.fsPath}` }),
		onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
		postMessage: vi.fn(),
	}
	return {
		webview,
		viewColumn: 1,
		title: "Cline Cubed",
		iconPath: undefined as unknown,
		visible: true,
		active: true,
		onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
		onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
		reveal: vi.fn(),
		dispose: vi.fn(),
	}
}

function provider() {
	return {
		getHtmlContent: vi.fn(() => "<html>…</html>"),
		controller: { showTaskWithId: vi.fn().mockResolvedValue(undefined) },
	}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("adoptRevivedChatPanel — a revived tab renders after an update", () => {
	it("re-roots the panel in the extension that is actually running", async () => {
		const { adoptRevivedChatPanel } = await import("./chatEditorPanel")
		const writes: string[] = []
		const panel = revivedPanel(writes)

		await adoptRevivedChatPanel(
			{ extensionUri: { fsPath: RUNNING_EXTENSION_DIR } as never },
			provider() as never,
			panel as never,
			undefined,
		)

		const roots = panel.webview.options.localResourceRoots ?? []
		expect(roots.map((root) => root.fsPath)).toEqual([RUNNING_EXTENSION_DIR])
		expect(panel.webview.options.enableScripts).toBe(true)
	})

	it("sets the root BEFORE the HTML — afterwards is too late", async () => {
		const { adoptRevivedChatPanel } = await import("./chatEditorPanel")
		const writes: string[] = []
		const panel = revivedPanel(writes)

		await adoptRevivedChatPanel(
			{ extensionUri: { fsPath: RUNNING_EXTENSION_DIR } as never },
			provider() as never,
			panel as never,
			undefined,
		)

		expect(writes.indexOf("options")).toBeGreaterThanOrEqual(0)
		expect(writes.indexOf("options")).toBeLessThan(writes.indexOf("html"))
	})
})
