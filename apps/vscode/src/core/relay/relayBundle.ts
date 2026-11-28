import { randomBytes } from "node:crypto"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { DISPLAY_SOURCE_TOKEN, INSTALLED_BASE_TOKEN, PAGE_ICON_TOKEN, PAGE_VERSION_TOKEN, RELAY_CHAT_PAGE } from "./relayChatPage"

// The extension's icon, as the Marketplace shows it, so every page the relay draws names what it belongs to.
const BRAND_ICON_URL = "https://raw.githubusercontent.com/DougJoseph/cline-cubed/main/assets/icons/icon.png"

/**
 * The relay's protocol: its routes and what they answer. It changes only when a change to them would
 * leave an older or newer side unable to talk to the other, and only then does an installed relay need
 * a new `index.php`. A relay from before this number existed reports none, and speaks protocol 1.
 */
export const RELAY_PROTOCOL = 1

/**
 * The chat display code: the page a paired device uses (the chat, its menu, the About), with this
 * version and the icon written in. Built into `index.php` at export, and sent to an installed relay by
 * the extension when the relay's copy is older. The relay writes in its own version and where the code
 * came from as it serves it.
 */
export function chatDisplayCodeFor(version: string): string {
	return RELAY_CHAT_PAGE.split(PAGE_VERSION_TOKEN).join(version).split(PAGE_ICON_TOKEN).join(BRAND_ICON_URL)
}

/** Minted per export, required by `POST /install`, and burned by the first successful install. */
export function createInstallToken(): string {
	return randomBytes(16).toString("hex")
}

const INSTALL = (version: string) => `# Cline Cubed remote-control relay

Bundle version: ${version}

## Install

1. In Cline Cubed, press **Get installer**. It writes the files and shows an install token — keep it handy.
2. Upload **one file**, \`index.php\`, to a folder on your server — for example \`relay/\` under your web root.
3. Open \`https://your-domain.com/relay/\` in a browser. The file is not installed yet, so it shows an install page.
4. Copy the install token and paste it into the form, then press **Install**.
5. Copy the credential the page returns into Cline Cubed's Relay key field, and the folder's URL into the Relay URL field.
6. In the Remote Control popover, check **Share this chat with my devices** on each chat you want to reach,
   press **Pair a device**, and scan the QR code with your phone — or open the relay's address on any
   browser and enter the code. Each code works once, for ten minutes.

The file creates its own data directory and generates the credential on your server. Nothing is written
until every check passes, and each failure says what failed. The install token works once: after a
successful install the install route is closed, and re-installing means exporting the files again.

If any step fails, reload the page and try again — an uninstalled relay stays an installer until it
succeeds.

## What this relay does not do

It never connects to your machine. Your machine dials out to it over HTTPS and polls it. It runs as an
ordinary PHP request, so it needs no persistent process, no websocket server, no database, and no special
hosting. It stores nothing durable about a conversation: queued events expire, and expired entries are
dropped on the next request that touches the file.

## If Cline Cubed reports the data folder is exposed

The relay keeps its data outside your web root when PHP can write there. When it cannot, it keeps the
data in \`data/\` beside \`index.php\` and adds a rule to your document root's .htaccess that refuses every
request for that folder. Cline Cubed refuses to connect to a relay whose data it can read over the web.
If it says so, add this line to the top of your **document root's** .htaccess — some hosts, including
LiteSpeed, read only that one file and ignore a .htaccess in a subdirectory:

    RewriteRule ^relay/data/ - [F,L]

with \`relay\` replaced by your relay's folder. Then reconnect from the Remote Control popover.

## If the relay stops answering

Some hosts run file-integrity scanners on a schedule that remove PHP files. Check that \`index.php\` is
still where you put it before anything else.

## Installing again

When PHP can write there, the relay keeps its data outside the web root, in a hidden folder named
\`.cline-cubed-relay\` in your hosting account's top folder (the one that holds your web root). Otherwise it
keeps it in \`data/\` beside \`index.php\`. Cline Cubed's Remote Control popover shows which, while it is connected.

Uploading a newer \`index.php\` over this one keeps the install and its credential. To install again from
scratch, delete that data folder, then open the relay's address for the install page.
`

const INDEX_PHP = (version: string, installToken: string) => `<?php
/**
 * Cline Cubed remote-control relay.
 *
 * One file, two lives. Until it has been installed it is the installer: it creates its own data
 * directory, mints the credential on this server, and records the install. After that it is only the
 * relay, and the install route answers 410 Gone. It never writes a PHP file, and it never connects to
 * the machine that dials out to it.
 *
 * The chat page a paired device uses can be newer than this file: Cline Cubed sends its current chat
 * display code over the relay key, and the relay keeps it as data in its data folder and serves it in
 * place of the copy built in below. It is never written as PHP and never run on this server.
 */

const RELAY_VERSION = '${version}';
// The routes and what they answer; see RELAY_PROTOCOL in the extension.
const RELAY_PROTOCOL = ${RELAY_PROTOCOL};
const DISPLAY_MAX_BYTES = 4_000_000;
// Minted by the extension at export time and consumed by the first successful install. Without it a
// stranger who finds this URL could install the relay; after the burn, nobody can re-install it.
const INSTALL_TOKEN = '${installToken}';
const QUEUE_CAP = 200_000; // Matches the hub's own bound (sdk/packages/core/src/hub/server/hub-event-log.ts:22, DEFAULT_MAX_ROWS), oldest pruned first.
const EVENT_TTL_SECONDS = 3600;
const SESSION_TTL_SECONDS = 86400;
const MIN_PHP = '8.1.0';

function documentRoot() {
	return isset($_SERVER['DOCUMENT_ROOT']) ? rtrim((string) $_SERVER['DOCUMENT_ROOT'], '/') : '';
}

/**
 * The home folder of the account PHP runs as, or null. A home folder inside the document root is
 * refused, because data kept there would be reachable over the web.
 */
function homeDir() {
	$home = '';
	if (function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
		$info = @posix_getpwuid(posix_geteuid());
		if (is_array($info) && !empty($info['dir'])) {
			$home = (string) $info['dir'];
		}
	}
	if ($home === '') {
		$fromEnv = getenv('HOME');
		$home = $fromEnv ? (string) $fromEnv : '';
	}
	$home = rtrim($home, '/');
	if ($home === '') {
		return null;
	}
	$root = documentRoot();
	if ($root !== '' && ($home === $root || strpos($home . '/', $root . '/') === 0)) {
		return null;
	}
	return $home;
}

/**
 * Where the data goes when it can: the account's home folder, which holds the web roots and is
 * served by none of them. Not the folder above the document root: on hosts that nest one site's
 * document root inside another's, that folder is itself a web root.
 */
function outsideDataDir() {
	$home = homeDir();
	return $home === null ? null : $home . '/.cline-cubed-relay/' . substr(hash('sha256', __DIR__), 0, 16);
}

function insideDataDir() {
	return __DIR__ . '/data';
}

/** Whether PHP can create or write this folder, checked without creating anything. */
function canUseDir($dir) {
	if (@is_dir($dir)) {
		return @is_writable($dir);
	}
	$parent = dirname($dir);
	if (@is_dir($parent)) {
		return @is_writable($parent);
	}
	return @is_writable(dirname($parent));
}

/** Moves an install's files out of the web root. Nothing is deleted until every file is copied. */
function moveData($from, $to) {
	if (!@is_dir($to) && !@mkdir($to, 0700, true)) {
		return false;
	}
	$files = glob($from . '/*') ?: [];
	$copied = [];
	foreach ($files as $file) {
		$target = $to . '/' . basename($file);
		if (!@copy($file, $target)) {
			foreach ($copied as $done) {
				@unlink($done);
			}
			return false;
		}
		@chmod($target, 0600);
		$copied[] = $target;
	}
	foreach ($files as $file) {
		@unlink($file);
	}
	@rmdir($from);
	return true;
}

/**
 * The data folder. An install found inside the web root is moved out on the first request that can
 * move it; a relay not yet installed uses the home folder when PHP can write there, and the folder
 * beside this file otherwise.
 */
function dataDir() {
	static $resolved = null;
	if ($resolved !== null) {
		return $resolved;
	}
	$configured = getenv('CLINE_RELAY_DATA_DIR');
	if ($configured && trim($configured) !== '') {
		return $resolved = rtrim($configured, '/');
	}
	$outside = outsideDataDir();
	$inside = insideDataDir();
	if ($outside !== null && is_file($outside . '/config.json')) {
		return $resolved = $outside;
	}
	if (is_file($inside . '/config.json')) {
		if ($outside !== null && canUseDir($outside) && moveData($inside, $outside)) {
			return $resolved = $outside;
		}
		return $resolved = $inside;
	}
	return $resolved = ($outside !== null && canUseDir($outside)) ? $outside : $inside;
}

/**
 * When the data has to stay beside this file, the document root's .htaccess refuses requests for it.
 * Some hosts, LiteSpeed among them, read only that one file, so a rule in this folder would do nothing.
 */
function addDenyRule() {
	$root = documentRoot();
	if ($root === '' || strpos(__DIR__ . '/', $root . '/') !== 0) {
		return false;
	}
	$folder = trim(substr(__DIR__, strlen($root)), '/');
	$pattern = '^' . ($folder === '' ? '' : preg_quote($folder, '#') . '/') . 'data/';
	$file = $root . '/.htaccess';
	$existing = is_file($file) ? (string) file_get_contents($file) : '';
	if (strpos($existing, '# BEGIN Cline Cubed relay data') !== false) {
		return true;
	}
	$block = '# BEGIN Cline Cubed relay data' . PHP_EOL . 'RewriteEngine On' . PHP_EOL
		. 'RewriteRule ' . $pattern . ' - [F,L]' . PHP_EOL . '# END Cline Cubed relay data' . PHP_EOL;
	return @file_put_contents($file, $block . $existing) !== false;
}

/** The sentence the installed page uses to say where the data went. */
function placementNote() {
	$dir = htmlspecialchars(dataDir());
	if (dataDir() !== insideDataDir()) {
		return '<p>Your relay keeps its data outside the web root, at <code>' . $dir . '</code>.</p>';
	}
	if (addDenyRule()) {
		return '<p>Your relay keeps its data inside the web root, at <code>' . $dir . '</code>, because PHP cannot write outside it here. The document root\\'s .htaccess now refuses every request for that folder.</p>';
	}
	return '<p class="fail">Your relay keeps its data inside the web root, at <code>' . $dir . '</code>, and PHP could not add the rule that refuses requests for it. Add this line to the top of your document root\\'s .htaccess: <code>RewriteRule ^' . htmlspecialchars(trim(substr(__DIR__, strlen(documentRoot())), '/')) . '/data/ - [F,L]</code></p>';
}

function relayKey() {
	// The credential lives in the data directory, which the install placed and verified. Nothing reads a
	// key sitting next to the controller, because the bundle no longer ships one.
	$file = dataDir() . '/relay.key';
	return is_file($file) ? trim(file_get_contents($file)) : null;
}

function send($status, $payload) {
	http_response_code($status);
	header('Content-Type: application/json');
	echo json_encode($payload);
	exit;
}

function requireRelayKey() {
	$expected = relayKey();
	if ($expected === null || $expected === '') {
		send(503, ['error' => 'not_installed', 'hint' => 'Open this URL in a browser and complete the install first.']);
	}
	$header = '';
	foreach ([ 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'Authorization' ] as $name) {
		if (isset($_SERVER[$name]) && trim((string) $_SERVER[$name]) !== '') {
			$header = trim((string) $_SERVER[$name]);
			break;
		}
	}
	if (stripos($header, 'bearer ') !== 0) {
		send(401, ['error' => 'missing_bearer_token']);
	}
	if (!hash_equals($expected, substr($header, 7))) {
		send(401, ['error' => 'invalid_relay_key']);
	}
}

function configPath() {
	return dataDir() . '/config.json';
}

function isInstalled() {
	return is_file(configPath());
}

// The extension's icon, as the Marketplace shows it, so every page the relay draws names what it belongs to.
const BRAND_ICON = '${BRAND_ICON_URL}';

function html($title, $body, $status = 200, $showTitle = true) {
	http_response_code($status);
	header('Content-Type: text/html; charset=utf-8');
	// Every page has a light and a dark look, dark unless this browser chose light. The choice is set
	// on <html> before the page paints, so a light choice never flashes dark first.
	echo '<!doctype html><html data-theme="dark"><head><meta charset="utf-8">'
		. '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' . htmlspecialchars($title) . '</title>'
		. '<script>try{if(localStorage.getItem("cline-cubed-relay-theme")==="light"){document.documentElement.setAttribute("data-theme","light");}}catch(e){}</script>'
		. '<style>'
		. ':root{--bg:#1e1f22;--fg:#e6e6e6;--muted:#a8a8a8;--code-bg:#2b2d31;--border:#45474d;--ok:#5fd17a;--fail:#ff7b72;'
		. '--accent:#4b8ef5;--accent-fg:#fff;--cred-bg:#1c2a44;--input-bg:#2b2d31}'
		. '[data-theme="light"]{--bg:#fff;--fg:#1f1f1f;--muted:#5f5f5f;--code-bg:#f4f4f4;--border:#c8c8c8;--ok:#0a7a2a;--fail:#b00020;'
		. '--accent:#2f6fdf;--accent-fg:#fff;--cred-bg:#eaf2ff;--input-bg:#fff}'
		. 'html{background:var(--bg);color:var(--fg)}'
		. 'body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}'
		. 'a{color:var(--accent)}'
		. 'code{font-family:ui-monospace,monospace;background:var(--code-bg);padding:.2rem .4rem;border-radius:4px;word-break:break-all}'
		. '.fail{color:var(--fail)}.ok{color:var(--ok)}.muted{color:var(--muted)}'
		. 'input,button{font:inherit;padding:.45rem .7rem;margin:.25rem 0;color:var(--fg);background:var(--input-bg);border:1px solid var(--border);border-radius:6px}'
		. 'button{cursor:pointer}'
		. '.brand{display:flex;align-items:center;gap:.75rem;font-size:1.25rem;font-weight:600;margin-bottom:1.5rem}'
		. '.brand img{width:48px;height:48px;border-radius:10px}'
		. '.brand .theme{margin-left:auto;font-size:.85rem;font-weight:500}'
		. '.cred{display:flex;align-items:center;gap:.75rem;background:var(--cred-bg);border:2px solid var(--accent);border-radius:8px;padding:.75rem 1rem;margin:1rem 0}'
		. '.cred code{flex:1;min-width:0;background:none;padding:0;font-size:.9rem;white-space:nowrap;overflow-x:auto;word-break:normal;user-select:all}'
		. '.cred button{flex-shrink:0;margin:0;background:var(--accent);color:var(--accent-fg);border:0;font-weight:600}'
		. '</style></head><body>'
		. '<div class="brand"><img src="' . BRAND_ICON . '" alt="">Cline Cubed'
		. '<button type="button" class="theme" id="theme-toggle"></button></div>'
		. ($showTitle ? '<h1>' . htmlspecialchars($title) . '</h1>' : '') . $body
		. '<script>(function(){var b=document.getElementById("theme-toggle"),r=document.documentElement;'
		. 'function label(){b.textContent=r.getAttribute("data-theme")==="light"?"Dark mode":"Light mode";}'
		. 'b.onclick=function(){var next=r.getAttribute("data-theme")==="light"?"dark":"light";r.setAttribute("data-theme",next);'
		. 'try{localStorage.setItem("cline-cubed-relay-theme",next);}catch(e){}label();};label();})();</script>'
		. '</body></html>';
	exit;
}

/**
 * What a person sees on opening an installed relay's own address: the pairing form on a browser that
 * is not paired, and the shared chats on one that is. The page decides which by asking the relay.
 */
function chatPage() {
	$stored = storedDisplay();
	if ($stored !== null) {
		$body = $stored['html'];
		$source = 'sent';
	} else {
		$body = <<<'CCPAGE'
${chatDisplayCodeFor(version)}
CCPAGE;
		$source = 'built-in';
	}
	$body = str_replace(['${INSTALLED_BASE_TOKEN}', '${DISPLAY_SOURCE_TOKEN}'], [RELAY_VERSION, $source], $body);
	html('Cline Cubed', $body, 200, false);
}

function displayFile() {
	return dataDir() . '/display.json';
}

/** The chat display code Cline Cubed sent, as ['version' => …, 'html' => …], or null when none was sent. */
function storedDisplay() {
	$file = displayFile();
	if (!is_file($file)) {
		return null;
	}
	$stored = json_decode((string) file_get_contents($file), true);
	if (!is_array($stored) || !isset($stored['version'], $stored['html']) || !is_string($stored['html'])) {
		return null;
	}
	return $stored;
}

/**
 * The install step. It changes nothing until every precondition passes, and it reports what failed
 * rather than half-installing.
 */
function performInstall() {
	if (version_compare(PHP_VERSION, MIN_PHP, '<')) {
		html('PHP is too old', '<p class="fail">This server is running PHP ' . PHP_VERSION . '. The relay needs ' . MIN_PHP . ' or newer.</p>', 500);
	}
	$presented = isset($_POST['token']) ? trim((string) $_POST['token']) : '';
	if ($presented === '' || !hash_equals(INSTALL_TOKEN, $presented)) {
		html('Install token required', '<p class="fail">The token from the exported bundle is missing or wrong. Re-export the relay files from Cline Cubed and try again.</p>', 403);
	}
	if (!is_dir(dataDir()) && !mkdir(dataDir(), 0700, true)) {
		html('Could not create the data directory', '<p class="fail">PHP could not create ' . htmlspecialchars(dataDir()) . '.</p>', 500);
	}

	$key = bin2hex(random_bytes(32));
	if (file_put_contents(dataDir() . '/relay.key', $key . "\n") === false) {
		html('Could not write the credential', '<p class="fail">PHP could not write the key file inside ' . htmlspecialchars(dataDir()) . '.</p>', 500);
	}
	chmod(dataDir() . '/relay.key', 0600);

	// The token is burned here: after this file exists, /install is closed for good and the only way
	// back is a fresh export from the extension.
	if (file_put_contents(configPath(), json_encode(['version' => RELAY_VERSION, 'installedAt' => time()])) === false) {
		unlink(dataDir() . '/relay.key');
		html('Could not record the install', '<p class="fail">PHP could not write ' . htmlspecialchars(configPath()) . ', so the install was rolled back.</p>', 500);
	}
	chmod(configPath(), 0600);

	html('Relay installed', '<p class="ok">Installed. Version ' . RELAY_VERSION . '.</p>' . placementNote()
		. '<p>Copy this credential into Cline Cubed\\'s Relay key field, then close this page:</p>'
		. '<div class="cred"><code id="cred">' . $key . '</code><button type="button" id="copy">Copy</button></div>'
		. '<script>document.getElementById("copy").onclick=function(){var b=this,c=document.getElementById("cred");'
		. 'navigator.clipboard.writeText(c.textContent).then(function(){b.textContent="Copied";},function(){'
		. 'var r=document.createRange();r.selectNodeContents(c);var s=window.getSelection();s.removeAllRanges();s.addRange(r);'
		. 'b.textContent="Selected: press Cmd+C or Ctrl+C";});};</script>'
		. '<p>The install route is now closed. If this file is ever re-uploaded it needs a new token from a new export.</p>');
}

function installPage() {
	html('Install the Cline Cubed relay', '<p>Relay version: <code>' . RELAY_VERSION . '</code></p>'
		. '<p>This creates the data directory, generates the relay credential on this server, and closes the install route. Nothing is written until every check passes, and each failure says what failed.</p>'
		. '<form method="post"><input type="password" name="token" placeholder="Install token" required><button type="submit">Install</button></form>'
		. '<h2>What this relay does not do</h2><p>It never connects to your machine; your machine dials out to it over HTTPS and polls it. It runs as an ordinary PHP request: no persistent process, no websocket server, no database, no special hosting. It stores nothing durable about a conversation — queued events expire, and expired entries are dropped on the next request that touches the file.</p>'
		. '<h2>If the extension reports the data directory is exposed</h2><p>Move this folder so <code>data/</code> sits outside the web root, or add a deny rule to your <strong>document root\\'s</strong> .htaccess — some hosts, including LiteSpeed, read only that one file and ignore a .htaccess in a subdirectory: <code>RewriteRule ^relay/data/ - [F,L]</code></p>'
		. '<h2>If the relay stops answering</h2><p>Some hosts run file-integrity scanners on a schedule that remove PHP files. Check that this file is still where you put it before anything else.</p>');
}

function requestPath() {
	// The extension sends every route as index.php?route=…, which reaches this file on any host without
	// a rewrite rule. A path after the folder is still read, for a server that does rewrite to this file.
	if (isset($_GET['route']) && is_string($_GET['route'])) {
		return '/' . trim($_GET['route'], '/');
	}
	$uri = isset($_SERVER['REQUEST_URI']) ? (string) parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) : '/';
	// When the server hands the request to index.php directly, SCRIPT_NAME names the folder the relay
	// lives in, and that prefix is part of the URL rather than part of the route.
	$folder = rtrim(dirname(isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '/'), '/');
	if ($folder !== '' && $folder !== '/' && strpos($uri, $folder) === 0) {
		$uri = substr($uri, strlen($folder));
	}
	$path = '/' . trim($uri, '/');
	// The file named directly is the folder's own address.
	return $path === '/index.php' ? '/' : $path;
}

function readBody() {
	$decoded = json_decode(file_get_contents('php://input'), true);
	return is_array($decoded) ? $decoded : [];
}

function sessionFile($sessionId) {
	return dataDir() . '/session-' . preg_replace('/[^A-Za-z0-9_-]/', '', $sessionId) . '.json';
}

function loadSession($sessionId) {
	$file = sessionFile($sessionId);
	if (!is_file($file)) {
		return null;
	}
	$session = json_decode(file_get_contents($file), true);
	if (!is_array($session)) {
		return null;
	}
	if (isset($session['expiresAt']) && $session['expiresAt'] < time()) {
		unlink($file);
		return null;
	}
	return $session;
}

/** Answers whether the save succeeded; a route that cannot save answers with saveFailed(). */
function saveSession($sessionId, $session) {
	return writeWhole(sessionFile($sessionId), json_encode($session));
}

/** The answer for a save the host refused, so no side is told something was stored when it was not. */
function saveFailed() {
	send(500, ['error' => 'relay_save_failed', 'hint' => 'The relay could not save its data. Check that the web server can write its data folder and that the disk has free space.']);
}

// ---- Data written while requests run in parallel ---------------------------------------------------
// A host answers requests at the same time, so every request that changes a data file holds that
// file's lock from its read through its save, and every save replaces the file whole. Two requests
// landing together then cannot save over each other, and a reader never finds a half-written file.

/**
 * Takes the lock on a data file (its own ".lock" file beside it): exclusive to change the file,
 * shared to read it. A request that answers while holding a lock drops it when the request ends.
 */
function lockData($file, $exclusive) {
	$handle = @fopen($file . '.lock', 'c');
	if ($handle === false || !flock($handle, $exclusive ? LOCK_EX : LOCK_SH)) {
		send(503, ['error' => 'relay_busy', 'hint' => 'The relay could not lock its data. Try again.']);
	}
	return $handle;
}

function unlockData($handle) {
	flock($handle, LOCK_UN);
	fclose($handle);
}

/** Writes a file whole: a temporary file renamed over it, so a reader sees the old or the new file. */
function writeWhole($file, $contents) {
	$temp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
	if (@file_put_contents($temp, $contents) === false) {
		return false;
	}
	@chmod($temp, 0600);
	if (!@rename($temp, $file)) {
		@unlink($temp);
		return false;
	}
	return true;
}

function pruneEvents($events) {
	$now = time();
	$kept = [];
	$dropped = 0;
	foreach ($events as $event) {
		if (isset($event['expiresAt']) && $event['expiresAt'] < $now) {
			$dropped++;
			continue;
		}
		$kept[] = $event;
	}
	return [$kept, $dropped];
}

$method = isset($_SERVER['REQUEST_METHOD']) ? strtoupper($_SERVER['REQUEST_METHOD']) : 'GET';
$path = requestPath();

// Opening the folder before it is installed shows the installer rather than a JSON error.
if ($path === '/' && !isInstalled()) {
	// The install page's form posts back to this same address.
	if ($method === 'POST') {
		performInstall();
	}
	installPage();
}

// ---- Devices and pairing -------------------------------------------------------------------------

const DEVICE_COOKIE = 'cline_cubed_device';
const DEVICE_TTL_SECONDS = 2592000; // 30 days from last use, renewed on each visit
const DEVICE_SEEN_STEP_SECONDS = 60; // a device's last-seen time is kept to the minute
const PAIR_CODE_TTL_SECONDS = 600;
const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SESSION_ID_PATTERN = '#^[A-Za-z0-9_-]{8,64}$#';

function loadJsonFile($file) {
	if (!is_file($file)) {
		return [];
	}
	$decoded = json_decode((string) file_get_contents($file), true);
	return is_array($decoded) ? $decoded : [];
}

function saveJsonFile($file, $data) {
	return writeWhole($file, json_encode($data));
}

function bearerToken() {
	foreach (['HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'Authorization'] as $name) {
		if (isset($_SERVER[$name]) && stripos(trim((string) $_SERVER[$name]), 'bearer ') === 0) {
			return substr(trim((string) $_SERVER[$name]), 7);
		}
	}
	return '';
}

function hasRelayKey() {
	$expected = relayKey();
	$presented = bearerToken();
	return $expected !== null && $expected !== '' && $presented !== '' && hash_equals($expected, $presented);
}

function cookiePath() {
	$folder = rtrim(dirname(isset($_SERVER['SCRIPT_NAME']) ? (string) $_SERVER['SCRIPT_NAME'] : '/'), '/');
	return $folder === '' ? '/' : $folder . '/';
}

function setDeviceCookie($value) {
	setcookie(DEVICE_COOKIE, $value, [
		'expires' => time() + DEVICE_TTL_SECONDS,
		'path' => cookiePath(),
		'secure' => true,
		'httponly' => true,
		'samesite' => 'Strict',
	]);
}

/** The paired device making this request, or null. A device unused for 30 days is forgotten. */
function currentDevice() {
	$presented = isset($_COOKIE[DEVICE_COOKIE]) ? (string) $_COOKIE[DEVICE_COOKIE] : '';
	if ($presented === '') {
		return null;
	}
	$hash = hash('sha256', $presented);
	$lock = lockData(dataDir() . '/devices.json', true);
	$devices = loadJsonFile(dataDir() . '/devices.json');
	$now = time();
	$found = null;
	$kept = [];
	$touched = false;
	foreach ($devices as $device) {
		if (!isset($device['lastUsedAt']) || $device['lastUsedAt'] + DEVICE_TTL_SECONDS < $now) {
			continue;
		}
		if ($found === null && hash_equals((string) $device['hash'], $hash)) {
			// Renewed at most hourly, so polling does not rewrite the file every second and a half.
			if ($device['lastUsedAt'] < $now - 3600) {
				$device['lastUsedAt'] = $now;
				setDeviceCookie($presented);
				$touched = true;
			}
			// When the device was last heard from, kept to the minute, so Cline Cubed can show whether it is
			// connected now without the file being rewritten on every poll.
			if (!isset($device['lastSeenAt']) || $device['lastSeenAt'] < $now - DEVICE_SEEN_STEP_SECONDS) {
				$device['lastSeenAt'] = $now;
				$touched = true;
			}
			$found = $device;
		}
		$kept[] = $device;
	}
	if (count($kept) !== count($devices) || $touched) {
		$kept = array_map(function ($device) use ($found) {
			return $found !== null && $device['id'] === $found['id'] ? $found : $device;
		}, $kept);
		saveJsonFile(dataDir() . '/devices.json', $kept);
	}
	unlockData($lock);
	return $found;
}

function requireDevice() {
	$device = currentDevice();
	if ($device === null) {
		send(401, ['error' => 'not_paired']);
	}
	return $device;
}

function requireKeyOrDevice() {
	if (hasRelayKey()) {
		return 'key';
	}
	requireDevice();
	return 'device';
}

function normalizePairCode($code) {
	return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string) $code));
}

function sessionSummary($session) {
	return [
		'id' => $session['id'],
		'name' => isset($session['name']) ? $session['name'] : '',
		'working' => !empty($session['working']),
	];
}

function allSessions() {
	$sessions = [];
	foreach (glob(dataDir() . '/session-*.json') ?: [] as $file) {
		$session = json_decode((string) file_get_contents($file), true);
		if (is_array($session) && isset($session['id'])) {
			if (isset($session['expiresAt']) && $session['expiresAt'] < time()) {
				@unlink($file);
				continue;
			}
			$sessions[] = $session;
		}
	}
	return $sessions;
}

/** Takes everything newer than the cursor from a queue; with $consume, the queue is emptied after. */
function readQueue(&$session, $queue, $after, $consume) {
	list($kept, $dropped) = pruneEvents($session[$queue]);
	$out = [];
	$highest = $after;
	foreach ($kept as $event) {
		if ((int) $event['seq'] > $after) {
			$out[] = $event;
			$highest = max($highest, (int) $event['seq']);
		}
	}
	$session[$queue] = $consume ? [] : $kept;
	return [$out, $highest, $dropped];
}

function appendToQueue(&$session, $queue, $incoming) {
	foreach ($incoming as $event) {
		if (!is_array($event)) {
			continue;
		}
		$session[$queue . 'Cursor'] = $session[$queue . 'Cursor'] + 1;
		$event['seq'] = $session[$queue . 'Cursor'];
		$event['expiresAt'] = time() + EVENT_TTL_SECONDS;
		$session[$queue][] = $event;
		if ($queue === 'outbound' && isset($event['kind'])) {
			if (($event['kind'] === 'working' || $event['kind'] === 'snapshot') && isset($event['payload']['working'])) {
				$session['working'] = (bool) $event['payload']['working'];
			}
			if (($event['kind'] === 'title' || $event['kind'] === 'snapshot') && isset($event['payload']['title'])) {
				$session['name'] = (string) $event['payload']['title'];
			}
		}
	}
	list($kept, $dropped) = pruneEvents($session[$queue]);
	$overflow = max(0, count($kept) - QUEUE_CAP);
	if ($overflow > 0) {
		$kept = array_slice($kept, -QUEUE_CAP);
		$dropped += $overflow;
	}
	$session[$queue] = $kept;
	$session['expiresAt'] = time() + SESSION_TTL_SECONDS;
	return $dropped;
}

// ---- Routes ----------------------------------------------------------------------------------------

// A person opening the installed relay's own address gets the chat page (or the pairing form); the
// extension reads ?route=health.
if ($path === '/' && $method === 'GET') {
	chatPage();
}

if (substr($path, -7) === '/health') {
	// Reachable-but-uninstalled and unreachable have to be tellable apart, or the extension can only
	// report one failure for two different situations.
	$stored = storedDisplay();
	send(200, [
		'ok' => true,
		'version' => RELAY_VERSION,
		'installed' => isInstalled(),
		'protocol' => RELAY_PROTOCOL,
		'displayVersion' => $stored !== null ? (string) $stored['version'] : RELAY_VERSION,
		'displaySource' => $stored !== null ? 'sent' : 'built-in',
	]);
}

if (substr($path, -8) === '/install') {
	if (isInstalled()) {
		send(410, ['error' => 'already_installed', 'hint' => 'Get the installer again from Cline Cubed.']);
	}
	if ($method === 'POST') {
		performInstall();
	}
	installPage();
}

if (!isInstalled()) {
	send(503, ['error' => 'not_installed', 'hint' => 'Open this URL in a browser and complete the install first.']);
}

if (substr($path, -7) === '/status') {
	requireRelayKey();
	// The data's location goes only to the extension, which holds the key, never to the public page.
	send(200, ['version' => RELAY_VERSION, 'sessions' => array_map('sessionSummary', allSessions()), 'dataDir' => dataDir()]);
}

// Cline Cubed sends its current chat display code, over the relay key only. It is kept as data and
// served in place of the copy built into this file; it is never written as PHP.
if ($method === 'POST' && $path === '/display') {
	requireRelayKey();
	$body = readBody();
	$version = isset($body['version']) ? (string) $body['version'] : '';
	$code = isset($body['html']) && is_string($body['html']) ? $body['html'] : '';
	if (!preg_match('#^[0-9A-Za-z.+-]{1,40}$#', $version)) {
		send(400, ['error' => 'invalid_display_version']);
	}
	if ($code === '' || strlen($code) > DISPLAY_MAX_BYTES) {
		send(400, ['error' => 'invalid_display_code', 'hint' => 'The chat display code is missing or larger than ' . DISPLAY_MAX_BYTES . ' bytes.']);
	}
	$lock = lockData(displayFile(), true);
	if (!writeWhole(displayFile(), json_encode(['version' => $version, 'html' => $code, 'receivedAt' => time()]))) {
		saveFailed();
	}
	unlockData($lock);
	send(200, ['ok' => true, 'displayVersion' => $version]);
}

// The extension asks for a single-use pairing code to show in its popover.
if ($method === 'POST' && $path === '/pair-code') {
	requireRelayKey();
	$lock = lockData(dataDir() . '/pair-codes.json', true);
	$codes = array_values(array_filter(loadJsonFile(dataDir() . '/pair-codes.json'), function ($entry) {
		return isset($entry['expiresAt']) && $entry['expiresAt'] >= time();
	}));
	$raw = '';
	for ($i = 0; $i < 8; $i++) {
		$raw .= PAIR_CODE_ALPHABET[random_int(0, strlen(PAIR_CODE_ALPHABET) - 1)];
	}
	$codes[] = ['hash' => hash('sha256', $raw), 'expiresAt' => time() + PAIR_CODE_TTL_SECONDS];
	if (!saveJsonFile(dataDir() . '/pair-codes.json', $codes)) {
		saveFailed();
	}
	unlockData($lock);
	send(200, ['code' => substr($raw, 0, 4) . '-' . substr($raw, 4), 'expiresInSeconds' => PAIR_CODE_TTL_SECONDS]);
}

// A device trades a pairing code for its own credential, kept in a cookie the page cannot read.
if ($method === 'POST' && $path === '/pair') {
	$body = readBody();
	$hash = hash('sha256', normalizePairCode(isset($body['code']) ? $body['code'] : ''));
	$lock = lockData(dataDir() . '/pair-codes.json', true);
	$codes = loadJsonFile(dataDir() . '/pair-codes.json');
	$matched = false;
	$remaining = [];
	foreach ($codes as $entry) {
		if (!isset($entry['expiresAt']) || $entry['expiresAt'] < time()) {
			continue;
		}
		if (!$matched && hash_equals((string) $entry['hash'], $hash)) {
			$matched = true; // single use: the code is not kept
			continue;
		}
		$remaining[] = $entry;
	}
	if (!saveJsonFile(dataDir() . '/pair-codes.json', $remaining)) {
		saveFailed();
	}
	unlockData($lock);
	if (!$matched) {
		send(403, ['error' => 'pair_code_invalid', 'hint' => 'The code is wrong, already used, or older than ten minutes. Ask Cline Cubed for a new one.']);
	}
	$credential = bin2hex(random_bytes(32));
	$agent = isset($_SERVER['HTTP_USER_AGENT']) ? (string) $_SERVER['HTTP_USER_AGENT'] : '';
	$name = isset($body['name']) && trim((string) $body['name']) !== '' ? trim((string) $body['name']) : $agent;
	$lock = lockData(dataDir() . '/devices.json', true);
	$devices = loadJsonFile(dataDir() . '/devices.json');
	$devices[] = [
		'id' => bin2hex(random_bytes(8)),
		'hash' => hash('sha256', $credential),
		'name' => substr($name, 0, 512), // a browser's full identity, which can pass 120 characters
		'createdAt' => time(),
		'lastUsedAt' => time(),
	];
	if (!saveJsonFile(dataDir() . '/devices.json', $devices)) {
		saveFailed();
	}
	unlockData($lock);
	setDeviceCookie($credential);
	send(200, ['ok' => true]);
}

if ($path === '/devices') {
	requireRelayKey();
	$list = [];
	$lock = lockData(dataDir() . '/devices.json', false);
	$stored = loadJsonFile(dataDir() . '/devices.json');
	unlockData($lock);
	foreach ($stored as $device) {
		if (isset($device['lastUsedAt']) && $device['lastUsedAt'] + DEVICE_TTL_SECONDS >= time()) {
			$list[] = [
				'id' => $device['id'],
				'name' => $device['name'],
				'createdAt' => $device['createdAt'],
				'lastUsedAt' => $device['lastUsedAt'],
				'lastSeenAt' => isset($device['lastSeenAt']) ? $device['lastSeenAt'] : $device['lastUsedAt'],
			];
		}
	}
	send(200, ['devices' => $list]);
}

if ($method === 'POST' && preg_match('#^/devices/([a-f0-9]{16})/remove$#', $path, $match)) {
	requireRelayKey();
	$lock = lockData(dataDir() . '/devices.json', true);
	$devices = array_values(array_filter(loadJsonFile(dataDir() . '/devices.json'), function ($device) use ($match) {
		return $device['id'] !== $match[1];
	}));
	if (!saveJsonFile(dataDir() . '/devices.json', $devices)) {
		saveFailed();
	}
	unlockData($lock);
	send(200, ['ok' => true]);
}

// The page asks whether this browser is paired, without treating "no" as an error.
// Named "pairing", not "whoami": some hosts' firewalls refuse a Unix command name in an address.
if ($path === '/pairing') {
	$device = currentDevice();
	send(200, ['paired' => $device !== null]);
}

if ($path === '/chats') {
	requireDevice();
	send(200, ['chats' => array_map('sessionSummary', allSessions())]);
}

// The extension registers each shared chat under the chat's own id, so a chat's address stays the
// same across restarts. Registering again renames it and keeps its queues.
if ($method === 'POST' && $path === '/session') {
	requireRelayKey();
	$body = readBody();
	$id = isset($body['id']) ? (string) $body['id'] : bin2hex(random_bytes(16));
	if (!preg_match(SESSION_ID_PATTERN, $id)) {
		send(400, ['error' => 'invalid_session_id']);
	}
	$lock = lockData(sessionFile($id), true);
	$session = loadSession($id);
	if ($session === null) {
		$session = [
			'id' => $id,
			'createdAt' => time(),
			'working' => false,
			'outbound' => [],
			'outboundCursor' => 0,
			'inbound' => [],
			'inboundCursor' => 0,
		];
	}
	$session['name'] = isset($body['name']) ? (string) $body['name'] : (isset($session['name']) ? $session['name'] : '');
	$session['expiresAt'] = time() + SESSION_TTL_SECONDS;
	if (!saveSession($id, $session)) {
		saveFailed();
	}
	unlockData($lock);
	send(200, ['sessionId' => $id]);
}

if ($method === 'POST' && preg_match('#^/session/([A-Za-z0-9_-]{8,64})/remove$#', $path, $match)) {
	requireRelayKey();
	$lock = lockData(sessionFile($match[1]), true);
	@unlink(sessionFile($match[1]));
	unlockData($lock);
	send(200, ['ok' => true]);
}

// One request carries every shared chat's inbound queue to the extension.
if ($method === 'POST' && $path === '/poll') {
	requireRelayKey();
	$body = readBody();
	$cursors = isset($body['cursors']) && is_array($body['cursors']) ? $body['cursors'] : [];
	$result = [];
	$missing = [];
	foreach ($cursors as $id => $after) {
		$id = (string) $id;
		if (!preg_match(SESSION_ID_PATTERN, $id)) {
			$missing[] = $id;
			continue;
		}
		$lock = lockData(sessionFile($id), true);
		$session = loadSession($id);
		if ($session === null) {
			unlockData($lock);
			$missing[] = $id;
			continue;
		}
		list($events, $highest, $dropped) = readQueue($session, 'inbound', (int) $after, true);
		$session['expiresAt'] = time() + SESSION_TTL_SECONDS;
		if (!saveSession($id, $session)) {
			// This chat's queue could not be emptied, so it hands out nothing now and the next poll
			// delivers its events once. Only this chat fails: the others were already emptied and
			// saved, and failing the whole poll would lose their events.
			unlockData($lock);
			$result[$id] = ['events' => [], 'cursor' => (int) $after, 'dropped' => 0, 'error' => 'relay_save_failed'];
			continue;
		}
		unlockData($lock);
		$result[$id] = ['events' => $events, 'cursor' => $highest, 'dropped' => $dropped];
	}
	send(200, ['sessions' => (object) $result, 'missing' => $missing]);
}

if (preg_match('#^/session/([A-Za-z0-9_-]{8,64})/(outbound|inbound)$#', $path, $match)) {
	$sessionId = $match[1];
	$queue = $match[2]; // outbound: the machine posts, the page reads. inbound: the reverse.
	$who = requireKeyOrDevice();
	// Only the outbound read leaves the record as it is; every other use of this route changes it.
	$changes = $method === 'POST' || $queue === 'inbound';
	$lock = lockData(sessionFile($sessionId), $changes);
	$session = loadSession($sessionId);
	if ($session === null) {
		send(404, ['error' => 'session_not_found']);
	}
	// Each side writes only its own direction: the machine writes outbound, a paired device inbound.
	$writer = $queue === 'outbound' ? 'key' : 'device';
	if ($method === 'POST') {
		if ($who !== $writer && !($queue === 'inbound' && $who === 'key')) {
			send(403, ['error' => 'wrong_direction']);
		}
		$body = readBody();
		$incoming = isset($body['events']) && is_array($body['events']) ? $body['events'] : [];
		$dropped = appendToQueue($session, $queue, $incoming);
		if (!saveSession($sessionId, $session)) {
			saveFailed();
		}
		unlockData($lock);
		send(200, ['accepted' => count($incoming), 'dropped' => $dropped, 'cursor' => $session[$queue . 'Cursor']]);
	}
	if ($queue === 'inbound' && $who !== 'key') {
		send(403, ['error' => 'wrong_direction']);
	}
	// Outbound is read by every paired device, so reading leaves it in place for the others and does
	// not save: its old events are trimmed when the extension next adds to it. Inbound has one reader,
	// the extension, and is emptied as it is read.
	// A cursor of "latest" answers with the current position and no events, for a page just opened.
	if (isset($_GET['cursor']) && $_GET['cursor'] === 'latest') {
		send(200, ['events' => [], 'cursor' => $session[$queue . 'Cursor'], 'dropped' => 0]);
	}
	$after = isset($_GET['cursor']) ? (int) $_GET['cursor'] : 0;
	list($events, $highest, $dropped) = readQueue($session, $queue, $after, $queue === 'inbound');
	// An inbound read that cannot empty the queue hands out nothing, or the next read delivers it again.
	if ($changes && !saveSession($sessionId, $session)) {
		saveFailed();
	}
	unlockData($lock);
	send(200, ['events' => $events, 'cursor' => $highest, 'dropped' => $dropped]);
}

send(404, ['error' => 'unknown_route']);
`

/** The installer the user saves wherever they choose. One file, no folder, no location picked for them. */
export function buildRelayInstaller(extensionVersion: string, installToken: string): string {
	return INDEX_PHP(extensionVersion, installToken)
}

/** The two files Get installer writes, by name: the installer itself and its instructions. */
export const RELAY_INSTALLER_FILES = ["index.php", "INSTALL.txt"] as const

/**
 * Writes `index.php` and `INSTALL.txt` into the folder the user chose, both readable by the web server.
 * Returns the paths written.
 */
export function writeRelayInstallerFiles(folder: string, extensionVersion: string, installToken: string): string[] {
	const installer = path.join(folder, "index.php")
	const instructions = path.join(folder, "INSTALL.txt")
	writeRelayInstaller(installer, extensionVersion, installToken)
	writeFileSync(instructions, INSTALL(extensionVersion), { mode: 0o644 })
	return [installer, instructions]
}

export function writeRelayInstaller(filePath: string, extensionVersion: string, installToken: string): void {
	// Readable by the web server: PHP often runs as a different user from the file's owner.
	writeFileSync(filePath, buildRelayInstaller(extensionVersion, installToken), { mode: 0o644 })
}
