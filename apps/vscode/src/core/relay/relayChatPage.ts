/**
 * The page a paired device uses at the relay's own address: the pairing form, the shared chats, and
 * one chat at a time. In a chat, replies are the main content; the steps between two replies fold
 * into one row ("Ran 4 commands") that opens a sheet listing each step, and each step opens its full
 * detail. A request waiting on the person is never folded away.
 *
 * It is embedded in the relay's `index.php` inside a PHP nowdoc, so nothing in it is interpreted by
 * PHP. It is written without backticks or dollar-brace sequences, because it also sits inside the
 * template literal that builds `index.php`. All chat text is inserted with `textContent`, never as
 * HTML, so a message cannot run code on the page.
 */
export const RELAY_CHAT_PAGE = String.raw`<style>
html,body{overflow-x:clip}
:root{--radius:16px;--fs-body:1rem;--fs-small:.85rem}
#app,#sheet{overflow-wrap:anywhere}
body.in-chat{max-width:52rem;margin-top:0}
#chat-view{padding:4.4rem 0 9.5rem}
body.in-chat .brand{display:none}
#app{margin-top:.5rem}
.hidden{display:none!important}
.card{border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;margin:.5rem 0}
.chat-link{display:flex;justify-content:space-between;align-items:center;text-decoration:none;color:var(--fg)}
.chat-link:hover{border-color:var(--accent)}
.chat-link .sub{display:block;font-size:.8rem;color:var(--muted)}
.pill{font-size:.8rem;color:var(--muted)}
.icon-button{width:2.3rem;height:2.3rem;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:1.2rem;line-height:1;flex-shrink:0}
.bar{position:fixed;left:0;right:0;z-index:10;background:color-mix(in srgb,var(--bg) 72%,transparent);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.bar-inner{max-width:52rem;margin:0 auto;padding:.5rem 1rem;box-sizing:border-box;position:relative}
.chat-head{top:0}
.chat-head .row{display:flex;align-items:center;gap:.55rem}
.chat-head a.icon-button{text-decoration:none;color:var(--fg);border:1px solid var(--border);background:var(--input-bg)}
.chat-head .titles{flex:1;min-width:0;text-align:center;border:1px solid var(--border);border-radius:999px;padding:.2rem .9rem}
.chat-head .name{font-size:.95rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat-head .folder{font-size:.75rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.menu{position:absolute;right:1rem;top:3.1rem;background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius);padding:.3rem;min-width:10rem}
.rename{display:flex;gap:.5rem;margin:.5rem 0 0}
.rename input{flex:1;min-width:0}
.reply{font-size:var(--fs-body);line-height:1.6;margin:.9rem 0;white-space:pre-wrap;word-wrap:break-word}
.reply.md{white-space:normal}
.reply p{margin:0 0 .6rem}
.reply p:last-child{margin-bottom:0}
.reply ul,.reply ol{margin:.2rem 0 .6rem 1.3rem;padding:0}
.reply li{margin:.15rem 0}
.reply code{font-family:ui-monospace,monospace;font-size:.9em;background:var(--code-bg);padding:.1rem .35rem;border-radius:4px}
.reply pre.box code{background:none;padding:0}
.auto-line{display:block;width:100%;text-align:left;background:none;border:0;padding:0 .2rem .45rem;margin:0;font-size:var(--fs-small);color:var(--muted);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.switch-row{display:flex;align-items:center;justify-content:space-between;padding:.6rem 0;border-bottom:1px solid var(--border)}
.switch-row button{min-width:4.5rem;border-radius:999px;margin:0}
.switch-row button.on{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.reply.you{background:var(--cred-bg);border-radius:var(--radius);padding:.65rem .9rem;margin-left:2.5rem}
.reply.done{border-left:3px solid var(--ok);padding-left:.75rem}
.reply.error{color:var(--fail)}
.steps{display:flex;align-items:center;gap:.6rem;color:var(--muted);background:none;border:0;padding:.35rem 0;margin:.2rem 0;font-size:var(--fs-small);cursor:pointer;text-align:left}
.steps:hover{color:var(--fg)}
.glyph{font-family:ui-monospace,monospace;font-size:.95rem;width:1.6rem;flex-shrink:0;text-align:center}
.waiting{border:1px solid var(--accent);border-radius:var(--radius);padding:.75rem 1rem;margin:.75rem 0}
.waiting .what{font-size:.8rem;color:var(--muted);margin-bottom:.35rem}
.waiting pre{margin:0}
.decide{display:flex;gap:.5rem;margin-top:.65rem}
.decide button{font-weight:600}
.pending{opacity:.5;position:relative}
.pending::after{content:"";display:inline-block;width:.7em;height:.7em;margin-left:.45em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;vertical-align:-.05em;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.sheet-note{color:var(--fail);margin:.4rem 0}
.sheet-note.wait{color:var(--muted)}
.ring{position:relative;border:1px solid var(--border);background:var(--input-bg)}
.ring svg{position:absolute;inset:0;width:100%;height:100%}
.ring .track{fill:none;stroke:var(--border);stroke-width:2.5}
.ring .arc{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;filter:drop-shadow(0 0 2px var(--accent));transition:stroke-dashoffset .4s}
.ring.warn .arc{stroke:var(--fail);filter:drop-shadow(0 0 2px var(--fail))}
.ring span{position:relative;font-size:.68rem;font-weight:600}
.context-bar{display:flex;align-items:center;justify-content:space-between;width:100%;box-sizing:border-box;background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius);padding:.45rem .8rem;margin:0 0 .45rem;font-size:var(--fs-small);color:var(--fg);cursor:pointer;text-align:left}
.context-bar.warn{border-color:var(--fail);color:var(--fail)}
.stat-row{display:flex;justify-content:space-between;gap:1rem;padding:.45rem 0;border-bottom:1px solid var(--border)}
.stat-row span:last-child{font-family:ui-monospace,monospace}
.sheet h3{font-size:var(--fs-small);color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin:1.1rem 0 .2rem}
.sheet .wide{width:100%;margin:.8rem 0 0;font-weight:600}
.menu button,.menu a{display:flex;align-items:center;gap:.6rem;width:100%;text-align:left;border:0;background:none;margin:0;padding:.5rem .7rem;color:var(--fg);text-decoration:none;font-size:var(--fs-body);box-sizing:border-box;border-radius:10px}
.menu button:hover,.menu a:hover{background:var(--input-bg)}
.menu .ico{width:1.2rem;text-align:center;color:var(--muted)}
.menu hr{border:0;border-top:1px solid var(--border);margin:.25rem .4rem}
.approve{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
pre.box{background:var(--code-bg);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem .9rem;font-family:ui-monospace,monospace;font-size:.85rem;white-space:pre-wrap;word-wrap:break-word;max-height:24rem;overflow:auto;margin:.35rem 0 1rem}
.dock{bottom:0}
.dock .bar-inner{padding:.4rem 1rem .8rem}
.working{display:flex;align-items:center;gap:.6rem;color:var(--accent);font-size:var(--fs-small);margin:0 .2rem .45rem}
.dots{display:inline-flex;gap:.3rem}
.dots span{width:.5rem;height:.5rem;border-radius:50%;background:var(--accent);animation:pulse 1.2s infinite ease-in-out}
.dots span:nth-child(2){animation-delay:.2s}
.dots span:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,80%,100%{opacity:.25;transform:scale(.75)}40%{opacity:1;transform:scale(1)}}
.composer{display:flex;gap:.5rem;align-items:flex-end;border:1px solid var(--border);border-radius:var(--radius);padding:.4rem .4rem .4rem .9rem;background:var(--input-bg)}
.composer textarea{flex:1;min-height:2.2rem;max-height:10rem;resize:none;font:inherit;padding:.4rem 0;color:var(--fg);background:none;border:0;outline:none}
.composer button{background:var(--accent);color:var(--accent-fg);border:0;font-weight:700}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:20}
.sheet{position:fixed;left:0;right:0;margin:0 auto;max-width:52rem;box-sizing:border-box;bottom:0;z-index:21;max-height:82vh;overflow:auto;background:var(--code-bg);border-radius:var(--radius) var(--radius) 0 0;padding:.6rem 1.2rem 1.5rem;animation:rise .2s ease-out}
@keyframes rise{from{transform:translateY(30%);opacity:.4}to{transform:none;opacity:1}}
.sheet .grip{width:2.6rem;height:.3rem;border-radius:2px;background:var(--border);margin:0 auto .6rem}
.sheet-head{display:flex;align-items:center;gap:.75rem;margin-bottom:.8rem}
.sheet-head h2{flex:1;text-align:center;margin:0;font-size:1.05rem;padding-right:2.3rem}
.step-row{display:flex;align-items:center;gap:.75rem;width:100%;background:none;border:0;padding:.7rem 0;margin:0;text-align:left;font-size:var(--fs-body);color:var(--fg);cursor:pointer}
.step-row .text{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.step-row .chev{color:var(--muted)}
.step-link{width:1.6rem;display:flex;justify-content:center}
.step-link span{width:1px;height:1.1rem;background:var(--border)}
.detail-summary{font-size:var(--fs-body);margin:0 0 1rem}
.section-head{display:flex;justify-content:space-between;align-items:center;color:var(--muted)}
.section-head button{font-size:.8rem;padding:.25rem .6rem;margin:0}
.notice{color:var(--muted)}
.fail-line{color:var(--fail)}
</style>
<div id="app">
	<section id="pair-view" class="hidden">
		<h1>Pair this device</h1>
		<p>In Cline Cubed, open the Remote Control popover and press <strong>Pair a device</strong>. Enter the code it shows.</p>
		<form id="pair-form">
			<input id="pair-code" autocomplete="one-time-code" autocapitalize="characters" placeholder="ABCD-EFGH" required>
			<button type="submit">Pair</button>
		</form>
		<p id="pair-error" class="fail-line"></p>
	</section>
	<section id="list-view" class="hidden">
		<h1>Your shared chats</h1>
		<div id="chat-list"></div>
		<p id="list-empty" class="notice hidden">No chats are shared yet. In Cline Cubed, open a chat's Remote Control popover and turn on <strong>Share this chat with my devices</strong>.</p>
	</section>
	<section id="chat-view" class="hidden">
		<div class="bar chat-head"><div class="bar-inner">
			<div class="row">
				<a class="icon-button" href="#" aria-label="Back to the chat list">&lsaquo;</a>
				<div class="titles">
					<div class="name" id="chat-title"></div>
					<div class="folder" id="chat-folder"></div>
				</div>
				<button type="button" class="icon-button ring hidden" id="ring" aria-label="Context in use">
					<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="15.5"></circle><circle class="arc" id="ring-arc" cx="18" cy="18" r="15.5" transform="rotate(-90 18 18)"></circle></svg>
					<span id="ring-text"></span>
				</button>
				<button type="button" class="icon-button" id="menu-button" aria-label="Chat menu">&middot;&middot;&middot;</button>
			</div>
			<div class="menu hidden" id="menu">
				<button type="button" id="rename-button"><span class="ico">&#9998;</span>Rename</button>
				<button type="button" id="copy-link-button"><span class="ico">&#10697;</span><span id="copy-link-label">Copy link</span></button>
				<button type="button" id="tasks-button"><span class="ico">&#9656;</span>Background tasks</button>
				<button type="button" id="theme-menu-button"><span class="ico">&#9680;</span><span id="theme-menu-label"></span></button>
				<hr>
				<button type="button" id="stop-sharing-button"><span class="ico">&#8856;</span>Stop sharing</button>
				<a id="feedback-link" href="https://marketplace.visualstudio.com/items?itemName=DougJoseph.cline-cubed" target="_blank" rel="noopener noreferrer"><span class="ico">&#9993;</span>Send feedback</a>
			</div>
			<form id="rename-form" class="rename hidden">
				<input id="rename-input" aria-label="Chat name">
				<button type="submit">Save</button>
				<button type="button" id="rename-cancel">Cancel</button>
			</form>
		</div></div>
		<div id="messages"></div>
		<div class="bar dock"><div class="bar-inner">
			<button type="button" id="context-bar" class="context-bar hidden"></button>
			<div id="working" class="working hidden"><span class="dots"><span></span><span></span><span></span></span>Working&hellip;</div>
			<button type="button" id="auto" class="auto-line hidden"></button>
			<form id="composer" class="composer">
				<textarea id="message-input" rows="1" placeholder="Message this chat"></textarea>
				<button type="submit" class="icon-button" aria-label="Send">&uarr;</button>
			</form>
		</div></div>
	</section>
	<p id="status-line" class="fail-line"></p>
</div>
<div id="scrim" class="scrim hidden"></div>
<div id="sheet" class="sheet hidden" role="dialog" aria-modal="true"></div>
<script>
(function () {
	var base = location.pathname.replace(/[^/]*$/, "");
	var views = { pair: el("pair-view"), list: el("list-view"), chat: el("chat-view") };
	var state = { chatId: "", cursor: 0, messages: [], working: false, autoApprove: null, meta: null, timer: null, listTimer: null, epoch: 0 };
	var RING_CIRCUMFERENCE = 2 * Math.PI * 15.5;
	var AUTO_ACTIONS = [
		{ id: "readFiles", label: "Read" },
		{ id: "editFiles", label: "Edit" },
		{ id: "executeSafeCommands", label: "Commands" },
		{ id: "useBrowser", label: "Web Fetch" },
		{ id: "useMcp", label: "MCP" }
	];
	var TICK = "\u0060";
	var sheet = { open: false, mode: "steps", groupKey: 0, stepKey: 0, note: "", noteWait: false };
	// What a tap asked for that the chat has not confirmed yet; each entry gives up after ten seconds.
	// After ten seconds the tap says it is still waiting; only after thirty does it give up.
	var PENDING_WAIT_MS = 10000;
	var PENDING_MS = 30000;
	var pending = { auto: {}, decision: null, rename: null, compact: null };
	var APPROVAL_ASKS = { tool: 1, command: 1, use_mcp_server: 1, browser_action_launch: 1, use_subagents: 1 };
	var EDIT_TOOLS = { editedExistingFile: "Edited", newFileCreated: "Created", fileDeleted: "Deleted" };
	var READ_TOOLS = { readFile: 1, listFilesTopLevel: 1, listFilesRecursive: 1, listCodeDefinitionNames: 1, searchFiles: 1 };

	function el(id) { return document.getElementById(id); }

	function api(route, options, extraQuery) {
		options = options || {};
		var init = { method: options.method || "GET", credentials: "same-origin", headers: {} };
		if (options.body !== undefined) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(options.body);
		}
		return fetch(base + "index.php?route=" + encodeURIComponent(route) + (extraQuery || ""), init).then(function (response) {
			var type = response.headers.get("content-type") || "";
			if (type.indexOf("application/json") === -1) {
				throw new Error("The host answered with a verification page instead of the relay. Reload this page.");
			}
			return response.json().then(function (body) {
				if (!response.ok) {
					var failure = new Error(body.hint || body.error || ("HTTP " + response.status));
					failure.code = body.error || "";
					throw failure;
				}
				return body;
			});
		});
	}

	function show(name) {
		Object.keys(views).forEach(function (key) { views[key].classList.toggle("hidden", key !== name); });
		document.body.classList.toggle("in-chat", name === "chat");
	}

	function setStatus(text) { el("status-line").textContent = text || ""; }

	function stopTimers() {
		if (state.timer) { clearTimeout(state.timer); state.timer = null; }
		if (state.listTimer) { clearTimeout(state.listTimer); state.listTimer = null; }
		state.epoch++;
	}

	function route() {
		stopTimers();
		closeSheet();
		setStatus("");
		var hash = location.hash.replace(/^#/, "");
		api("pairing").then(function (who) {
			if (!who.paired) {
				show("pair");
				if (hash.indexOf("pair-") === 0) {
					el("pair-code").value = hash.slice(5);
					pair();
				}
				return;
			}
			if (hash.indexOf("session_") === 0) {
				openChat(hash.slice(8));
			} else {
				showList();
			}
		}).catch(function (error) { setStatus(error.message); });
	}

	function pair() {
		el("pair-error").textContent = "";
		api("pair", { method: "POST", body: { code: el("pair-code").value, name: navigator.userAgent } }).then(function () {
			location.hash = "";
			route();
		}).catch(function (error) { el("pair-error").textContent = error.message; });
	}

	function showList() {
		show("list");
		var epoch = state.epoch;
		api("chats").then(function (body) {
			if (epoch !== state.epoch) { return; }
			var list = el("chat-list");
			list.textContent = "";
			(body.chats || []).forEach(function (chat) {
				var link = document.createElement("a");
				link.className = "card chat-link";
				link.href = "#session_" + chat.id;
				var name = document.createElement("span");
				name.textContent = chat.name || "Untitled chat";
				var pill = document.createElement("span");
				pill.className = "pill";
				pill.textContent = chat.working ? "Working" : "";
				link.appendChild(name);
				link.appendChild(pill);
				list.appendChild(link);
			});
			el("list-empty").classList.toggle("hidden", (body.chats || []).length > 0);
			state.listTimer = setTimeout(function () { if (epoch === state.epoch) { showList(); } }, 5000);
		}).catch(handleFailure);
	}

	function handleFailure(error) {
		if (error && error.code === "not_paired") { route(); return; }
		setStatus(error.message);
	}

	function openChat(chatId) {
		show("chat");
		pending = { auto: {}, decision: null, rename: null, compact: null };
		state.meta = null;
		el("chat-title").classList.remove("pending");
		state.chatId = chatId;
		state.messages = [];
		state.working = false;
		el("chat-title").textContent = "";
		el("chat-folder").textContent = "";
		el("messages").textContent = "";
		render();
		var epoch = state.epoch;
		api("session/" + chatId + "/outbound", {}, "&cursor=latest").then(function (body) {
			if (epoch !== state.epoch) { return; }
			state.cursor = body.cursor || 0;
			return send({ kind: "sync", payload: {} }).then(function () { poll(epoch); resyncLater(epoch); });
		}).catch(handleFailure);
	}

	function send(event) {
		event.sentAt = Date.now();
		return api("session/" + state.chatId + "/inbound", { method: "POST", body: { events: [event] } });
	}

	function poll(epoch) {
		// One poll at a time per open chat; a poll still running for a chat that was closed does not block the next one.
		if (epoch !== state.epoch || (state.polling && state.pollingEpoch === epoch)) { return; }
		if (state.timer) { clearTimeout(state.timer); state.timer = null; }
		state.polling = true;
		state.pollingEpoch = epoch;
		api("session/" + state.chatId + "/outbound", {}, "&cursor=" + state.cursor).then(function (body) {
			if (state.pollingEpoch === epoch) { state.polling = false; }
			if (epoch !== state.epoch) { return; }
			state.cursor = body.cursor || state.cursor;
			var events = body.events || [];
			events.forEach(apply);
			if (!hasPending()) { setStatus(""); }
			var expired = settlePending();
			if (events.length || expired || hasPending()) { render(); }
			// For a few seconds after a tap the page checks every third of a second, so the answer shows sooner.
			state.timer = setTimeout(function () { poll(epoch); }, Date.now() < (state.fastUntil || 0) ? 330 : 1500);
		}).catch(function (error) {
			if (state.pollingEpoch === epoch) { state.polling = false; }
			if (epoch !== state.epoch) { return; }
			handleFailure(error);
			state.timer = setTimeout(function () { poll(epoch); }, 5000);
		});
	}

	/** A fresh full copy of the open chat every minute, so a gap of any cause closes on its own. */
	function resyncLater(epoch) {
		setTimeout(function () {
			if (epoch !== state.epoch) { return; }
			send({ kind: "sync", payload: {} }).catch(function () {}).then(function () { resyncLater(epoch); });
		}, 60000);
	}

	/** Checks quickly for a few seconds, starting now. */
	function hurry() {
		state.fastUntil = Date.now() + 4000;
		poll(state.epoch);
	}

	function hasPending() {
		return Object.keys(pending.auto).length > 0 || !!pending.decision || !!pending.rename || !!pending.compact;
	}

	/** Drops what the chat has confirmed, and gives up on what took too long, saying so. */
	function settlePending() {
		var now = Date.now();
		var expired = false;
		Object.keys(pending.auto).forEach(function (id) {
			var entry = pending.auto[id];
			if (state.autoApprove && !!state.autoApprove[id] === entry.value) {
				delete pending.auto[id];
				if (sheet.noteWait) { sheet.note = ""; sheet.noteWait = false; }
			} else if (now - entry.at > PENDING_WAIT_MS && now - entry.at <= PENDING_MS && !sheet.note) {
				sheet.note = "Still waiting on VS Code\u2026";
				sheet.noteWait = true;
				expired = true;
			} else if (now - entry.at > PENDING_MS) {
				delete pending.auto[id];
				sheet.note = "Couldn't change " + entry.label + ". Try again.";
				sheet.noteWait = false;
				expired = true;
			}
		});
		if (pending.decision) {
			var stillWaiting = false;
			var last = state.messages[state.messages.length - 1];
			if (last && last.ts === pending.decision.ts && last.type === "ask") { stillWaiting = true; }
			if (!stillWaiting) {
				pending.decision = null;
				setStatus("");
			} else if (now - pending.decision.at > PENDING_WAIT_MS && now - pending.decision.at <= PENDING_MS) {
				setStatus("Still waiting on VS Code\u2026");
			} else if (now - pending.decision.at > PENDING_MS) {
				pending.decision = null;
				setStatus("Couldn't send your answer. Try again.");
				expired = true;
			}
		}
		if (pending.compact && now - pending.compact.at > PENDING_MS) {
			pending.compact = null;
			sheet.note = "Couldn't compact. Try again.";
			sheet.noteWait = false;
			expired = true;
		}
		if (pending.rename) {
			if (now - pending.rename.at > PENDING_WAIT_MS && now - pending.rename.at <= PENDING_MS) {
				setStatus("Still waiting on VS Code\u2026");
			}
			if (now - pending.rename.at > PENDING_MS) {
				el("chat-title").textContent = pending.rename.previous;
				el("chat-title").classList.remove("pending");
				pending.rename = null;
				setStatus("Couldn't rename the chat. Try again.");
				expired = true;
			}
		}
		return expired;
	}

	function setTitle(payload) {
		if (payload.title !== undefined) {
			// A new name from the chat answers a pending rename, including a cleared name, which the chat
			// replaces with its first prompt.
			if (pending.rename) {
				pending.rename = null;
				el("chat-title").classList.remove("pending");
			}
			el("chat-title").textContent = payload.title || "Untitled chat";
		}
		if (payload.workspace !== undefined) { el("chat-folder").textContent = payload.workspace || ""; }
	}

	function apply(event) {
		var payload = event.payload || {};
		if (event.kind === "snapshot") {
			state.messages = payload.messages || [];
			state.working = !!payload.working;
			if (payload.autoApprove) { state.autoApprove = payload.autoApprove; }
			if (payload.meta) { state.meta = payload.meta; }
			setTitle(payload);
		} else if (event.kind === "update") {
			(payload.messages || []).forEach(function (message) {
				var index = -1;
				for (var i = 0; i < state.messages.length; i++) { if (state.messages[i].ts === message.ts) { index = i; break; } }
				if (index === -1) { state.messages.push(message); } else { state.messages[index] = message; }
			});
			// The chat's own order: anything not in it is gone from the chat, and is dropped here too.
			if (payload.order) {
				var position = {};
				payload.order.forEach(function (ts, i) { position[ts] = i; });
				state.messages = state.messages.filter(function (message) { return position[message.ts] !== undefined; });
				state.messages.sort(function (a, b) { return position[a.ts] - position[b.ts]; });
			}
			state.working = !!payload.working;
			if (payload.autoApprove) { state.autoApprove = payload.autoApprove; }
			if (payload.meta) {
				var before = state.meta && state.meta.context ? state.meta.context.used : 0;
				state.meta = payload.meta;
				if (pending.compact && payload.meta.context && payload.meta.context.used < before) {
					pending.compact = null;
					sheet.note = "Compacted.";
					sheet.noteWait = true;
				}
			}
		} else if (event.kind === "notice") {
			pending.compact = null;
			sheet.note = payload.text || "";
			sheet.noteWait = false;
			if (!sheet.open) { setStatus(payload.text || ""); }
		} else if (event.kind === "messages") {
			(payload.messages || []).forEach(function (message) {
				var index = -1;
				for (var i = 0; i < state.messages.length; i++) { if (state.messages[i].ts === message.ts) { index = i; break; } }
				if (index === -1) { state.messages.push(message); } else { state.messages[index] = message; }
			});
			state.messages.sort(function (a, b) { return a.ts - b.ts; });
		} else if (event.kind === "working") {
			state.working = !!payload.working;
		} else if (event.kind === "title") {
			setTitle(payload);
		}
	}

	function parseJson(text) {
		try { return JSON.parse(text); } catch (error) { return null; }
	}

	/** The chat keeps a command and its output in one message, joined by "Output:". */
	function splitCommand(text) {
		var marker = String(text || "").indexOf("\nOutput:");
		if (marker === -1) { return { command: String(text || ""), output: "" }; }
		return { command: text.slice(0, marker), output: text.slice(marker + 8).replace(/^\n/, "") };
	}

	function commandStep(message) {
		var parts = splitCommand(message.text);
		return { key: message.ts, kind: "command", glyph: ">_", title: "Command", summary: firstLine(parts.command), command: parts.command, output: parts.output };
	}

	/** Inline code, bold and links, each built as its own element; everything else stays text. */
	function inline(parent, text) {
		var pattern = /(\u0060[^\u0060]+\u0060)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
		var last = 0;
		var match;
		while ((match = pattern.exec(text)) !== null) {
			if (match.index > last) { parent.appendChild(document.createTextNode(text.slice(last, match.index))); }
			if (match[1]) {
				var code = document.createElement("code");
				code.textContent = match[1].slice(1, -1);
				parent.appendChild(code);
			} else if (match[2]) {
				var strong = document.createElement("strong");
				inline(strong, match[2].slice(2, -2));
				parent.appendChild(strong);
			} else {
				var link = document.createElement("a");
				link.textContent = match[3].slice(1, match[3].indexOf("]"));
				link.href = match[4];
				link.target = "_blank";
				link.rel = "noopener noreferrer";
				parent.appendChild(link);
			}
			last = pattern.lastIndex;
		}
		if (last < text.length) { parent.appendChild(document.createTextNode(text.slice(last))); }
	}

	function renderBlocks(node, text) {
		var paragraph = null;
		var list = null;
		String(text).split("\n").forEach(function (line) {
			var bullet = line.match(/^\s*[-*]\s+(.*)$/);
			var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
			var heading = line.match(/^#{1,6}\s+(.*)$/);
			if (!line.trim()) { paragraph = null; list = null; return; }
			if (bullet || numbered) {
				var tag = bullet ? "UL" : "OL";
				if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); node.appendChild(list); }
				var item = document.createElement("li");
				inline(item, (bullet || numbered)[1]);
				list.appendChild(item);
				paragraph = null;
				return;
			}
			list = null;
			if (heading) {
				var title = document.createElement("p");
				var strong = document.createElement("strong");
				inline(strong, heading[1]);
				title.appendChild(strong);
				node.appendChild(title);
				paragraph = null;
				return;
			}
			if (!paragraph) { paragraph = document.createElement("p"); node.appendChild(paragraph); }
			else { paragraph.appendChild(document.createElement("br")); }
			inline(paragraph, line);
		});
	}

	/** Fenced code becomes a code box; the rest becomes paragraphs, lists and inline marks. */
	function renderMarkdown(node, text) {
		var fence = TICK + TICK + TICK;
		String(text).split(fence).forEach(function (part, index) {
			if (index % 2 === 1) {
				var pre = document.createElement("pre");
				pre.className = "box";
				pre.textContent = part.replace(/^[^\n]*\n/, "");
				node.appendChild(pre);
				return;
			}
			renderBlocks(node, part);
		});
	}

	function firstLine(text) {
		return String(text || "").split("\n")[0];
	}

	/** One step as the sheet lists it: what kind it is, its one-line summary, and its detail. */
	function toolStep(message) {
		var parsed = parseJson(message.text || "") || {};
		var tool = String(parsed.tool || "");
		var target = parsed.path || "";
		if (EDIT_TOOLS[tool]) {
			return { kind: "edit", glyph: "✎", title: "Edit", summary: EDIT_TOOLS[tool] + " " + target, path: target, change: parsed.diff || parsed.content || "" };
		}
		if (READ_TOOLS[tool]) {
			var verb = tool === "searchFiles" ? "Searched " + (parsed.regex ? "for " + parsed.regex + " in " : "") : tool === "readFile" ? "Read " : "Listed ";
			return { kind: "read", glyph: "≡", title: "Read", summary: verb + target, path: target };
		}
		if (tool === "webFetch" || tool === "webSearch") {
			return { kind: "read", glyph: "≡", title: "Web", summary: (tool === "webFetch" ? "Fetched " : "Searched the web for ") + (parsed.path || parsed.content || ""), path: parsed.path || "" };
		}
		return { kind: "tool", glyph: "•", title: tool || "Tool", summary: (tool || "Used a tool") + (target ? " " + target : ""), path: target, change: parsed.content || "" };
	}

	/**
	 * Turns the messages into what the page shows: replies, folded step groups, and the request
	 * waiting on the person, which is never folded.
	 */
	function layout() {
		var items = [];
		var group = null;
		var lastCommand = null;
		var last = state.messages[state.messages.length - 1];
		var pendingTs = last && last.type === "ask" && !last.partial && APPROVAL_ASKS[last.ask] ? last.ts : 0;
		function addStep(step) {
			if (!group) { group = { type: "group", key: step.key, steps: [] }; items.push(group); }
			group.steps.push(step);
		}
		function reply(kind, text) {
			group = null;
			if (String(text).trim()) { items.push({ type: "reply", kind: kind, text: text }); }
		}
		state.messages.forEach(function (message) {
			var text = message.text || "";
			var images = message.hasImages ? "\n[image]" : "";
			if (message.ts === pendingTs) {
				group = null;
				var waiting = message.ask === "command"
					? { kind: "command", title: "Run this command?", body: splitCommand(text).command }
					: message.ask === "tool" ? (function (step) { return { kind: step.kind, title: step.summary + "?", body: step.change || "" }; })(toolStep(message))
					: { kind: "tool", title: "Allow this?", body: text };
				items.push({ type: "waiting", ts: message.ts, waiting: waiting });
				return;
			}
			if (message.type === "say") {
				if (message.say === "user_feedback" || message.say === "task") { reply("you", text + images); return; }
				if (message.say === "text") { reply("model", text + images); return; }
				if (message.say === "completion_result") { reply("done", text); return; }
				if (message.say === "error") { reply("error", text); return; }
				if (message.say === "command") {
					lastCommand = commandStep(message);
					addStep(lastCommand);
					return;
				}
				if (message.say === "command_output") {
					if (lastCommand) { lastCommand.output += (lastCommand.output ? "\n" : "") + text; }
					return;
				}
				if (message.say === "tool") {
					var said = toolStep(message);
					said.key = message.ts;
					addStep(said);
				}
				return;
			}
			if (message.ask === "command") {
				lastCommand = commandStep(message);
				addStep(lastCommand);
				return;
			}
			if (message.ask === "tool") {
				var asked = toolStep(message);
				asked.key = message.ts;
				addStep(asked);
				return;
			}
			if (message.ask === "followup" || message.ask === "plan_mode_respond") {
				var parsed = parseJson(text);
				reply("model", parsed ? (parsed.question || parsed.response || text) : text);
				return;
			}
			if (message.ask === "api_req_failed") { reply("error", text || "The request to the model failed."); }
		});
		return items;
	}

	function groupLabel(steps) {
		var counts = { command: 0, read: 0, edit: 0, tool: 0 };
		steps.forEach(function (step) { counts[step.kind] = (counts[step.kind] || 0) + 1; });
		var parts = [];
		function add(n, one, many) { if (n) { parts.push(n === 1 ? one : n + " " + many); } }
		add(counts.command, "ran 1 command", "commands");
		if (counts.command > 1) { parts[parts.length - 1] = "ran " + parts[parts.length - 1]; }
		add(counts.read, "read 1 file", "files");
		if (counts.read > 1) { parts[parts.length - 1] = "read " + parts[parts.length - 1]; }
		add(counts.edit, "edited 1 file", "files");
		if (counts.edit > 1) { parts[parts.length - 1] = "edited " + parts[parts.length - 1]; }
		add(counts.tool, "used 1 tool", "tools");
		if (counts.tool > 1) { parts[parts.length - 1] = "used " + parts[parts.length - 1]; }
		var label = parts.join(", ");
		return label.charAt(0).toUpperCase() + label.slice(1);
	}

	function render() {
		var box = el("messages");
		var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
		box.textContent = "";
		var items = layout();
		items.forEach(function (item) {
			if (item.type === "reply") {
				var node = document.createElement("div");
				if (item.kind === "you") {
					node.className = "reply you";
					node.textContent = item.text;
				} else {
					node.className = "reply md " + item.kind;
					renderMarkdown(node, item.text);
				}
				box.appendChild(node);
			} else if (item.type === "group") {
				var row = document.createElement("button");
				row.type = "button";
				row.className = "steps";
				var glyph = document.createElement("span");
				glyph.className = "glyph";
				glyph.textContent = "☰";
				var label = document.createElement("span");
				label.textContent = groupLabel(item.steps) + "  ›";
				row.appendChild(glyph);
				row.appendChild(label);
				row.onclick = function () { openSheet(item.key, 0); };
				box.appendChild(row);
			} else if (item.type === "waiting") {
				var card = document.createElement("div");
				card.className = "waiting";
				var what = document.createElement("div");
				what.className = "what";
				what.textContent = "Waiting on you";
				var title = document.createElement("div");
				title.textContent = item.waiting.title;
				card.appendChild(what);
				card.appendChild(title);
				if (item.waiting.body) {
					var pre = document.createElement("pre");
					pre.className = "box";
					pre.textContent = item.waiting.body;
					card.appendChild(pre);
				}
				var decide = document.createElement("div");
				decide.className = "decide";
				decide.appendChild(decisionButton("Approve", true, item.ts));
				decide.appendChild(decisionButton("Deny", false, item.ts));
				card.appendChild(decide);
				box.appendChild(card);
			}
		});
		el("working").classList.toggle("hidden", !state.working);
		renderContext();
		renderAuto();
		if (sheet.open) { renderSheet(items); }
		if (nearBottom) { window.scrollTo(0, document.body.scrollHeight); }
	}

	/** One quiet line above the message box, as VS Code places it; tapping it opens the switches. */
	function renderAuto() {
		var line = el("auto");
		if (!state.autoApprove) { line.classList.add("hidden"); return; }
		var on = AUTO_ACTIONS.filter(function (action) { return effectiveAuto(action.id); }).map(function (action) { return action.label; });
		line.textContent = "Auto-approve: " + (on.length ? on.join(", ") : "none") + "  \u203A";
		line.classList.remove("hidden");
	}

	/** A switch's value as the person last set it: the pending tap, or the chat's confirmed setting. */
	function effectiveAuto(id) {
		if (pending.auto[id]) { return pending.auto[id].value; }
		return !!(state.autoApprove && state.autoApprove[id]);
	}

	function openAutoSheet() {
		closeMenu();
		sheet.note = "";
		sheet.open = true;
		sheet.mode = "auto";
		el("scrim").classList.remove("hidden");
		el("sheet").classList.remove("hidden");
		renderSheet(layout());
	}

	/** The five switches, which apply to every chat, changed through the same path as VS Code's bar. */
	function renderAutoSheet(box) {
		box.appendChild(sheetHead("\u2715", "Close", closeSheet, "Auto-approve"));
		var note = document.createElement("p");
		note.className = "notice";
		note.textContent = "These apply to every chat.";
		box.appendChild(note);
		if (sheet.note) {
			var failed = document.createElement("p");
			failed.className = "sheet-note";
			failed.textContent = sheet.note;
			box.appendChild(failed);
		}
		AUTO_ACTIONS.forEach(function (action) {
			var on = effectiveAuto(action.id);
			var waiting = !!pending.auto[action.id];
			var row = document.createElement("div");
			row.className = "switch-row";
			var label = document.createElement("span");
			label.textContent = action.label;
			var button = document.createElement("button");
			button.type = "button";
			button.textContent = on ? "On" : "Off";
			button.className = (on ? "on" : "") + (waiting ? " pending" : "");
			button.disabled = waiting;
			button.setAttribute("aria-pressed", on ? "true" : "false");
			button.onclick = function () {
				// The switch moves at once, half-opaque, until the chat confirms it.
				pending.auto[action.id] = { value: !on, at: Date.now(), label: action.label };
				sheet.note = "";
				render();
				send({ kind: "autoApprove", payload: { action: action.id, enabled: !on } }).then(hurry).catch(function (error) {
					delete pending.auto[action.id];
					sheet.note = "Couldn't change " + action.label + ". Try again.";
					render();
					handleFailure(error);
				});
			};
			row.appendChild(label);
			row.appendChild(button);
			box.appendChild(row);
		});
	}

	function formatTokens(n) {
		n = Number(n) || 0;
		if (n >= 1000000) { return (n / 1000000).toFixed(1) + "m"; }
		if (n >= 1000) { return (n / 1000).toFixed(1) + "k"; }
		return String(n);
	}

	function formatCost(n) { return "$" + (Number(n) || 0).toFixed(4); }

	/** Context in use as a share of the point where compaction fires: 100% is the moment it fires. */
	function contextPercent() {
		var context = state.meta && state.meta.context;
		if (!context || !context.used) { return null; }
		var limit = context.compactAt || context.window;
		if (!limit) { return null; }
		return Math.min(100, Math.round((context.used / limit) * 100));
	}

	/** The ring in the header and, past 80%, the warning bar above the message box. */
	function renderContext() {
		var percent = contextPercent();
		var ring = el("ring");
		var bar = el("context-bar");
		if (percent === null) {
			ring.classList.add("hidden");
			bar.classList.add("hidden");
			return;
		}
		ring.classList.remove("hidden");
		ring.classList.toggle("warn", percent >= 95);
		el("ring-text").textContent = percent + "%";
		el("ring-arc").setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
		el("ring-arc").setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE * (1 - percent / 100)));
		ring.setAttribute("aria-label", "Context " + percent + "% of the way to compaction");
		if (percent >= 80) {
			bar.textContent = "Context " + percent + "% full \u00B7 compaction at 100%  \u203A";
			bar.classList.toggle("warn", percent >= 95);
			bar.classList.remove("hidden");
		} else {
			bar.classList.add("hidden");
		}
	}

	function openModeSheet(mode) {
		closeMenu();
		sheet.open = true;
		sheet.mode = mode;
		sheet.note = "";
		sheet.noteWait = false;
		el("scrim").classList.remove("hidden");
		el("sheet").classList.remove("hidden");
		renderSheet(layout());
	}

	function statRow(box, label, value) {
		var row = document.createElement("div");
		row.className = "stat-row";
		var left = document.createElement("span");
		left.textContent = label;
		var right = document.createElement("span");
		right.textContent = value;
		row.appendChild(left);
		row.appendChild(right);
		box.appendChild(row);
	}

	function sheetNote(box) {
		if (!sheet.note) { return; }
		var note = document.createElement("p");
		note.className = "sheet-note" + (sheet.noteWait ? " wait" : "");
		note.textContent = sheet.note;
		box.appendChild(note);
	}

	/** Context against the window and the compaction point, Compact now, and usage. */
	function renderContextSheet(box) {
		box.appendChild(sheetHead("\u2715", "Close", closeSheet, "Context and usage"));
		sheetNote(box);
		var meta = state.meta || {};
		var context = meta.context || {};
		var percent = contextPercent();
		var heading = document.createElement("h3");
		heading.textContent = "Context";
		box.appendChild(heading);
		statRow(box, "In use", formatTokens(context.used) + (context.window ? " of " + formatTokens(context.window) : ""));
		if (context.compactAt) { statRow(box, "Compaction fires at", formatTokens(context.compactAt)); }
		if (percent !== null) { statRow(box, "Toward compaction", percent + "%"); }
		var compact = document.createElement("button");
		compact.type = "button";
		compact.className = "wide approve" + (pending.compact ? " pending" : "");
		compact.disabled = !!pending.compact;
		compact.textContent = "Compact now";
		compact.onclick = function () {
			pending.compact = { at: Date.now() };
			sheet.note = "";
			render();
			send({ kind: "compact", payload: {} }).then(hurry).catch(function (error) {
				pending.compact = null;
				render();
				handleFailure(error);
			});
		};
		box.appendChild(compact);
		var usage = meta.usage || {};
		var chatHeading = document.createElement("h3");
		chatHeading.textContent = "This chat";
		box.appendChild(chatHeading);
		statRow(box, "Tokens in", formatTokens(usage.tokensIn));
		statRow(box, "Tokens out", formatTokens(usage.tokensOut));
		statRow(box, "Cache writes / reads", formatTokens(usage.cacheWrites) + " / " + formatTokens(usage.cacheReads));
		statRow(box, "Cost", formatCost(usage.cost));
		var allHeading = document.createElement("h3");
		allHeading.textContent = "All chats";
		box.appendChild(allHeading);
		statRow(box, "Cost across your chat history", formatCost(meta.allChatsCost));
	}

	/** Commands still running in this chat, as the extension reports them. */
	function renderTasksSheet(box) {
		box.appendChild(sheetHead("\u2715", "Close", closeSheet, "Background tasks"));
		var running = !!(state.meta && state.meta.running);
		var note = document.createElement("p");
		note.className = "notice";
		if (!running) {
			note.textContent = "No command is running in this chat.";
			box.appendChild(note);
			return;
		}
		note.textContent = "A command is running in this chat:";
		box.appendChild(note);
		var lastCommand = null;
		layout().forEach(function (item) {
			if (item.type === "group") { item.steps.forEach(function (step) { if (step.kind === "command") { lastCommand = step; } }); }
		});
		if (lastCommand) { box.appendChild(copySection("Command", lastCommand.command)); }
	}

	function decisionButton(text, approve, ts) {
		var button = document.createElement("button");
		button.type = "button";
		button.textContent = text;
		if (approve) { button.className = "approve"; }
		if (pending.decision && pending.decision.ts === ts) {
			button.disabled = true;
			if (pending.decision.approve === approve) { button.className += " pending"; }
		}
		button.onclick = function () {
			pending.decision = { ts: ts, approve: approve, at: Date.now() };
			render();
			send({ kind: "decision", payload: { ts: ts, approve: approve } }).then(hurry).catch(function (error) {
				pending.decision = null;
				render();
				handleFailure(error);
			});
		};
		return button;
	}

	function closeMenu() { el("menu").classList.add("hidden"); }

	function openSheet(groupKey, stepKey) {
		closeMenu();
		sheet.open = true;
		sheet.mode = "steps";
		sheet.groupKey = groupKey;
		sheet.stepKey = stepKey;
		el("scrim").classList.remove("hidden");
		el("sheet").classList.remove("hidden");
		renderSheet(layout());
	}

	function closeSheet() {
		sheet.open = false;
		el("scrim").classList.add("hidden");
		el("sheet").classList.add("hidden");
	}

	function sheetHead(buttonText, buttonLabel, onButton, title) {
		var head = document.createElement("div");
		head.className = "sheet-head";
		var button = document.createElement("button");
		button.type = "button";
		button.className = "icon-button";
		button.setAttribute("aria-label", buttonLabel);
		button.textContent = buttonText;
		button.onclick = onButton;
		var heading = document.createElement("h2");
		heading.textContent = title;
		head.appendChild(button);
		head.appendChild(heading);
		return head;
	}

	function copySection(name, text) {
		var wrap = document.createElement("div");
		var head = document.createElement("div");
		head.className = "section-head";
		var label = document.createElement("span");
		label.textContent = name;
		var copy = document.createElement("button");
		copy.type = "button";
		copy.textContent = "Copy";
		copy.onclick = function () {
			navigator.clipboard.writeText(text).then(function () {
				copy.textContent = "Copied";
				setTimeout(function () { copy.textContent = "Copy"; }, 2000);
			}, function () { copy.textContent = "Copy failed"; });
		};
		head.appendChild(label);
		head.appendChild(copy);
		var pre = document.createElement("pre");
		pre.className = "box";
		pre.textContent = text;
		wrap.appendChild(head);
		wrap.appendChild(pre);
		return wrap;
	}

	function renderSheet(items) {
		var group = null;
		items.forEach(function (item) { if (item.type === "group" && item.key === sheet.groupKey) { group = item; } });
		var box = el("sheet");
		box.textContent = "";
		var grip = document.createElement("div");
		grip.className = "grip";
		box.appendChild(grip);
		if (sheet.mode === "auto") { renderAutoSheet(box); return; }
		if (sheet.mode === "context") { renderContextSheet(box); return; }
		if (sheet.mode === "tasks") { renderTasksSheet(box); return; }
		if (!group) { closeSheet(); return; }
		var step = null;
		group.steps.forEach(function (candidate) { if (candidate.key === sheet.stepKey) { step = candidate; } });
		if (!step) {
			box.appendChild(sheetHead("✕", "Close", closeSheet, groupLabel(group.steps)));
			group.steps.forEach(function (candidate, index) {
				if (index > 0) {
					var link = document.createElement("div");
					link.className = "step-link";
					link.appendChild(document.createElement("span"));
					box.appendChild(link);
				}
				var row = document.createElement("button");
				row.type = "button";
				row.className = "step-row";
				var glyph = document.createElement("span");
				glyph.className = "glyph";
				glyph.textContent = candidate.glyph;
				var text = document.createElement("span");
				text.className = "text";
				text.textContent = candidate.summary;
				var chev = document.createElement("span");
				chev.className = "chev";
				chev.textContent = "›";
				row.appendChild(glyph);
				row.appendChild(text);
				row.appendChild(chev);
				row.onclick = function () { sheet.stepKey = candidate.key; renderSheet(layout()); };
				box.appendChild(row);
			});
			return;
		}
		box.appendChild(sheetHead("‹", "Back", function () { sheet.stepKey = 0; renderSheet(layout()); }, step.title));
		if (step.kind !== "command") {
			var summary = document.createElement("p");
			summary.className = "detail-summary";
			summary.textContent = step.summary;
			box.appendChild(summary);
		}
		if (step.kind === "command") {
			box.appendChild(copySection("Command", step.command));
			box.appendChild(copySection("Output", step.output || "(no output yet)"));
		} else {
			if (step.path) { box.appendChild(copySection("File", step.path)); }
			if (step.change) { box.appendChild(copySection(step.kind === "edit" ? "Change" : "Content", step.change)); }
		}
	}

	el("scrim").onclick = closeSheet;
	document.addEventListener("keydown", function (event) { if (event.key === "Escape") { closeSheet(); } });

	el("pair-form").onsubmit = function (event) { event.preventDefault(); pair(); };

	el("composer").onsubmit = function (event) {
		event.preventDefault();
		var input = el("message-input");
		var text = input.value.trim();
		if (!text) { return; }
		// Cleared at once, so the next message can be typed while this one is on its way; clearing on
		// the answer instead wiped whatever had been typed by then.
		input.value = "";
		send({ kind: "message", payload: { text: text } }).then(function () {
			state.working = true;
			render();
			hurry();
		}).catch(function (error) {
			// A message that did not go out comes back, ahead of anything typed since.
			input.value = input.value ? text + "\n" + input.value : text;
			handleFailure(error);
		});
	};

	el("message-input").onkeydown = function (event) {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			el("composer").requestSubmit();
		}
	};

	el("menu-button").onclick = function () {
		el("theme-menu-label").textContent = document.documentElement.getAttribute("data-theme") === "light" ? "Dark mode" : "Light mode";
		el("copy-link-label").textContent = "Copy link";
		el("menu").classList.toggle("hidden");
	};

	el("ring").onclick = function () { openModeSheet("context"); };
	el("context-bar").onclick = function () { openModeSheet("context"); };
	el("tasks-button").onclick = function () { openModeSheet("tasks"); };

	// The chat's own address, for another paired device.
	el("copy-link-button").onclick = function () {
		navigator.clipboard.writeText(location.href).then(function () {
			el("copy-link-label").textContent = "Copied";
			setTimeout(closeMenu, 900);
		}, function () { el("copy-link-label").textContent = "Copy failed"; });
	};

	// Takes the chat off every paired device; it stays as it is in VS Code.
	el("stop-sharing-button").onclick = function () {
		closeMenu();
		if (!window.confirm("Stop sharing this chat with your devices? It stays as it is in VS Code.")) { return; }
		send({ kind: "stopSharing", payload: {} }).then(function () { location.hash = ""; }).catch(handleFailure);
	};

	el("feedback-link").onclick = function () { closeMenu(); };

	// The chat view hides the page's branded bar, which holds the light and dark toggle, so the menu
	// carries the same switch.
	el("theme-menu-button").onclick = function () {
		el("menu").classList.add("hidden");
		el("theme-toggle").click();
	};

	el("auto").onclick = openAutoSheet;

	// A tap anywhere outside the menu, or on its own button again, closes it.
	document.addEventListener("click", function (event) {
		if (el("menu").classList.contains("hidden")) { return; }
		if (el("menu").contains(event.target) || el("menu-button").contains(event.target)) { return; }
		closeMenu();
	});

	el("rename-button").onclick = function () {
		el("menu").classList.add("hidden");
		el("rename-input").value = el("chat-title").textContent;
		el("rename-form").classList.remove("hidden");
		el("rename-input").focus();
	};

	el("rename-cancel").onclick = function () { el("rename-form").classList.add("hidden"); };

	el("rename-form").onsubmit = function (event) {
		event.preventDefault();
		var name = el("rename-input").value.trim();
		var previous = el("chat-title").textContent;
		pending.rename = { name: name, previous: previous, at: Date.now() };
		el("chat-title").textContent = name || "Untitled chat";
		el("chat-title").classList.add("pending");
		el("rename-form").classList.add("hidden");
		send({ kind: "rename", payload: { name: name } }).then(hurry).catch(function (error) {
			el("chat-title").textContent = previous;
			el("chat-title").classList.remove("pending");
			pending.rename = null;
			handleFailure(error);
		});
	};

	window.addEventListener("hashchange", route);
	route();
})();
</script>`
