import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	addAlwaysRememberedEntry,
	buildAlwaysRememberedPrompt,
	describeAlwaysRememberedIssues,
	groupAutomaticRuleLocations,
	isLocalEndpoint,
	isRefusedSecretsFile,
	loadAlwaysRememberedFiles,
	moveAlwaysRememberedEntry,
	removeAlwaysRememberedEntry,
	resolveAlwaysRememberedPath,
	shareOfContextWindow,
} from "./always-remembered-files"

let root: string

function write(name: string, content: string): string {
	const filePath = join(root, name)
	mkdirSync(join(filePath, ".."), { recursive: true })
	writeFileSync(filePath, content)
	return filePath
}

function load(entries: string[], ruleSearchPaths: string[] = []) {
	return loadAlwaysRememberedFiles(entries, { workspaceRoot: root, ruleSearchPaths })
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "always-remembered-"))
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe("resolveAlwaysRememberedPath", () => {
	it("resolves home, absolute, and workspace-relative paths", () => {
		expect(resolveAlwaysRememberedPath("~/notes/a.md", "/work")).toBe(join(homedir(), "notes/a.md"))
		expect(resolveAlwaysRememberedPath("/etc/a.md", "/work")).toBe("/etc/a.md")
		expect(resolveAlwaysRememberedPath("docs/a.md", "/work")).toBe("/work/docs/a.md")
	})
})

describe("loadAlwaysRememberedFiles", () => {
	it("keeps the listed order and each file whole", async () => {
		const long = "x".repeat(250_000)
		const first = write("b.md", long)
		const second = write("a.md", "second")

		const files = await load([first, second])

		expect(files.map((file) => file.resolvedPath)).toEqual([first, second])
		expect(files[0].content).toBe(long)
		expect(files[0].chars).toBe(250_000)
		expect(files[0].status).toBe("ok")
	})

	it("produces byte-identical output across runs", async () => {
		const first = write("a.md", "alpha")
		const second = write("b.md", "beta")

		const one = buildAlwaysRememberedPrompt(await load([first, second]))
		const two = buildAlwaysRememberedPrompt(await load([first, second]))

		expect(one).toBe(two)
		expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}/)
	})

	it("leaves an @ line as plain text and never opens its target", async () => {
		const target = write("private.md", "PRIVATE TARGET TEXT")
		const contract = write("contract.md", `Rules\n@${target}\nMore rules`)

		const files = await load([contract])
		const prompt = buildAlwaysRememberedPrompt(files)

		expect(files).toHaveLength(1)
		expect(prompt).toContain(`@${target}`)
		expect(prompt).not.toContain("PRIVATE TARGET TEXT")
	})

	it("includes a file listed twice only once", async () => {
		const file = write("a.md", "alpha")

		const files = await load([file, file])

		expect(files).toHaveLength(1)
	})

	it("reports a missing listed file and tells the agent it failed", async () => {
		const missing = join(root, "gone.md")

		const files = await load([missing])
		const prompt = buildAlwaysRememberedPrompt(files)

		expect(files[0].status).toBe("missing")
		expect(prompt).toContain(missing)
		expect(prompt).toContain("failed to load")
	})

	it("reports a directory as unreadable", async () => {
		mkdirSync(join(root, "folder"))

		const files = await load([join(root, "folder")])

		expect(files[0].status).toBe("unreadable")
	})

	it("refuses a secrets file without reading it", async () => {
		const secret = write(".env", "API_KEY=do-not-send")

		const files = await load([secret])
		const prompt = buildAlwaysRememberedPrompt(files)

		expect(files[0].status).toBe("refused")
		expect(files[0].content).toBeUndefined()
		expect(prompt).not.toContain("do-not-send")
	})

	it("includes a file the rules watcher already loads only once", async () => {
		const rulesDir = join(root, ".clinerules")
		const rule = write(".clinerules/rule.md", "rule body")

		const files = await load([rule], [rulesDir])
		const prompt = buildAlwaysRememberedPrompt(files)

		expect(files[0].status).toBe("ok")
		expect(files[0].alreadyLoadedAsRule).toBe(true)
		expect(prompt).not.toContain("rule body")
	})

	it("keeps a rule-folder file whose frontmatter could disable it", async () => {
		const rulesDir = join(root, ".clinerules")
		const rule = write(".clinerules/rule.md", "---\ndisabled: true\n---\nrule body")

		const files = await load([rule], [rulesDir])

		expect(files[0].alreadyLoadedAsRule).toBe(false)
		expect(buildAlwaysRememberedPrompt(files)).toContain("rule body")
	})

	it.each(["rule.txt", "rule.markdown", "RULE.MD"])("includes %s from a rules folder only once", async (name) => {
		const rulesDir = join(root, ".clinerules")
		const rule = write(`.clinerules/${name}`, "rule body")

		const files = await load([rule], [rulesDir])

		expect(files[0].alreadyLoadedAsRule).toBe(true)
		expect(buildAlwaysRememberedPrompt(files)).not.toContain("rule body")
	})

	it("includes a single-file .clinerules only once", async () => {
		const rule = write(".clinerules", "rule body")

		const files = await load([rule], [rule])

		expect(files[0].alreadyLoadedAsRule).toBe(true)
		expect(buildAlwaysRememberedPrompt(files)).not.toContain("rule body")
	})

	it("keeps a file type the rules loader does not read", async () => {
		const rulesDir = join(root, ".clinerules")
		const other = write(".clinerules/notes.json", "{}")

		const files = await load([other], [rulesDir])

		expect(files[0].alreadyLoadedAsRule).toBe(false)
	})

	it("keeps a file in a subfolder of a rules folder", async () => {
		const rulesDir = join(root, ".clinerules")
		const nested = write(".clinerules/deep/rule.md", "nested body")

		const files = await load([nested], [rulesDir])

		expect(files[0].alreadyLoadedAsRule).toBe(false)
	})
})

describe("groupAutomaticRuleLocations", () => {
	it("separates workspace locations from global ones and shortens both", () => {
		const home = "/home/user"
		const global = ["/home/user/.agents/AGENTS.md", "/home/user/.cline/rules", "/home/user/Documents/Cline/Rules"]
		const workspace = ["/work/app/AGENTS.md", "/work/app/.clinerules", "/work/app/.cline/rules", ...global]

		expect(groupAutomaticRuleLocations(workspace, global, "/work/app", home)).toEqual({
			workspace: ["AGENTS.md", ".clinerules", ".cline/rules"],
			global: ["~/.agents/AGENTS.md", "~/.cline/rules", "~/Documents/Cline/Rules"],
		})
	})
})

describe("buildAlwaysRememberedPrompt", () => {
	it("is empty when nothing is listed", () => {
		expect(buildAlwaysRememberedPrompt([])).toBe("")
	})

	it("frames the files as the standing work contract under their full paths", async () => {
		const file = write("contract.md", "Never guess.")

		const prompt = buildAlwaysRememberedPrompt(await load([file]))

		expect(prompt).toContain("standing work contract")
		expect(prompt).toContain(file)
		expect(prompt).toContain("Never guess.")
	})
})

describe("isRefusedSecretsFile", () => {
	it.each([".env", ".env.local", ".ENV", "/a/b/.env.production"])("refuses %s", (name) => {
		expect(isRefusedSecretsFile(name)).toBe(true)
	})

	it.each(["env.md", "my.env.md", "README.md", ".environment"])("allows %s", (name) => {
		expect(isRefusedSecretsFile(name)).toBe(false)
	})
})

describe("isLocalEndpoint", () => {
	it.each([
		"http://localhost:8080/v1",
		"http://127.0.0.1:1234",
		"http://[::1]:8000",
		"http://10.0.0.5/v1",
		"http://172.16.4.2/v1",
		"http://192.168.1.20:8000/v1",
		"http://model-server.local:8000/v1",
	])("treats %s as local", (url) => {
		expect(isLocalEndpoint("openai", url)).toBe(true)
	})

	it.each([
		"https://api.deepseek.com/v1",
		"http://172.32.0.1/v1",
		"https://local.example.com",
		"not a url",
	])("treats %s as remote", (url) => {
		expect(isLocalEndpoint("openai", url)).toBe(false)
	})

	it("treats a hosted provider with no base URL as remote", () => {
		expect(isLocalEndpoint("anthropic", undefined)).toBe(false)
	})

	it("treats local providers on their default address as local", () => {
		expect(isLocalEndpoint("ollama", undefined)).toBe(true)
		expect(isLocalEndpoint("lmstudio", undefined)).toBe(true)
	})
})

describe("shareOfContextWindow", () => {
	it("computes the share from the saved window", () => {
		expect(shareOfContextWindow(47_000, 262_144)).toBeCloseTo(0.179, 3)
		expect(shareOfContextWindow(47_000, 458_752)).toBeCloseTo(0.102, 3)
	})

	it("returns undefined without a window", () => {
		expect(shareOfContextWindow(47_000, undefined)).toBeUndefined()
	})
})

describe("describeAlwaysRememberedIssues", () => {
	it("names failed files", async () => {
		const missing = join(root, "gone.md")

		const issues = describeAlwaysRememberedIssues(await load([missing]), { endpointIsLocal: true })

		expect(issues).toHaveLength(1)
		expect(issues[0]).toContain(missing)
	})

	it("warns when files go to a remote endpoint", async () => {
		const file = write("a.md", "alpha")
		const files = await load([file])

		expect(describeAlwaysRememberedIssues(files, { endpointIsLocal: true })).toEqual([])
		expect(describeAlwaysRememberedIssues(files, { endpointIsLocal: false })[0]).toContain("remote")
	})

	it("reports when the files alone reach the compaction trigger", async () => {
		const file = write("a.md", "x".repeat(3_000))

		const issues = describeAlwaysRememberedIssues(await load([file]), {
			endpointIsLocal: true,
			compactionTriggerTokens: 500,
		})

		expect(issues[0]).toContain("compaction")
	})
})

describe("list editing", () => {
	it("adds a typed path as written", async () => {
		const file = write("a.md", "alpha")

		const result = await addAlwaysRememberedEntry([], `  ${file}  `, root)

		expect(result).toEqual({ entries: [file] })
	})

	it("refuses a duplicate, even under a different spelling", async () => {
		write("a.md", "alpha")

		const result = await addAlwaysRememberedEntry([join(root, "a.md")], "a.md", root)

		expect(result.error).toContain("already")
		expect(result.entries).toEqual([join(root, "a.md")])
	})

	it("refuses a secrets file", async () => {
		const secret = write(".env", "KEY=1")

		const result = await addAlwaysRememberedEntry([], secret, root)

		expect(result.error).toContain("secrets")
		expect(result.entries).toEqual([])
	})

	it("refuses a path that does not exist", async () => {
		const result = await addAlwaysRememberedEntry([], join(root, "typo.md"), root)

		expect(result.error).toContain("not found")
		expect(result.entries).toEqual([])
	})

	it("refuses a directory", async () => {
		mkdirSync(join(root, "folder"))

		const result = await addAlwaysRememberedEntry([], join(root, "folder"), root)

		expect(result.error).toContain("not a file")
	})

	it("removes one row and leaves the file on disk", async () => {
		const file = write("a.md", "alpha")

		expect(removeAlwaysRememberedEntry([file, "other.md"], file)).toEqual(["other.md"])
		expect((await load([file]))[0].status).toBe("ok")
	})

	it("moves a row up and down and stops at the ends", () => {
		const list = ["a", "b", "c"]

		expect(moveAlwaysRememberedEntry(list, "b", -1)).toEqual(["b", "a", "c"])
		expect(moveAlwaysRememberedEntry(list, "b", 1)).toEqual(["a", "c", "b"])
		expect(moveAlwaysRememberedEntry(list, "a", -1)).toEqual(list)
		expect(moveAlwaysRememberedEntry(list, "c", 1)).toEqual(list)
	})
})
