// Hover Explain: hold Cmd (Ctrl on Windows/Linux) and hover a symbol to get a short
// explanation from any OpenAI-compatible API or the Claude Code CLI, shown in the normal hover.
//
// Hover providers can't see modifier keys, but the editor asks definition providers
// for the word under the mouse while Cmd is held (to draw the go-to-definition link).
// A definition provider that returns nothing and just starts the explanation gives us
// a Cmd+hover trigger without changing what go-to-definition does.
const vscode = require('vscode');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_PROMPT =
  'You explain code symbols inside an editor hover. Given a symbol and code context, ' +
  'say in 1-3 short sentences what it holds or does and why it exists here. ' +
  'Plain Markdown, no headings, no preamble, do not restate the question.';

// OpenAI-compatible chat APIs. `custom` uses hoverExplain.baseUrl.
const PROVIDERS = {
  nvidia: { label: 'NVIDIA', baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-lightning-30b-a3b', keyUrl: 'https://build.nvidia.com' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', noKey: true },
  lmstudio: { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', noKey: true },
  custom: { label: 'Custom OpenAI-compatible' },
  'claude-code': { label: 'Claude Code CLI', model: 'haiku', cli: true },
};
const CLAUDE_CODE_MODELS = ['haiku', 'sonnet', 'opus'];
// The 0.2 key name, still read for NVIDIA so an existing key keeps working.
const LEGACY_NVIDIA_KEY = 'hoverExplain.nvidiaApiKey';

/** key -> { status: 'pending' | 'done' | 'error', text: string, label: string, promise: Promise } */
const cache = new Map();
let statusItem;
let secrets;
const CMD_HOVER_DELAY_MS = 350;
let cmdHoverTimer;
let internalLookups = 0;

function activate(context) {
  secrets = context.secrets;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(
    statusItem,
    vscode.languages.registerHoverProvider({ scheme: '*' }, { provideHover }),
    vscode.languages.registerDefinitionProvider({ scheme: '*' }, { provideDefinition }),
    vscode.commands.registerCommand('hoverExplain.explain', explainCommand),
    vscode.commands.registerCommand('hoverExplain.clearCache', () => cache.clear()),
    vscode.commands.registerCommand('hoverExplain.chooseProvider', chooseProvider),
    vscode.commands.registerCommand('hoverExplain.chooseModel', chooseModel),
    vscode.commands.registerCommand('hoverExplain.setApiKey', setApiKey),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('hoverExplain') && cache.clear()),
  );
}

function config() {
  return vscode.workspace.getConfiguration('hoverExplain');
}

function currentProvider() {
  const id = config().get('provider');
  return { id, ...(PROVIDERS[id] || PROVIDERS.custom) };
}

function currentModel(provider = currentProvider()) {
  return config().get('model') || provider.model || '';
}

function baseUrl(provider) {
  return (config().get('baseUrl') || provider.baseUrl || '').replace(/\/+$/, '');
}

function secretName(providerId) {
  return `hoverExplain.apiKey.${providerId}`;
}

async function getApiKey(providerId) {
  return (await secrets.get(secretName(providerId))) || (providerId === 'nvidia' ? await secrets.get(LEGACY_NVIDIA_KEY) : undefined);
}

// ---------- setup commands ----------

async function chooseProvider() {
  const current = config().get('provider');
  const pick = await vscode.window.showQuickPick(
    Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, description: id === current ? 'current' : p.baseUrl || '' })),
    { title: 'Hover Explain: provider' },
  );
  if (!pick) return;
  await config().update('provider', pick.id, vscode.ConfigurationTarget.Global);
  // A model name from another provider would not work here.
  await config().update('model', undefined, vscode.ConfigurationTarget.Global);

  const provider = currentProvider();
  if (pick.id === 'custom') {
    const url = await vscode.window.showInputBox({
      title: 'Base URL of the OpenAI-compatible API',
      placeHolder: 'https://example.com/v1',
      value: config().get('baseUrl'),
      ignoreFocusOut: true,
    });
    if (url === undefined) return;
    await config().update('baseUrl', url.trim(), vscode.ConfigurationTarget.Global);
  } else {
    await config().update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
  }
  if (!provider.cli && !provider.noKey && !(await getApiKey(pick.id))) {
    if (!(await setApiKey())) return;
  }
  await chooseModel();
}

async function setApiKey() {
  const provider = currentProvider();
  if (provider.cli) {
    vscode.window.showInformationMessage('Claude Code uses its own login. Run `claude` in a terminal and use /login.');
    return false;
  }
  const key = await vscode.window.showInputBox({
    title: `${provider.label} API key`,
    prompt: provider.keyUrl ? `Get one at ${provider.keyUrl}. Leave empty to remove the saved key.` : 'Leave empty to remove the saved key.',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return false;
  if (key.trim()) await secrets.store(secretName(provider.id), key.trim());
  else await secrets.delete(secretName(provider.id));
  cache.clear();
  vscode.window.setStatusBarMessage(`Hover Explain: ${provider.label} key ${key.trim() ? 'saved' : 'removed'}`, 3000);
  return true;
}

async function chooseModel() {
  const provider = currentProvider();
  let ids = CLAUDE_CODE_MODELS;
  if (!provider.cli) {
    try {
      ids = await listModels(provider);
    } catch (err) {
      ids = [];
      vscode.window.showWarningMessage(`Hover Explain: couldn't list ${provider.label} models (${err.message}). Type a model id instead.`);
    }
  }
  const current = currentModel(provider);
  const typeOwn = { label: '$(edit) Type a model id…', id: '' };
  const pick = await vscode.window.showQuickPick(
    [typeOwn, ...ids.map((id) => ({ label: id, id, description: id === current ? 'current' : '' }))],
    { title: `Hover Explain: ${provider.label} model`, placeHolder: current || 'Search models', matchOnDescription: true },
  );
  if (!pick) return;
  let model = pick.id;
  if (pick === typeOwn) {
    model = await vscode.window.showInputBox({ title: 'Model id', value: current, ignoreFocusOut: true });
    if (!model) return;
  }
  await config().update('model', model.trim(), vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`Hover Explain: using ${provider.label} · ${model.trim()}`, 4000);
}

async function listModels(provider) {
  const url = baseUrl(provider);
  if (!url) throw new Error('no base URL set');
  const res = await fetch(`${url}/models`, { headers: await authHeaders(provider), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (body.data || body.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

async function authHeaders(provider) {
  const key = await getApiKey(provider.id);
  return key ? { Authorization: `Bearer ${key}` } : {};
}

// ---------- hover trigger ----------

function cacheKey(doc, range) {
  return `${doc.uri.toString()}@${doc.version}:${range.start.line}:${range.start.character}`;
}

function provideDefinition(doc, position) {
  // Our own context lookups go through the definition providers too.
  if (internalLookups > 0) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== doc || !vscode.window.state.focused) return;
  const range = doc.getWordRangeAtPosition(position);
  if (!range) return;
  // Moving to another word with Cmd held replaces the timer, so only a resting mouse fires.
  clearTimeout(cmdHoverTimer);
  cmdHoverTimer = setTimeout(() => explainAt(doc, range), CMD_HOVER_DELAY_MS);
}

async function provideHover(doc, position, token) {
  const range = doc.getWordRangeAtPosition(position);
  if (!range) return;
  const entry = cache.get(cacheKey(doc, range));
  if (!entry) return;
  // The editor shows "Loading…" while this awaits, then the answer.
  if (entry.status === 'pending') await entry.promise;
  if (token.isCancellationRequested) return;

  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`$(sparkle) **${entry.label}**${entry.status === 'error' ? ' (error)' : ''}\n\n`);
  md.appendMarkdown(entry.text);
  return new vscode.Hover(md, range);
}

// Command-palette fallback: explain the symbol at the text cursor.
async function explainCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const range = doc.getWordRangeAtPosition(editor.selection.active);
  if (!range) {
    vscode.window.setStatusBarMessage('Hover Explain: no symbol under the cursor', 3000);
    return;
  }
  await explainAt(doc, range);
  const active = vscode.window.activeTextEditor;
  if (active && active.document === doc && range.contains(active.selection.active)) {
    await vscode.commands.executeCommand('editor.action.showHover');
  }
}

function explainAt(doc, range) {
  const key = cacheKey(doc, range);
  const existing = cache.get(key);
  if (existing && existing.status !== 'error') return existing.promise;

  const provider = currentProvider();
  const model = currentModel(provider);
  const entry = { status: 'pending', text: '', label: model ? `${provider.label} · ${model}` : provider.label };
  cache.set(key, entry);
  statusItem.text = `$(loading~spin) ${provider.label}: ${doc.getText(range)}`;
  statusItem.show();
  entry.promise = (async () => {
    try {
      const prompt = await buildPrompt(doc, range);
      entry.text = provider.cli ? await askClaudeCode(prompt, model) : await askOpenAICompatible(provider, model, prompt);
      entry.status = 'done';
    } catch (err) {
      entry.text = String(err.message || err);
      entry.status = 'error';
      if (provider.cli && /auth|login|OAuth/i.test(entry.text)) {
        vscode.window.showWarningMessage('Hover Explain: Claude Code is not logged in. Run `claude` in a terminal and use /login.');
      }
    } finally {
      statusItem.hide();
    }
  })();
  return entry.promise;
}

// ---------- context ----------

function snippet(doc, centerLine, radius) {
  const from = Math.max(0, centerLine - radius);
  const to = Math.min(doc.lineCount - 1, centerLine + radius);
  const lines = [];
  for (let i = from; i <= to; i++) lines.push(`${String(i + 1).padStart(5)}${i === centerLine ? '>' : ' '} ${doc.lineAt(i).text}`);
  return lines.join('\n');
}

function relPath(uri) {
  return vscode.workspace.asRelativePath(uri, false);
}

async function buildPrompt(doc, range) {
  const symbol = doc.getText(range);
  const line = range.start.line;
  const parts = [
    `Symbol: \`${symbol}\``,
    `File: ${relPath(doc.uri)} (${doc.languageId}), line ${line + 1}`,
    `Context (">" marks the line):\n\`\`\`\n${snippet(doc, line, 25)}\n\`\`\``,
  ];

  internalLookups++;
  const defs = await safeExec('vscode.executeDefinitionProvider', doc.uri, range.start).finally(() => internalLookups--);
  const def = defs && defs[0] && (defs[0].targetUri ? { uri: defs[0].targetUri, range: defs[0].targetRange } : defs[0]);
  if (def && !(def.uri.toString() === doc.uri.toString() && Math.abs(def.range.start.line - line) <= 25)) {
    const defDoc = await vscode.workspace.openTextDocument(def.uri);
    parts.push(`Definition in ${relPath(def.uri)}:\n\`\`\`\n${snippet(defDoc, def.range.start.line, 10)}\n\`\`\``);
  }

  const refs = (await safeExec('vscode.executeReferenceProvider', doc.uri, range.start)) || [];
  const usages = [];
  for (const ref of refs) {
    if (usages.length >= 6) break;
    if (ref.uri.toString() === doc.uri.toString() && Math.abs(ref.range.start.line - line) <= 25) continue;
    const refDoc = await vscode.workspace.openTextDocument(ref.uri);
    usages.push(`${relPath(ref.uri)}:${ref.range.start.line + 1}: ${refDoc.lineAt(ref.range.start.line).text.trim()}`);
  }
  if (usages.length) parts.push(`Other usages:\n${usages.join('\n')}`);

  return parts.join('\n\n');
}

async function safeExec(command, ...args) {
  try {
    return await vscode.commands.executeCommand(command, ...args);
  } catch {
    return undefined;
  }
}

// ---------- backends ----------

function claudeBinary() {
  const configured = config().get('claudePath');
  if (configured) return configured;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

function askClaudeCode(prompt, model) {
  const args = ['-p', '--model', model, '--system-prompt', SYSTEM_PROMPT, '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
  const cwd = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || os.homedir();
  return new Promise((resolve, reject) => {
    const child = execFile(claudeBinary(), args, { cwd, timeout: config().get('timeoutSeconds') * 1000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message).trim()));
      resolve(stdout.trim());
    });
    child.stdin.end(prompt);
  });
}

function promptSetup(message) {
  vscode.window
    .showWarningMessage(`Hover Explain: ${message}`, 'Set Up')
    .then((choice) => choice && vscode.commands.executeCommand('hoverExplain.chooseProvider'));
  return new Error(`${message} Run "Hover Explain: Choose Provider".`);
}

async function askOpenAICompatible(provider, model, prompt) {
  const url = baseUrl(provider);
  if (!url) throw promptSetup('no base URL set for the custom provider.');
  if (!model) throw promptSetup(`no model chosen for ${provider.label}.`);
  const headers = await authHeaders(provider);
  if (!provider.noKey && !headers.Authorization && provider.id !== 'custom') throw promptSetup(`no ${provider.label} API key set.`);

  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(config().get('timeoutSeconds') * 1000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${provider.label} ${res.status}: ${body.slice(0, 300)}`);
  const content = JSON.parse(body).choices?.[0]?.message?.content || '';
  // Reasoning models may inline their chain of thought; keep only the answer.
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '(empty response)';
}

function deactivate() {}

module.exports = { activate, deactivate };
