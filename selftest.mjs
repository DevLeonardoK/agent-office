#!/usr/bin/env node
// Exercita scene.mjs — o estado da cena, sem DOM — e confere a sintaxe do
// renderizador. Cobre os casos que quebram na prática: dois agentes no mesmo
// móvel, mais arquivos do que mesas, agente saindo, troca de sala.
//
//   node selftest.mjs

import { createScene, apply, hydrate, station, PLAN, DOOR, STATIONS } from './public/scene.mjs';
import { shape } from './shape.mjs';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// ── a porta do pai: o filho surge no cômodo de quem o convocou ────────────
{
  const s = createScene();
  // o principal convoca um subagente: caminha até a porta e fica lá.
  apply(s, evt({ kind: 'tool_start', tool: 'Task', prop: { kind: 'door', key: 'door', label: 'porta' } }));
  const pai = s.agents.get('main');

  const c = apply(s, evt({ kind: 'spawn', agentId: 'ag-1', agentType: 'Explore' }));
  const enter = cmdsOf(c, 'agent-enter')[0];
  ok('o filho entra pela porta do cômodo do pai', enter && Math.hypot(enter.x - pai.x, enter.y - pai.y) < 1,
     `enter=(${enter?.x},${enter?.y}) pai=(${pai.x},${pai.y})`);

  const move = cmdsOf(c, 'agent-move')[0];
  ok('e caminha dali até o próprio cômodo', move && (move.x !== enter.x || move.y !== enter.y),
     `move=(${move?.x},${move?.y})`);

  const filho = s.agents.get('ag-1');
  ok('o cômodo do filho não é o do pai', Math.hypot(filho.x - pai.x, filho.y - pai.y) > 24,
     `filho=(${filho.x},${filho.y})`);
  ok('nenhum móvel novo foi criado pela linhagem', s.props.size === 0);
}

// ── pai que já saiu não quebra a chegada do filho ─────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'tool_start', tool: 'Task', prop: { kind: 'door', key: 'door', label: 'porta' } }));
  apply(s, evt({ kind: 'stop', agentId: 'main' }));   // o pai vai embora antes do filho chegar
  const c = apply(s, evt({ kind: 'spawn', agentId: 'ag-1', agentType: 'Explore' }));
  const enter = cmdsOf(c, 'agent-enter')[0];
  ok('sem pai no prédio, o filho entra pela porta do prédio', enter && enter.x === DOOR.x && enter.y === DOOR.y,
     `enter=(${enter?.x},${enter?.y})`);
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
