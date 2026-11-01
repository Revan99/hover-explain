# Changelog

## 0.4.2

- Pressing Cmd/Ctrl on an already-hovered word now shows "<provider> · <model> is thinking…" in the hover straight away, then replaces it with the answer. (The editor shows no "Loading…" line for a hover reopened this way.) The answer only replaces it if the mouse is still on the word and you aren't typing.

## 0.4.1

- Fix: a slow, natural approach onto a word (mouse settling after more than ~0.5s) still needed a second hover. The explanation now starts when the editor asks for the hover, however long the mouse takes to settle.
- Pressing Cmd/Ctrl on an already-hovered word no longer moves your text cursor: a temporary extra cursor is used to reopen the hover, and removed immediately.
- New "Hover Explain" output channel logging each Cmd+hover, request and answer time (View → Output → Hover Explain).

## 0.4.0

- Fix: the answer needed a second hover to appear. The hover now waits for it and fills it in place.
- Pressing Cmd/Ctrl while already hovering a symbol now explains it; no need to hold the key before moving onto it.
- Background definition lookups (from the editor's AI features or other extensions) no longer start requests. An explanation starts only for the word under the mouse.
- Cmd+hover works even when the editor reports the window as unfocused.
- Removed the 0.3.4/0.3.5 decoration-based refresh, which didn't work for mouse hovers.

## 0.3.5

- Fix: Cmd+hover on a word with no other hover content needed a second hover to show the answer. The word is now marked the moment Cmd+hover lands on it, so the hover opens with "thinking…" and updates in place.

## 0.3.4

- Fix: an open hover stayed on "Loading…" until the mouse moved away and back. The hover now shows "thinking…" straight away and updates in place when the answer arrives.

## 0.3.3

- Fix: setup failed with "not a registered configuration" when the editor refused settings writes. Choices are now also kept in the extension's own storage, so setup works regardless; hand-edited settings still take precedence.

## 0.3.2

- "Choose Provider" always shows the API key step (leave it empty to keep a saved key).
- The model picker opens immediately and shows a loading bar while the model list arrives.
- New status bar item shows the provider in use, or "set up" when a key or model is missing; click it to change.

## 0.3.1

- Fix: "Choose Provider" stopped before asking for the API key when the editor couldn't save the setting. It now asks for the key and model first, saves at the end, and shows an error if saving fails.

## 0.3.0

- First public release.
- Cmd/Ctrl+hover triggers an explanation, shown in the normal hover.
- Any OpenAI-compatible provider: NVIDIA (default), OpenAI, OpenRouter, Groq, Gemini, Ollama, LM Studio or a custom URL. Claude Code is also supported.
- "Choose Provider" walks through provider, API key and model; "Choose Model" lists the provider's live models.
- API keys are kept in the editor's secret storage, one per provider.
- Context includes the symbol's surroundings, its definition and other usages.
