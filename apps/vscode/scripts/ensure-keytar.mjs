#!/usr/bin/env node

// Make `keytar` actually loadable after an install, so vsce can reach the OS credential store.
//
// WHY THIS EXISTS
// ---------------
// `keytar` is a native module: part of it is compiled machine code (`build/Release/keytar.node`)
// that must match the CPU it runs on. It ships prebuilt binaries per platform/arch, and its own
// `install` script (`prebuild-install || npm run build`) is supposed to fetch the right one.
//
// On this project that does not reliably happen. Observed on an arm64 Mac (2026-08-28):
//   - bun skips a dependency's install scripts unless the package is listed in the root
//     package.json `trustedDependencies` — so keytar arrived as source with no binary at all; and
//   - even once trusted, the binary that landed was **x86_64**, which cannot load on arm64.
//
// When `require('keytar')` throws, vsce does not fail loudly. It prints
//   "Failed to open credential store. Falling back to storing secrets clear-text in ~/.vsce"
// and writes your Marketplace PAT to a plain file. So a silent native-module failure downgrades
// credential storage from the Keychain to plaintext on disk. That is the reason this runs
// automatically rather than living in a doc nobody reads.
//
// WHAT IT DOES
// ------------
// 1. Works out the REAL hardware architecture (see the warning below), not the running process's.
// 2. If keytar loads AND its binary matches that architecture, exits immediately.
// 3. Otherwise re-fetches the prebuild for the real architecture.
// 4. Always exits 0. A missing credential store is a degraded convenience, never a reason to
//    break `bun install` — CI images in particular have no Keychain to talk to.
//
// ⚠️  DO NOT USE `process.arch` HERE. It reports the architecture of the process running this
// script, which is NOT always the machine's. Observed 2026-08-28: run from bun's install
// lifecycle on an arm64 Mac, `process.arch` came back **x64**, so an earlier version of this file
// fetched the Intel prebuild — and then its own "does it load?" check PASSED, because inside that
// x64 process the x64 binary loads perfectly well. It declared success while installing exactly
// the wrong binary, which vsce would later fail to load in an arm64 process. Ask the hardware
// (`sysctl hw.optional.arm64` on macOS), and verify the fetched binary's arch afterwards.

import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(import.meta.url)

const say = (message) => console.log(`[ensure-keytar] ${message}`)

/**
 * The architecture of the MACHINE, which is not necessarily `process.arch` — see the warning at
 * the top of this file. On macOS the hardware answers directly and is unaffected by whether this
 * process happens to be running translated.
 */
function machineArch() {
	if (process.platform === "darwin") {
		try {
			const isAppleSilicon = execFileSync("sysctl", ["-n", "hw.optional.arm64"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim()
			return isAppleSilicon === "1" ? "arm64" : "x64"
		} catch {
			// sysctl has no such key on Intel Macs; fall through.
			return "x64"
		}
	}
	return process.arch
}

const targetArch = machineArch()

/** Whether the compiled binary at `file` is built for `targetArch`. */
function binaryMatchesTarget(file) {
	try {
		const described = execFileSync("file", ["-b", file], { encoding: "utf8" })
		return targetArch === "arm64" ? described.includes("arm64") : described.includes("x86_64")
	} catch {
		return false
	}
}

function keytarLoads() {
	try {
		require("keytar")
		return true
	} catch {
		return false
	}
}

let keytarDir
try {
	// Resolve the real package directory, wherever the package manager put it — bun stores the
	// physical copy under node_modules/.bun/... and symlinks to it, so never assume a path.
	keytarDir = path.dirname(require.resolve("keytar/package.json"))
} catch {
	say("keytar is not installed; nothing to repair.")
	process.exit(0)
}

const binary = path.join(keytarDir, "build", "Release", "keytar.node")

// Both conditions matter. A binary can load in THIS process and still be the wrong one for the
// machine (the x64-under-bun case in the warning above), so the architecture is checked too.
if (existsSync(binary) && binaryMatchesTarget(binary) && keytarLoads()) {
	process.exit(0)
}

// A binary of the wrong architecture is worse than none: prebuild-install considers the build
// directory already populated and skips the download.
const buildDir = path.join(keytarDir, "build")
if (existsSync(buildDir)) {
	rmSync(buildDir, { recursive: true, force: true })
}

say(`fetching the ${process.platform}-${targetArch} prebuild...`)
try {
	execFileSync("npx", ["--yes", "prebuild-install", "-r", "napi", "--arch", targetArch, "--platform", process.platform], {
		cwd: keytarDir,
		stdio: "inherit",
	})
} catch {
	say("could not fetch a prebuild. vsce will fall back to storing credentials in clear text.")
	process.exit(0)
}

if (existsSync(binary) && binaryMatchesTarget(binary)) {
	say(`keytar is built for ${targetArch}; the OS credential store is available.`)
} else {
	say("the fetched binary does not match this machine; vsce will fall back to clear text.")
}
process.exit(0)
