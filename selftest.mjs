#!/usr/bin/env node
// Exercita scene.mjs — o estado da cena, sem DOM — e confere a sintaxe do
// renderizador. Cobre os casos que quebram na prática: dois agentes no mesmo
// móvel, mais arquivos do que mesas, agente saindo, troca de sala.
//
//   node selftest.mjs

import { createScene, apply, hydrate, station, PLAN, DOOR, STATIONS } from './public/scene.mjs';
import { shape } from './shape.mjs';
import { appendEvent, logPathFor } from './logstore.mjs';
import { writeFileSync, unlinkSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const fails = [];

function ok(label, cond, detail) {
  if (cond) { pass++; return; }
  fails.push(label + (detail ? `\n     ${detail}` : ''));
}

const cmdsOf = (list, op) => list.filter((c) => c.op === op);
const evt = (o) => ({ at: Date.now(), session: 's', agentId: 'main', agentType: 'main', ...o });
const deskProp = (name) => ({ kind: 'desk', key: 'file:' + name, label: name });

// ── um agente chega e vai trabalhar ───────────────────────────────────────
{
  const s = createScene();
  const c1 = apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  ok('spawn monta o agente', cmdsOf(c1, 'agent-enter').length === 1);
  ok('spawn manda ele para o corredor', cmdsOf(c1, 'agent-move').length === 1);

  const c2 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('auth.ts') }));
  ok('tool_start cria o móvel', cmdsOf(c2, 'prop-add').length === 1);
  ok('tool_start acende o móvel', cmdsOf(c2, 'prop-hit').length === 1);

  const a = s.agents.get('a1');
  const p = s.props.get('file:auth.ts');
  // Perto o bastante para ler como "usando o móvel", longe o bastante para não
  // cobrir o rótulo dele.
  const d = Math.hypot(a.x - p.x, a.y - p.y);
  ok('o agente encosta no móvel', d > 55 && d < 115, `distância ${d.toFixed(0)}`);
  ok('status vira trabalhando', a.status === 'working' && a.tool === 'Read');

  apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', tool: 'Read' }));
  ok('tool_end solta o móvel', s.agents.get('a1').propKey === null);
}

// ── dois agentes disputando a mesma mesa ──────────────────────────────────
{
  const s = createScene();
  const prop = deskProp('shared.ts');
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop }));

  const a1 = s.agents.get('a1');
  const a2 = s.agents.get('a2');
  ok('mesma mesa, um móvel só', s.props.size === 1);
  ok('os dois não se sobrepõem', Math.hypot(a1.x - a2.x, a1.y - a2.y) > 24,
     `a1=(${a1.x},${a1.y}) a2=(${a2.x},${a2.y})`);
}

// ── mais arquivos do que mesas ────────────────────────────────────────────
{
  const s = createScene();
  for (let i = 0; i < 40; i++) {
    apply(s, evt({ kind: 'tool_start', tool: 'Read', prop: deskProp('m' + i + '.ts') }));
  }
  ok('todo arquivo vira móvel', s.props.size === 40);
  const fora = [...s.props.values()].filter((p) => p.x < 0 || p.x > PLAN.w || p.y < 0 || p.y > PLAN.h);
  ok('nenhum móvel sai da planta', fora.length === 0, `${fora.length} fora`);
}

// ── recursos singulares vão para a estação certa ──────────────────────────
{
  const s = createScene();
  for (const [kind, st] of Object.entries(STATIONS)) {
    apply(s, evt({ kind: 'tool_start', tool: 'X', prop: { kind, key: kind, label: kind } }));
    const p = s.props.get(kind);
    ok(`${kind} ancora em ${st.label}`, p.x === st.x && p.y === st.y);
  }
  apply(s, evt({ kind: 'tool_start', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  ok('terminal não duplica', s.props.get('terminal').uses === 2);
}

// ── saída ─────────────────────────────────────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const c = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'achei 4 handlers' }));
  ok('sai andando até a porta', cmdsOf(c, 'agent-move').some((m) => m.x === DOOR.x));
  ok('fala antes de sumir', cmdsOf(c, 'say').length === 1);
  ok('some do elenco', !s.agents.has('a1'));
}

// ── troca de sala ─────────────────────────────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'tool_start', tool: 'Read', prop: deskProp('velho.ts') }));
  const c = hydrate(s, {
    props: [{ kind: 'desk', key: 'file:novo.ts', label: 'novo.ts' }, { kind: 'terminal', key: 'terminal', label: 'terminal' }],
    agents: [{ id: 'main', type: 'main', status: 'working', tool: 'Bash', prop: 'terminal', toolCount: 3 }],
  });
  ok('sala antiga é esvaziada', !s.props.has('file:velho.ts'));
  ok('sala nova é montada', s.props.size === 2 && s.agents.size === 1);
  ok('o agente é recolocado no móvel', cmdsOf(c, 'agent-enter')[0].instant === true);
  const m = s.agents.get('main');
  const t = s.props.get('terminal');
  ok('recolocado junto do terminal', Math.hypot(m.x - t.x, m.y - t.y) < 115);
}

// ── entrada estranha não derruba ──────────────────────────────────────────
{
  const s = createScene();
  ok('evento sem tipo é ignorado', apply(s, evt({ kind: 'coisa-nova' })).length === 0);
  ok('tool_start sem prop se vira', apply(s, evt({ kind: 'tool_start', tool: 'Esquisito' })).length > 0);
  ok('shape descarta hook irrelevante', shape({ hook_event_name: 'PreCompact' }) === null);
  ok('shape aceita hook sem agente', shape({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }).agentId === 'main');
}

// ── o log reconstrói o prédio idêntico ao vivo ────────────────────────────
{
  // Assinatura do prédio: só o que a cena desenha agora — posição, estado e
  // móveis. Fora ficam os carimbos de tempo, que mudam a cada execução.
  const building = (scene) => JSON.stringify({
    agents: [...scene.agents.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((a) => [a.id, a.type, a.status, a.tool, a.propKey, Math.round(a.x), Math.round(a.y), a.hueIndex, a.face]),
    props: [...scene.props.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((p) => [p.key, p.kind, Math.round(p.x), Math.round(p.y), p.room, p.uses]),
  });

  // Uma sessão como a que o simulate.mjs encena: hooks crus traduzidos em eventos.
  const SESSION = 'sim-log';
  const hooks = [
    { hook_event_name: 'UserPromptSubmit', session_id: SESSION, user_input: 'Refatore a autenticação' },
    { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Read', tool_input: { file_path: '/p/auth.ts' } },
    { hook_event_name: 'PostToolUse', session_id: SESSION, tool_name: 'Read' },
    { hook_event_name: 'SubagentStart', session_id: SESSION, agent_id: 'ag-1', agent_type: 'Explore' },
    { hook_event_name: 'PreToolUse', session_id: SESSION, agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'auth\\(' } },
    { hook_event_name: 'PreToolUse', session_id: SESSION, agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { hook_event_name: 'PostToolUse', session_id: SESSION, agent_id: 'ag-1', agent_type: 'Explore', tool_name: 'Bash' },
    { hook_event_name: 'SubagentStop', session_id: SESSION, agent_id: 'ag-1', agent_type: 'Explore', last_assistant_message: 'achei 4 handlers' },
    { hook_event_name: 'PreToolUse', session_id: SESSION, tool_name: 'Edit', tool_input: { file_path: '/p/auth.ts' } },
    { hook_event_name: 'Stop', session_id: SESSION, last_assistant_message: 'pronto' },
  ];
  const events = hooks.map(shape).filter(Boolean);

  // Ao vivo: os eventos chegam e o prédio se ergue.
  const live = createScene();
  for (const ev of events) apply(live, ev);

  // Em disco: cada evento vira uma linha do `.jsonl` da sessão.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'office-log-'));
  try {
    for (const ev of events) appendEvent(ev, dir);

    const file = logPathFor(SESSION, dir);
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    ok('grava uma linha por evento', lines.length === events.length, `${lines.length} linhas para ${events.length} eventos`);

    // Reaplicar o log numa cena limpa reconstrói o mesmo prédio.
    const rebuilt = createScene();
    for (const line of lines) apply(rebuilt, JSON.parse(line));
    ok('replay do log reconstrói o prédio idêntico', building(rebuilt) === building(live),
       `vivo=${building(live)}\n     log =${building(rebuilt)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── o renderizador ao menos analisa ───────────────────────────────────────
{
  // fileURLToPath e não `pathname`: no Windows o pathname vem como `/C:/...` e
  // precisa perder a barra, no Linux perder a barra quebra o caminho.
  const path = fileURLToPath(new URL('./.__office_check.mjs', import.meta.url));
  try {
    writeFileSync(path, readFileSync(new URL('./public/office.js', import.meta.url), 'utf8'));
    execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    ok('office.js analisa como módulo', true);
  } catch (e) {
    ok('office.js analisa como módulo', false, String(e.stderr || e.message).split('\n').slice(0, 3).join('\n     '));
  } finally {
    try { unlinkSync(path); } catch {}
  }
}

// ── resultado ─────────────────────────────────────────────────────────────
console.log();
if (fails.length) {
  for (const f of fails) console.log('  ✖ ' + f);
  console.log(`\n  ${pass} passaram, ${fails.length} falharam\n`);
  process.exit(1);
}
console.log(`  ✔ ${pass} verificações passaram\n`);
