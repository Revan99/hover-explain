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
let configItem;
let secrets;
let state;
const SETTING_DEFAULTS = { provider: 'nvidia', model: '', baseUrl: '', claudePath: '', timeoutSeconds: 60 };
// How long after the Cmd+hover definition lookup the hover request may come: the editor
// asks for a hover once the mouse has rested (editor.hover.delay, 300ms by default).
const ARM_WINDOW_MS = 4000;
let lastEditAt = 0;
let log;
/** The word of the latest definition lookup (Cmd+hover or background): { key, at } */
let armed;
/** The last hover the editor asked for: { key, at, ours } */
let lastHover;
/** Word whose hover is being reopened after Cmd was pressed on it */
let reopenedKey;
let internalLookups = 0;

function activate(context) {
  secrets = context.secrets;
  state = context.globalState;
  log = vscode.window.createOutputChannel('Hover Explain', { log: true });
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  configItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  configItem.command = 'hoverExplain.chooseProvider';
  updateConfigItem();
  context.subscriptions.push(
    log,
    statusItem,
    configItem,
    secrets.onDidChange(() => updateConfigItem()),
    vscode.workspace.onDidChangeConfiguration(onConfigChange),
    vscode.workspace.onDidChangeTextDocument(() => (lastEditAt = Date.now())),
    vscode.languages.registerHoverProvider({ scheme: '*' }, { provideHover }),
    vscode.languages.registerDefinitionProvider({ scheme: '*' }, { provideDefinition }),
    vscode.commands.registerCommand('hoverExplain.explain', explainCommand),
    vscode.commands.registerCommand('hoverExplain.clearCache', () => cache.clear()),
    vscode.commands.registerCommand('hoverExplain.chooseProvider', reportErrors(chooseProvider)),
    vscode.commands.registerCommand('hoverExplain.chooseModel', reportErrors(() => chooseModel())),
    vscode.commands.registerCommand('hoverExplain.setApiKey', reportErrors(() => setApiKey())),
  );
}

function config() {
  return vscode.workspace.getConfiguration('hoverExplain');
}

// Choices made in the setup commands are kept in globalState as well as in settings,
// because the editor can refuse settings writes (e.g. after an extension swap left
// the settings unregistered until a full restart). A setting edited by hand wins:
// onConfigChange drops the stored copy so the edited value is used.
function setting(key) {
  const stored = state.get(`setting.${key}`);
  if (stored !== undefined) return stored;
  const value = config().get(key);
  return value !== undefined ? value : SETTING_DEFAULTS[key];
}

async function saveSetting(key, value) {
  await state.update(`setting.${key}`, value === undefined ? SETTING_DEFAULTS[key] : value);
  try {
    await config().update(key, value, vscode.ConfigurationTarget.Global);
  } catch {
    // Kept in globalState; settings.json just won't show it.
  }
}

function onConfigChange(e) {
  if (!e.affectsConfiguration('hoverExplain')) return;
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (!e.affectsConfiguration(`hoverExplain.${key}`)) continue;
    // Ignore the echo of our own write; a different value means a hand edit.
    if (config().get(key) !== state.get(`setting.${key}`)) state.update(`setting.${key}`, undefined);
  }
  cache.clear();
  updateConfigItem();
}

function currentProvider() {
  return providerById(setting('provider'));
}

function providerById(id) {
  return { id, ...(PROVIDERS[id] || PROVIDERS.custom) };
}

// Command errors otherwise only reach the log, leaving a setup step that silently stops.
function reportErrors(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      vscode.window.showErrorMessage(`Hover Explain: ${err.message || err}`);
    }
  };
}

function currentModel(provider = currentProvider()) {
  return setting('model') || provider.model || '';
}

function baseUrl(provider) {
  return (setting('baseUrl') || provider.baseUrl || '').replace(/\/+$/, '');
}

function secretName(providerId) {
  return `hoverExplain.apiKey.${providerId}`;
}

async function getApiKey(providerId) {
  return (await secrets.get(secretName(providerId))) || (providerId === 'nvidia' ? await secrets.get(LEGACY_NVIDIA_KEY) : undefined);
}

// ---------- setup commands ----------

async function chooseProvider() {
  const current = setting('provider');
  const pick = await vscode.window.showQuickPick(
    Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, description: id === current ? 'current' : p.baseUrl || '' })),
    { title: 'Hover Explain: provider' },
  );
  if (!pick) return;
  const provider = providerById(pick.id);

  // Collect everything first and save at the end, so a cancelled step changes nothing.
  let url;
  if (pick.id === 'custom') {
    url = await vscode.window.showInputBox({
      title: 'Base URL of the OpenAI-compatible API',
      placeHolder: 'https://example.com/v1',
      value: setting('baseUrl'),
      ignoreFocusOut: true,
    });
    if (!url || !url.trim()) return;
    provider.baseUrl = url.trim();
  }
  if (!provider.cli && !provider.noKey) {
    // Always show the key step so it's clear where the key goes; empty keeps a saved one.
    // Custom APIs may not need a key at all.
    if (!(await setApiKey(provider, { keepIfEmpty: true })) && pick.id !== 'custom') return;
  }

  await saveSetting('provider', pick.id);
  await saveSetting('baseUrl', url ? url.trim() : undefined);
  // A model name from another provider would not work here.
  await saveSetting('model', undefined);
  await chooseModel(provider);
}

async function setApiKey(provider = currentProvider(), { keepIfEmpty = false } = {}) {
  if (provider.cli || provider.noKey) {
    vscode.window.showInformationMessage(
      provider.cli ? 'Claude Code uses its own login. Run `claude` in a terminal and use /login.' : `${provider.label} doesn't need an API key.`,
    );
    return false;
  }
  const saved = Boolean(await getApiKey(provider.id));
  const where = provider.keyUrl ? `Get one at ${provider.keyUrl}. ` : '';
  const key = await vscode.window.showInputBox({
    title: `Hover Explain: ${provider.label} API key${saved ? ' (one is saved)' : ''}`,
    prompt: where + (saved ? (keepIfEmpty ? 'Leave empty to keep the saved key.' : 'Leave empty to remove the saved key.') : 'Paste your key and press Enter.'),
    placeHolder: saved ? '••••••••  (saved)' : 'API key',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return false;
  if (!key.trim() && saved && keepIfEmpty) return true;
  if (key.trim()) await secrets.store(secretName(provider.id), key.trim());
  else await secrets.delete(secretName(provider.id));
  cache.clear();
  vscode.window.showInformationMessage(`Hover Explain: ${provider.label} API key ${key.trim() ? 'saved' : 'removed'}.`);
  return Boolean(key.trim());
}

async function chooseModel(provider = currentProvider()) {
  const current = currentModel(provider);
  const typeOwn = { label: '$(edit) Type a model id…', id: '' };
  const toItems = (ids) => [typeOwn, ...ids.map((id) => ({ label: id, id, description: id === current ? 'current' : '' }))];

  // Open the picker straight away and fill it once the provider's model list arrives.
  const qp = vscode.window.createQuickPick();
  qp.title = `Hover Explain: ${provider.label} model`;
  qp.placeholder = current ? `Current: ${current}. Search models` : 'Search models';
  qp.matchOnDescription = true;
  qp.ignoreFocusOut = true;
  qp.items = toItems(provider.cli ? CLAUDE_CODE_MODELS : []);
  qp.busy = !provider.cli;
  const picked = new Promise((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidHide(() => resolve(undefined));
  });
  qp.show();
  if (!provider.cli) {
    listModels(provider)
      .then((ids) => {
        qp.items = toItems(ids);
        if (current) qp.activeItems = qp.items.filter((i) => i.id === current);
      })
      .catch((err) => {
        qp.placeholder = `Couldn't list models (${err.message}). Choose "Type a model id…"`;
      })
      .finally(() => (qp.busy = false));
  }
  const pick = await picked;
  qp.dispose();
  if (!pick) return;
  let model = pick.id;
  if (pick === typeOwn) {
    model = await vscode.window.showInputBox({ title: 'Model id', value: current, ignoreFocusOut: true });
    if (!model) return;
  }
  await saveSetting('model', model.trim());
  updateConfigItem();
  vscode.window.showInformationMessage(`Hover Explain: using ${provider.label} · ${model.trim()}. Cmd/Ctrl+hover a symbol to try it.`);
}

// Status bar entry showing what explanations will use; click to change it.
async function updateConfigItem() {
  const provider = currentProvider();
  const model = currentModel(provider);
  const missingKey = !provider.cli && !provider.noKey && provider.id !== 'custom' && !(await getApiKey(provider.id));
  const ready = model && !missingKey;
  configItem.text = ready ? `$(sparkle) ${provider.label}` : '$(warning) Hover Explain: set up';
  configItem.tooltip = ready
    ? `Hover Explain: ${provider.label} · ${model}. Cmd/Ctrl+hover a symbol. Click to change.`
    : `Hover Explain needs ${missingKey ? `a ${provider.label} API key` : 'a model'}. Click to set up.`;
  configItem.show();
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
  if (!editor || editor.document !== doc) return;
  const range = doc.getWordRangeAtPosition(position);
  if (!range) return;
  const key = cacheKey(doc, range);

  // Arm the word. The explanation starts only when the editor also asks for a hover on
  // it (provideHover): definitions are looked up in the background too (the editor's AI
  // features, other extensions), but only the word under the mouse gets a hover request.
  armed = { key, at: Date.now() };
  log.trace(`definition lookup ${describe(doc, range)}`);

  // Cmd pressed while already resting on the word: the editor finished that hover
  // without us and only asks again on mouse movement, so ask for a new one.
  if (lastHover && lastHover.key === key && !lastHover.ours && Date.now() - lastEditAt > 1500) {
    log.info(`Cmd pressed on hovered ${describe(doc, range)}: reopening the hover`);
    // A reopened hover shows nothing new until every provider has answered (no
    // "Loading…" line, unlike one opened by the mouse), so answer it at once with a
    // "thinking" line and reopen it again when the answer is in.
    reopenedKey = key;
    reshowHover(editor, range.start);
  }
}

function describe(doc, range) {
  return `"${doc.getText(range)}" (${relPath(doc.uri)}:${range.start.line + 1}:${range.start.character + 1})`;
}

// The editor only lets extensions open a hover at the (primary) text cursor, and reads it
// synchronously when the command runs. Add a primary cursor on the word, keeping the
// user's cursors as secondary ones so they never leave their place, run the command and
// restore without waiting in between: the three messages reach the editor in order, so
// the extra cursor exists only for that instant. An open hover stays where it is
// anchored when the cursors change.
function reshowHover(editor, position) {
  const saved = editor.selections;
  editor.selections = [new vscode.Selection(position, position), ...saved];
  const shown = vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
  editor.selections = saved;
  shown.then(undefined, (err) => log.warn(`couldn't reopen the hover: ${err.message || err}`));
}

async function provideHover(doc, position, token) {
  const range = doc.getWordRangeAtPosition(position);
  // Any hover request means the mouse rests there now, word or not.
  if (!range) {
    lastHover = { key: undefined, at: Date.now(), ours: false };
    return;
  }
  const key = cacheKey(doc, range);
  let entry = cache.get(key);
  if ((!entry || entry.status === 'error') && armed && armed.key === key && Date.now() - armed.at < ARM_WINDOW_MS) {
    log.info(`Cmd+hover on ${describe(doc, range)}`);
    explainAt(doc, range);
    entry = cache.get(key);
  }
  lastHover = { key, at: Date.now(), ours: Boolean(entry) };
  if (!entry) return;

  if (entry.status === 'pending' && reopenedKey === key) {
    reopenedKey = undefined;
    entry.reopenWhenDone = true;
    return thinkingHover(entry, range);
  }
  // Opened by the mouse: the editor shows the other providers' content and a "Loading…"
  // line meanwhile, and adds ours when this resolves.
  if (entry.status === 'pending') await entry.promise;
  if (token.isCancellationRequested) {
    log.info(`hover for ${describe(doc, range)} was closed before the answer arrived`);
    return;
  }
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`$(sparkle) **${entry.label}**${entry.status === 'error' ? ' (error)' : ''}\n\n`);
  md.appendMarkdown(entry.text);
  return new vscode.Hover(md, range);
}

function thinkingHover(entry, range) {
  const md = new vscode.MarkdownString();
  md.supportThemeIcons = true;
  md.appendMarkdown(`$(loading~spin) **${entry.label}** is thinking…`);
  return new vscode.Hover(md, range);
}

// After a "thinking" hover: reopen it with the answer, but only if the mouse is still on
// the word (no hover asked for anywhere else since) and the user isn't typing.
function reopenWithAnswer(doc, range, key) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== doc || !lastHover || lastHover.key !== key || Date.now() - lastEditAt < 1500) {
    log.info(`answer for ${describe(doc, range)} ready; mouse moved on, not reopening`);
    return;
  }
  // The editor ignores a reopen anchored where the open hover already is; the first
  // reopen used the word's start, so anchor this one at its end (still the same word).
  reshowHover(editor, range.end);
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
  explainAt(doc, range);
  await vscode.commands.executeCommand('editor.action.showHover', { focus: 'noAutoFocus' });
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
    const started = Date.now();
    try {
      const prompt = await buildPrompt(doc, range);
      log.info(`asking ${entry.label} about ${describe(doc, range)} (context gathered in ${Date.now() - started}ms)`);
      entry.text = provider.cli ? await askClaudeCode(prompt, model) : await askOpenAICompatible(provider, model, prompt);
      entry.status = 'done';
      log.info(`answer for ${describe(doc, range)} after ${Date.now() - started}ms`);
    } catch (err) {
      entry.text = String(err.message || err);
      entry.status = 'error';
      log.error(`request for ${describe(doc, range)} failed after ${Date.now() - started}ms: ${entry.text}`);
      if (provider.cli && /auth|login|OAuth/i.test(entry.text)) {
        vscode.window.showWarningMessage('Hover Explain: Claude Code is not logged in. Run `claude` in a terminal and use /login.');
      }
    } finally {
      statusItem.hide();
      if (entry.reopenWhenDone) reopenWithAnswer(doc, range, key);
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
  const configured = setting('claudePath');
  if (configured) return configured;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

function askClaudeCode(prompt, model) {
  const args = ['-p', '--model', model, '--system-prompt', SYSTEM_PROMPT, '--tools', '', '--strict-mcp-config', '--no-session-persistence'];
  const cwd = (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri.fsPath) || os.homedir();
  return new Promise((resolve, reject) => {
    const child = execFile(claudeBinary(), args, { cwd, timeout: setting('timeoutSeconds') * 1000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
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
    signal: AbortSignal.timeout(setting('timeoutSeconds') * 1000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${provider.label} ${res.status}: ${body.slice(0, 300)}`);
  const content = JSON.parse(body).choices?.[0]?.message?.content || '';
  // Reasoning models may inline their chain of thought; keep only the answer.
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '(empty response)';
}

function deactivate() {}

module.exports = { activate, deactivate };
