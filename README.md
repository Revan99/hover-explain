# Hover Explain

Hold **Cmd** (macOS) or **Ctrl** (Windows/Linux) and hover a variable, function or any other symbol. A short explanation of what it holds or does appears in the normal editor hover.

Use whichever model you like: NVIDIA's free API, OpenAI, OpenRouter, Groq, Google Gemini, a local model in Ollama or LM Studio, any other OpenAI-compatible API, or Claude Code.

Works in Cursor, VS Code, Windsurf, VSCodium and other VS Code–based editors, for every language that has a language server.

## How to use

1. Hover a symbol and press **Cmd** / **Ctrl**, or hold the key first and then move onto the symbol.
2. Keep the mouse there; you can release the key. The hover shows "Loading…" and fills in the explanation when it arrives, labelled with the provider and model that wrote it.
3. Hovering the same symbol again shows the explanation straight away, until you edit the file.

You can also run **Hover Explain: Explain Symbol at Cursor** from the Command Palette to explain the symbol at the text cursor.

## Setup

Run **Hover Explain: Choose Provider** from the Command Palette. It walks you through three steps:

1. **Provider:** pick where explanations come from.
2. **API key:** if the provider needs one, paste it. Keys are kept in the editor's secret storage, not in your settings file, and each provider has its own.
3. **Model:** pick from the provider's live model list, or type any model id.

| Provider | Key | Notes |
| --- | --- | --- |
| NVIDIA (default) | [build.nvidia.com](https://build.nvidia.com) | Free, rate-limited tier. Defaults to `nvidia/nemotron-3.5-lightning-30b-a3b`. |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | Models from most labs behind one key, including some free ones. |
| Groq | [console.groq.com](https://console.groq.com/keys) | Very fast; has a free tier. |
| Google Gemini | [aistudio.google.com](https://aistudio.google.com/apikey) | Uses Gemini's OpenAI-compatible endpoint; has a free tier. |
| Ollama | none | Runs on your machine. Start Ollama and pull a model first. |
| LM Studio | none | Runs on your machine. Start its local server first. |
| Custom | optional | Any OpenAI-compatible `/chat/completions` API: vLLM, llama.cpp server, LiteLLM, Azure OpenAI proxies, DeepSeek, Mistral, Together and others. |
| Claude Code | uses its own login | Install [Claude Code](https://docs.claude.com/en/docs/claude-code) and log in with `claude` → `/login`. Models: `haiku` (default), `sonnet`, `opus`. |

To switch models later, run **Hover Explain: Choose Model**. To replace a key, run **Hover Explain: Set API Key**.

## What it sends

When you trigger an explanation, the extension sends the chosen provider:

- the symbol's name, the file's relative path and its language
- about 25 lines on each side of the symbol
- about 10 lines on each side of where it is defined, if that is elsewhere
- up to 6 other lines where it is used

Nothing is sent when you hover without the modifier key. If your code must not leave your machine, use Ollama or LM Studio.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `hoverExplain.provider` | `nvidia` | `nvidia`, `openai`, `openrouter`, `groq`, `gemini`, `ollama`, `lmstudio`, `custom` or `claude-code` |
| `hoverExplain.model` | (empty) | Model id. Empty uses the provider's default where it has one |
| `hoverExplain.baseUrl` | (empty) | API base URL, the part before `/chat/completions`. Required for `custom`; overrides the built-in URL for the others |
| `hoverExplain.claudePath` | (empty) | Path to the `claude` CLI. Empty means `~/.local/bin/claude`, then `PATH` |
| `hoverExplain.timeoutSeconds` | `60` | Give up on a request after this many seconds |

## Commands

- **Hover Explain: Choose Provider**
- **Hover Explain: Choose Model**
- **Hover Explain: Set API Key** (submit an empty value to remove the key)
- **Hover Explain: Explain Symbol at Cursor**
- **Hover Explain: Clear Cache**

## How the Cmd+hover trigger works

Extensions can't see which keys are held during a hover. While Cmd/Ctrl is held, though, the editor asks extensions for the definition of the word under the mouse so it can underline it. Hover Explain answers that request with nothing, so Go to Definition and Cmd+click work as before, and uses it as the trigger.

Definitions are also looked up in the background (by the editor's own AI features, for example). Those never cause a request: an explanation starts only when the editor also asks for a hover on that same word, which happens only for the word under the mouse.

If you were already resting on the word when you pressed Cmd, the editor has finished that hover and won't ask again until the mouse moves. Hover Explain then reopens the hover itself; the editor only allows that at the text cursor, so the cursor is moved onto the word for an instant and put straight back.

## License

[MIT](LICENSE)
