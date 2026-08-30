/**
 * Run every debug-harness scenario, in order, and report one tally.
 *
 * Each scenario runs as its own process so a crash in one cannot take the rest down, and so each
 * keeps its own exit-code contract: 0 = passed, 1 = an assertion failed, 2 = could not run.
 * "Could not run" is reported separately from "failed" all the way up, because a broken harness
 * and a broken product need different responses and must never be confused for one another.
 *
 * PREREQUISITES (see ../README.md):
 *   bun run protos && IS_DEV=true bun esbuild.mjs
 *   node src/dev/debug-harness/server.ts --skip-build --auto-launch
 *
 * RUN:
 *   bun src/dev/debug-harness/scenarios/all.ts
 */

import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Cheapest and most fundamental first, so a basic breakage is reported before the long ones. */
const SCENARIOS = [
	"concurrent-chats.ts",
	"chat-isolation.ts",
	"pending-ask-isolation.ts",
	"cancel-scoping.ts",
	"error-attribution.ts",
	"resume-identity.ts",
	"tab-focus-isolation.ts",
	"in-chat-close.ts",
	"chat-placement.ts",
]

function runOne(file: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: "inherit" })
		child.on("close", (code) => resolve(code ?? 2))
		child.on("error", () => resolve(2))
	})
}

async function main(): Promise<void> {
	const outcomes: { file: string; code: number }[] = []
	for (const file of SCENARIOS) {
		console.log(`\n${"═".repeat(72)}\n▶  ${file}\n${"═".repeat(72)}`)
		outcomes.push({ file, code: await runOne(file) })
	}

	const passed = outcomes.filter((o) => o.code === 0)
	const failed = outcomes.filter((o) => o.code === 1)
	const broken = outcomes.filter((o) => o.code !== 0 && o.code !== 1)

	console.log(`\n${"═".repeat(72)}\nSCENARIO SUMMARY\n${"═".repeat(72)}`)
	for (const { file, code } of outcomes) {
		console.log(`  ${code === 0 ? "PASS " : code === 1 ? "FAIL " : "BROKE"}  ${file}`)
	}
	console.log(`\n${passed.length} passed, ${failed.length} failed, ${broken.length} could not run\n`)

	// Exit 1 for a real failure, 2 if any scenario could not run at all.
	process.exit(broken.length > 0 ? 2 : failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
	console.error(`\nRunner aborted: ${err.message}\n`)
	process.exit(2)
})
