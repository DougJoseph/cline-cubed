# Cline Cubed

<p align="center">
  <img src="https://raw.githubusercontent.com/DougJoseph/cline-cubed/main/assets/icons/icon.png" width="128" alt="Cline Cubed" />
</p>

Want to have multiple Cline chats running at the same time? **Get Cline Cubed!**

Want to use affordable text-only models for Plan mode and Act mode, yet still paste
an image and have your chat understand it? **Get Cline Cubed!**

Cline Cubed adds a third model channel — **Image Mode**. When you add an image to a
prompt or reply and your Plan/Act model can't see images, the image is routed to your
Image Mode model first and its description is added to your prompt as text. And you
can run multiple chat sessions at once, each with its own conversation.

If you love Cline but want more of it, get Cline Cubed.

---

A fork of [Cline](https://github.com/cline/cline) that adds a third **Image Mode**
model channel. When you paste an image into a chat running a non-vision model
(e.g. DeepSeek Reasoner), your configured Image Mode vision model describes the
image, and that description is bridged into the chat as a collapsible, copyable
text block — so non-vision models get full image context without ever receiving
raw image bytes.

- **Three model channels — Plan, Act, and Image Mode.** Each tab in API
  Configuration keeps its own provider, model, API key, and reasoning effort.
- **Image bridge** — images are intercepted at send, described by the Image Mode
  vision model, and rolled up as a selectable/copyable block.
- **Capability-aware** — the bridge runs only when the active Plan/Act model is
  non-vision (or unknown); vision-capable models receive the raw image as usual.
- **Debug logging** — a Settings toggle records each bridge call (provider,
  model, URL, image type/size, auth, status) to the output channel and shows the
  most recent calls inline under failed bridge blocks, with a one-click toggle
  right in the chat.

## Chat layout (mirrors Claude Code)

Three New Chat buttons are always within reach — in the chats list's toolbar, at the top of
the Editor, and at the top of the Secondary sidebar chat. Every one opens or creates a chat
**in the location chosen in Settings**. (The Cline Cubed icon in the left activity bar opens
your chats list rather than a chat — see "Your chats, listed" below.)

Every button behaves the same way. When the target area has **no chat**, you get the
**"What can I do for you?"** home — a chat whose default is also the history chooser
(recent chats, plus the prompt input at the bottom to start a new task). When a chat is
**already there**, a **new, independent chat** opens beside it and the existing one keeps
running, untouched.

That gives you **multiple chat sessions side by side** — each keyed to its own
conversation, each showing its own work. The sidebar hosts one chat at full height;
further chats open as editor tabs, which you can arrange side by side. A chat lives in
one place: open it somewhere else and it moves there, with its old spot returning to
the home.

New chat sessions open in the location picked by the **"Where new chat sessions open"**
setting (Settings → General, or the chooser right on the chat home):

- **Editor area** (new tab) — the default
- **Secondary sidebar** (typically right)

The setting governs where new chats open; chats you already have open stay where they
are. A gear button in the chat input row opens Settings quickly.

## Your chats, listed

The left activity-bar icon opens a **chats list** rather than a chat: the chats open right now
sit at the top, each labelled with where it is, and your full history follows underneath. A New
Chat button sits above them, and the Settings, Account, and Marketplace buttons open right there
in the panel instead of commandeering one of your running chats.

Clicking a row opens that chat — one target, one outcome. The per-row controls appear on hover at
the right: details, favorite, and delete. There is no checkbox column and no full-width red delete
button; clearing the whole history is a single quiet control under the list. The chats list and
the history panel inside a chat are the same component, so both behave identically.

Opening a chat into a new editor column evens the column widths, so a new chat never arrives as a
sliver beside a wide one.

## Name your chats

Every chat is displayed by its first prompt until you give it a name of its own. Hover the name at
the top of a chat, or anywhere on a row in the chats list or history — the name highlights and a
pencil appears; click either to edit it in place. Enter or clicking away commits, Escape cancels,
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

## Setup

1. Open Settings → **API Configuration** and pick the **Image Mode** tab.
2. Choose a vision-capable provider and model (e.g. DeepSeek, OpenAI, OpenRouter,
   or Gemini with a vision model) and enter its API key.
3. Paste an image into the chat — the bridge describes it and feeds the text
   description to your Plan/Act model.

## Debug logging

In Settings → API Configuration → Image Mode tab, enable **Image bridge debug
logging**. Each bridge call is then logged to the output channel (`View → Output
→ Cline Cubed`), and the most recent calls are shown inline under the bridge
block. If a bridge call fails, the panel appears automatically with a one-click
way to turn the toggle off.

## More

- **Fork:** https://github.com/DougJoseph/cline-cubed
- **Issues:** https://github.com/DougJoseph/cline-cubed/issues
- **Documentation:** https://docs.cline.bot/
