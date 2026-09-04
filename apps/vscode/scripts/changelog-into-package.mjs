#!/usr/bin/env node

// Cline Cubed: copy the CHANGELOG into the package at package time.
//
// `vsce` reads CHANGELOG.md only from the package root (apps/vscode/), and the fork's CHANGELOG
// lives at the repo root — the right place for upstream and for the CI gate, so it stays there.
// Without this step the package carries no changelog at all: the Marketplace's Changelog tab is
// empty, and the extension has nothing to show as "What's New". This script writes two files
// beside package.json, both generated and gitignored:
//
//   whats-new.md  — the body of the `## [<version>]` section for the version in package.json,
//                   without its heading line. The chat home's What's New modal renders it.
//   CHANGELOG.md  — the fork's own sections, newest first, from the top of the repo-root file
//                   down to the fork's first release. The Marketplace's Changelog tab reads it.
//
// A missing section for the running version stops the build: the publish workflow already
// refuses to publish without one, and a package that cannot say what changed is not finished.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const packageRoot = path.join(__dirname, "..")
const repoRoot = path.join(packageRoot, "..", "..")

// The fork's first published release. Every section at or above it is the fork's; the sections
// below it are stock Cline's history, which the fork's Changelog tab does not repeat.
const FIRST_FORK_RELEASE = "4.1.15"

const SOURCE = path.join(repoRoot, "CHANGELOG.md")
const WHATS_NEW = path.join(packageRoot, "whats-new.md")
const PACKAGE_CHANGELOG = path.join(packageRoot, "CHANGELOG.md")

function compareVersions(a, b) {
	const pa = a.split(".").map(Number)
	const pb = b.split(".").map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0
		const y = pb[i] ?? 0
		if (Number.isNaN(x) || Number.isNaN(y)) {
			return Number.NaN
		}
		if (x !== y) {
			return x - y
		}
	}
	return 0
}

const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8")).version
const changelog = fs.readFileSync(SOURCE, "utf-8")

// Split the file into its `## [x.y.z]` sections. Each section runs from its heading line to the
// next heading (or the end of the file); the text before the first heading is the preamble.
const headingPattern = /^## \[([^\]]+)\][^\n]*\n/gm
const sections = []
let preamble = ""
let match = headingPattern.exec(changelog)
if (match) {
	preamble = changelog.slice(0, match.index)
}
while (match) {
	const headingEnd = match.index + match[0].length
	const next = headingPattern.exec(changelog)
	const sectionEnd = next ? next.index : changelog.length
	sections.push({
		version: match[1],
		heading: match[0],
		body: changelog.slice(headingEnd, sectionEnd),
	})
	match = next
}

const running = sections.find((s) => s.version === version)
if (!running) {
	console.error(`changelog-into-package: ${SOURCE} has no "## [${version}]" section — add it before packaging.`)
	process.exit(1)
}

const forkSections = sections.filter((s) => {
	const order = compareVersions(s.version, FIRST_FORK_RELEASE)
	return !Number.isNaN(order) && order >= 0
})

fs.writeFileSync(WHATS_NEW, `${running.body.trim()}\n`)
fs.writeFileSync(PACKAGE_CHANGELOG, preamble + forkSections.map((s) => s.heading + s.body).join(""))

console.log(
	`changelog-into-package: wrote whats-new.md (${version}) and CHANGELOG.md (${forkSections.length} fork sections, ${forkSections[forkSections.length - 1].version} and up)`,
)
