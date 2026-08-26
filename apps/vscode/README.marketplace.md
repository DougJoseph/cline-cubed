# Cline Cubed (image bridge)

<p align="center">
  <img src="https://raw.githubusercontent.com/DougJoseph/cline-cubed/main/assets/icons/icon.png" width="128" alt="Cline Cubed (image bridge)" />
</p>

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
