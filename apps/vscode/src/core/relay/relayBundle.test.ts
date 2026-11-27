import { strict as assert } from "node:assert"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it } from "vitest"
import { buildRelayInstaller, createInstallToken, writeRelayInstaller } from "./relayBundle"

const VERSION = "4.1.29"
const TOKEN = "a".repeat(32)

const installer = () => buildRelayInstaller(VERSION, TOKEN)

describe("createInstallToken", () => {
	it("is 32 hex characters and different every time", () => {
		const first = createInstallToken()
		const second = createInstallToken()
		assert.match(first, /^[0-9a-f]{32}$/)
		assert.notEqual(first, second)
	})
})

describe("buildRelayInstaller", () => {
	it("is one PHP file, not a folder of files", () => {
		const php = installer()
		assert.equal(typeof php, "string")
		assert.ok(php.startsWith("<?php"))
	})

	it("stamps the exporting version and carries the export's token", () => {
		const php = installer()
		assert.ok(php.includes("const RELAY_VERSION = '4.1.29';"))
		assert.ok(php.includes("const INSTALL_TOKEN = '" + TOKEN + "';"))
	})

	it("implements every route", () => {
		const php = installer()
		for (const route of ["health", "status", "session", "outbound", "inbound", "install"]) {
			assert.ok(php.includes(route), `the installer is missing the ${route} route`)
		}
	})

	it("keeps the two directions in separate queues with their own cursors", () => {
		const php = installer()
		for (const part of ["'outbound' => []", "'outboundCursor' => 0", "'inbound' => []", "'inboundCursor' => 0"]) {
			assert.ok(php.includes(part), `the installer is missing ${part}`)
		}
		// A session record keeps its two directions apart: it is created without a single shared queue.
		const created = php.slice(php.indexOf("$session = ["), php.indexOf("];", php.indexOf("$session = [")))
		assert.ok(created.includes("'outbound' => []"))
		assert.equal(created.includes("'events'"), false)
	})

	it("reports installed state, refuses relay traffic before install, and closes install after", () => {
		const php = installer()
		assert.ok(php.includes("'installed' => isInstalled()"))
		assert.ok(php.includes("'error' => 'not_installed'"))
		assert.ok(php.includes("'error' => 'already_installed'"))
	})

	it("requires the install token with a constant-time comparison", () => {
		assert.ok(installer().includes("hash_equals(INSTALL_TOKEN, $presented)"))
	})

	it("authenticates relay traffic with a constant-time bearer comparison", () => {
		const php = installer()
		assert.ok(php.includes("hash_equals("))
		assert.ok(php.includes("'bearer '"))
	})

	it("never probes its own server", () => {
		const php = installer()
		assert.equal(php.includes("stream_context_create"), false)
		assert.equal(php.includes("file_get_contents($probe"), false)
	})

	it("writes no PHP file — only a directory and two files inside it", () => {
		// The installer writes files only into its data folder, and never a PHP file anywhere.
		const php = installer()
		const writes = php.match(/file_put_contents\([^;]*;/g) ?? []
		assert.ok(writes.length > 0)
		for (const write of writes) {
			assert.equal(/\.php['"]/.test(write), false, `a write names a PHP file: ${write}`)
		}
	})

	it("caps the queue at the bound the hub keeps and counts what it discards", () => {
		const php = installer()
		assert.ok(php.includes("const QUEUE_CAP = 200_000;"))
		assert.ok(php.includes("'dropped'"))
	})

	it("expires queued events and whole sessions", () => {
		const php = installer()
		assert.ok(php.includes("const EVENT_TTL_SECONDS = 3600;"))
		assert.ok(php.includes("const SESSION_TTL_SECONDS = 86400;"))
	})

	it("explains itself on the install page, because no separate notes file ships", () => {
		const php = installer()
		for (const line of ["What this relay does not do", "no database", "document root", "file-integrity scanners"]) {
			assert.ok(php.includes(line), `the install page is missing ${line}`)
		}
	})
})

describe("writeRelayInstaller", () => {
	it("writes the file the user chose and creates no folder of its own", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "relay-save-"))
		const target = path.join(dir, "index.php")
		const token = createInstallToken()

		writeRelayInstaller(target, VERSION, token)

		assert.equal(readFileSync(target, "utf8"), buildRelayInstaller(VERSION, token))
		// Nothing beside the chosen file may appear: no folder the extension picked, no notes file,
		// no credential shipped from the laptop.
		assert.equal(existsSync(path.join(dir, "cline-cubed-relay")), false)
		assert.equal(existsSync(path.join(dir, "INSTALL.txt")), false)
		assert.equal(existsSync(path.join(dir, "relay.key")), false)
	})
})
