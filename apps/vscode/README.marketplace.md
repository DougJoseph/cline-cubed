# Cline Cubed

<p align="center">
  <img src="https://raw.githubusercontent.com/DougJoseph/cline-cubed/main/assets/icons/icon.png" width="128" alt="Cline Cubed" />
</p>

Want several Cline chats running at the same time, side by side? **Get Cline Cubed!**

Want them all still there after you reload the window — or reinstall? **Get Cline Cubed!**

Want your chats and your files to stop fighting over the same editor space?
**Get Cline Cubed!**

Want to use affordable text-only models for Plan and Act, yet still paste an image
and have your chat understand it? **Get Cline Cubed!**

If you love Cline but want more of it, get Cline Cubed.

---

A fork of [Cline](https://github.com/cline/cline) that grows it in several directions
at once.

**Run several chats side by side** — each its own conversation, with its own work, its
own thinking indicator and its own Cancel, so a long refactor keeps running in one while
you ask something else in another. **Keep the workspace tidy** — chats gather as tabs in
a single locked editor group, files open in a group of their own, and edited files leave
one preview tab instead of a pile. **Come back to it** — after a window reload, or a full
reinstall, every chat returns with its conversation. **Know when everything happened** —
every message carries its own timestamp. And a third model channel, **Image Mode**, lets
a text-only Plan/Act model understand a pasted image: your vision model describes it, the
description is bridged in as a collapsible, copyable block, and the reasoning model never
receives raw image bytes.

- **Multiple chats at once** — each keyed to its own conversation, running side by side,
  cancelling independently.
- **A workspace that stays tidy** — chats gather as tabs in one locked group; files open
  in a group of their own and leave one preview tab, not a pile.
- **Chats that come back** — after a window reload, and after a reinstall, each with its
  own conversation.
- **Every message stamped with its time** — quiet in the chat, full precision on hover
  and in every copy-and-paste.
- **Prompt history in the chat box** — `↑` and `↓` walk back through what you typed,
  per chat.
- **Three model channels — Plan, Act, and Image Mode.** Each tab in API Configuration
  keeps its own provider, model, API key, and reasoning effort.
- **Capability-aware image bridge** — it runs only when the active Plan/Act model is
  non-vision (or unknown); vision-capable models receive the raw image as usual.
- **One master debug-logging switch** — Settings → General → **Debug logging**, off by
  default, turns on diagnostic output for the whole extension (the image bridge's per-call
  records among them) in the output channel. Errors and warnings are never gated by it, and a
  failed bridge call still shows its recent calls inline in the chat.
- **Update notices** — after an update, a notice names the new version and **What's New** opens
  in the chat view with this fork's own notes for that version, shipped inside the extension
  (**Cline Cubed: What's New** in the Command Palette brings them back any time); with VS Code's
  automatic extension updates off, Cline Cubed checks the Marketplace at start and asks whether
  to update — Yes installs in place, Not now waits.
- **Commands land in the chat you are working in** — click into a chat's prompt box and it
  becomes the one your commands reach: Jump to Chat Input, Settings, History, MCP Servers,
  Marketplace, Account and New Chat all arrive there, or, with no chat tapped, in the location
  chosen in Settings. In the Command Palette the toolbar commands carry the "Cline Cubed" prefix,
  and the names say what they do — New Chat, Marketplace, and Close Chat on the X that closes a
  chat.

## Chat layout (mirrors Claude Code)

Three New Chat buttons are always within reach — in the chats list's toolbar, at the top of
the editor, and at the top of the secondary sidebar chat. Every one opens or creates a chat
**in the location chosen in Settings**. (The Cline Cubed icon in the primary sidebar opens
your chats list rather than a chat — see "Your chats, listed" below.)

Every button behaves the same way. When the target area has **no chat**, you get the
**"What can I do for you?"** home — a chat whose default is also the history chooser
(recent chats, plus the prompt input at the bottom to start a new task). When a chat is
**already there**, a **new, independent chat** opens beside it and the existing one keeps
running, untouched.

That gives you **multiple chat sessions side by side** — each keyed to its own
conversation, each showing its own work. The secondary sidebar hosts one chat at full
height; further chats gather as tabs in a single editor group, so you slide the tab strip
between them.

A chat lives in one place and stays there: try to open one that is already open and the
panel running it comes forward with a brief notice, while the panel you clicked in is left
exactly as it was — nothing moves. Close a chat's tab, or the sidebar holding a chat, and that
chat ends; drag the docked chat to the other sidebar and it comes with you.

**Every chat owns its own busy state.** Each shows its own thinking indicator while it
works, and its own Cancel button, from its very first response onward — and cancelling
one chat stops that chat while every other chat keeps running.

New chat sessions open in the location picked by the **"Where new chat sessions open"**
setting (Settings → General, and offered on Get Started):

- **Editor area** (new tab) — the default
- **Secondary sidebar** (typically right)

The secondary sidebar can house only one chat, at full height, so the two choices come out like this: pick
**Secondary sidebar** and your first chat docks there while every later one opens as an editor
tab; pick **Editor area** and nothing docks at all — every chat is an editor tab. The setting
governs where new chats open; chats you already have open stay where they are. A gear button in the chat input row opens Settings quickly.

## Chats in one group, files in another

Cline Cubed gives chats and files their own homes, so neither ends up buried in the other.

**Every chat you open in the editor area gathers as a tab in ONE group.** Slide along the tab
strip to move between them exactly as you would between files, each tab carrying its chat's own
name. That group is locked, so nothing can drop a file on top of a conversation you are reading.

**Files go somewhere else, chosen with care.** A file Cline Cubed opens never lands in your chats
group — and never in a group holding another extension's chat panel either. If the only things
open are chat panels, it opens a fresh group for your files rather than intruding on anybody's
conversation.

**And files do not pile up.** An edited file appears in a preview tab — the italic one VS Code
replaces in place — so a session that edits ten files leaves one tab, not ten. A tab you opened
yourself is never closed and never quietly converted into a preview.

## Your chats come back

Reload the window and your chats are still there: every editor tab with its own conversation, and
the docked secondary-sidebar chat with its own. Uninstall, reinstall, reload — still there. The
record rides in VS Code's own workspace storage, so it outlasts far more than a restart, and a chat
you opened from your history is restored exactly like one you started by typing.

## Your chats, listed

The Cline Cubed icon in the **primary sidebar** opens a **chats list** rather than a chat: the chats open right now
sit at the top, each labelled with where it is, and your full history follows underneath. A New
Chat button sits above them, and the Settings, Account, and Marketplace buttons open right there
in the panel instead of commandeering one of your running chats.

Clicking a row opens that chat — one target, one outcome. If that chat is already open somewhere,
it is brought into view where it already lives: the panel running it comes forward, a brief notice
tells you it was already open, and the panel you clicked in stays exactly as it was — so a chat can
never be pulled out from under a half-typed message. A chat open nowhere opens in the surface you
clicked from when that surface is an empty home, and in a new editor tab when it is already showing
a chat: clicking three chats gives three windows, and the chat you are working in is never taken
from you. The per-row controls appear on hover at the right: details, favorite, and delete; clearing
the whole history is a single quiet control under the list. The chats list and the history panel inside a chat are the same component,
so both behave identically.

When a chat does open a brand-new editor column, the column widths are evened, so it never arrives
as a sliver beside a wide one.

## Name your chats

Every chat is displayed by its first prompt until you give it a name of its own. At the top of a
chat, hover the name and click it, or the pencil beside it, to edit in place; on a row in the chats
list or history, the name opens the chat and the pencil beside it renames. Renaming a chat, or
marking it a favorite, never moves it in the list. Enter or clicking away commits, Escape cancels,
and clearing the box restores the first prompt, so a rename is always undoable.

Renaming never rewrites what you actually typed: the name is stored in a field of its own, and your
first prompt stays intact in the chat's expanded details. The name shows everywhere the chat is
listed — the header at the top of the chat, history rows, the home screen's recent list, the chats
list, and its **editor tab** — and fuzzy search matches it as well as the prompt, so a renamed chat
is findable by its new name.

**Editor tabs are named too**, which is what makes several open chats worth having: a tab carries
its chat's name, or its first prompt if you have not renamed it, so every tab is distinguishable
rather than a row of identical ones. A long prompt is shortened to fit the tab strip, and a tab
with no chat in it yet reads "Cline Cubed". Tabs keep up on their own — a new chat's tab takes its
name as soon as the first prompt lands, a rename relabels the tab at once, and closing the chat
inside a tab returns it to "Cline Cubed".

## Every message stamped with its time

Every message carries the moment it happened, in your own timezone, rendered right in the chat —
no tokens spent and nothing sent anywhere to produce it.

The label stays quiet: **5:23 PM**, floated to the right of the message's first line so your text
wraps around it. Hover it and it expands, after a short pause and with a soft animation, into the
full stamp — **Aug 30, 2026, 5:23:12.179 PM**. Copy a message and that full stamp comes with it,
along with an invisible `User:` / `AI:` marker, so a conversation pasted anywhere reads correctly
without you labelling it by hand. Reopen an old chat and its messages carry their TRUE original
times, not the moment you reopened them.

## Your prompts, one arrow away

With the cursor in the chat box, press **↑** to bring back what you typed before — most recent
first, each press stepping further back — and **↓** to walk down again. History is per chat, so
each conversation offers its own prompts and never somebody else's.

A draft you had already started is safe: coming back down, the second-to-last **↓** hands your
draft back before the final one returns you to an empty box, and **↑** from empty picks the draft
up again. Multi-line editing keeps its arrows — the cycle only engages when the caret is on the
first line going up, or the last line coming down.

## It knows what it is

Ask Cline Cubed what it is and it can tell you: the fork's name, its Marketplace listing, and its
repository. It also knows where its own chat transcripts live and how they are laid out, so it can
answer questions about your own history — what time you posted something in this chat, for
instance — and it asks before reading anything, because those files sit outside your project.

## Setup — Image Mode

Nothing below is needed to run multiple chats, keep them through a reload, or use the rest of the
fork — install it and all of that is already working. These steps set up **Image Mode**, the one
feature that needs a model of its own:

1. Open Settings → **API Configuration** and pick the **Image Mode** tab.
2. Choose a vision-capable **model** — DeepSeek's `deepseek-v4-flash-vision-exp`, for
   instance, or a vision model from OpenAI, OpenRouter, or Gemini — and enter that
   provider's API key.
3. Paste an image into the chat — the bridge describes it and feeds the text
   description to your Plan/Act model.

**The pairing this fork is developed and tested against:** `deepseek-reasoner` for Plan and Act,
which cannot see images, with `deepseek-v4-flash-vision-exp` as the Image Mode model. That is the
exact case the bridge exists for — a strong, affordable text-only reasoner that never has to give
up understanding a screenshot.

## Debug logging

One switch, in **Settings → General → Debug logging**, off by default. It turns on diagnostic
output for the whole extension — the image bridge included — to `View → Output → Cline Cubed`.
Turn it on while you are looking into something and off afterwards; it is verbose.

Errors and warnings are always reported, whether debug logging is on or off. A failed image-bridge
call still shows its recent-calls panel inline in the chat either way, with a one-click switch —
which now turns debug logging off for the whole extension, and says so.

## More

- **Fork:** https://github.com/DougJoseph/cline-cubed
- **Issues:** https://github.com/DougJoseph/cline-cubed/issues
- **Documentation:** https://docs.cline.bot/
