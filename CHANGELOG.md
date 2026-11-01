# Changelog

## 0.3.0

- First public release.
- Cmd/Ctrl+hover triggers an explanation, shown in the normal hover.
- Any OpenAI-compatible provider: NVIDIA (default), OpenAI, OpenRouter, Groq, Gemini, Ollama, LM Studio or a custom URL. Claude Code is also supported.
- "Choose Provider" walks through provider, API key and model; "Choose Model" lists the provider's live models.
- API keys are kept in the editor's secret storage, one per provider.
- Context includes the symbol's surroundings, its definition and other usages.
