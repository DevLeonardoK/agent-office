#!/usr/bin/env node
// Instala os hooks do escritório no settings.json global do Claude Code.
//
//   node install-hooks.mjs
//
// Os hooks são do tipo `http` — o servidor responde 204 e o custo por
// ferramenta fica em ~3,5 ms, contra ~219 ms do tipo `command` (arranque do
// Node) a cada ferramenta usada. A exceção é o SessionStart, que roda um
// `command` para subir o servidor de forma idempotente (ensure-server.mjs).
//
// Antes de escrever, o arquivo atual vai para settings.json.antes-do-escritorio
// — uma vez só, sem clobrar um backup pré-existente. O merge é idempotente:
// reinstalar não duplica os nossos hooks nem apaga os de terceiros.

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENT_OFFICE_PORT || 4517);

// Os eventos que a cena sabe desenhar (ver shape.mjs). PreCompact e afins
// ficam de fora porque o shape os descarta — mandar seria só ruído no /hook.
export const HTTP_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
  'Notification',
];

// Só os eventos de ferramenta peneiram por matcher; os de sessão/turno não.
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

/**
 * Devolve o settings.json já com os hooks do escritório, sem tocar em DOM nem
 * no disco — puro, para o selftest exercitar em Node.
 */
export function buildSettings(existing = {}, opts = {}) {
  const port = opts.port || PORT;
  const url = opts.url || `http://127.0.0.1:${port}/hook`;
  const ensure =
    opts.ensureCmd || `node ${path.join(opts.repoDir || HERE, 'ensure-server.mjs')}`;

  const settings = { ...existing };
  const hooks = { ...(existing.hooks || {}) };

  const isOurHttp = (g) =>
    Array.isArray(g.hooks) && g.hooks.some((x) => x.type === 'http' && x.url === url);
  const isOurEnsure = (g) =>
    Array.isArray(g.hooks) &&
    g.hooks.some((x) => x.type === 'command' && String(x.command).includes('ensure-server.mjs'));

  for (const event of HTTP_EVENTS) {
    const kept = (hooks[event] || []).filter((g) => !isOurHttp(g));
    const group = TOOL_EVENTS.has(event)
      ? { matcher: '*', hooks: [{ type: 'http', url }] }
      : { hooks: [{ type: 'http', url }] };
    kept.push(group);
    hooks[event] = kept;
  }

  // SessionStart sobe o servidor; é command, não http.
  const startKept = (hooks.SessionStart || []).filter((g) => !isOurEnsure(g) && !isOurHttp(g));
  startKept.push({ hooks: [{ type: 'command', command: ensure }] });
  hooks.SessionStart = startKept;

  settings.hooks = hooks;
  return settings;
}

function settingsPath() {
  return process.env.AGENT_OFFICE_SETTINGS || path.join(os.homedir(), '.claude', 'settings.json');
}

function install() {
  const p = settingsPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let existing = {};
  if (existsSync(p)) {
    try {
      existing = JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      existing = {};
    }
    // Backup uma vez só: preserva o estado pré-escritório mesmo em reinstalação.
    const backup = path.join(dir, 'settings.json.antes-do-escritorio');
    if (!existsSync(backup)) {
      copyFileSync(p, backup);
      console.log(`  backup em ${backup}`);
    }
  }

  const next = buildSettings(existing);
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n');
  console.log(`  hooks instalados em ${p}`);
  console.log(`  http → ${HTTP_EVENTS.join(', ')}`);
  console.log(`  command → SessionStart (ensure-server.mjs)`);
}

// Só instala quando chamado direto; importar (selftest) não escreve nada.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install();
}
