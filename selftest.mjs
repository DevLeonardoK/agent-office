#!/usr/bin/env node
// Exercita scene.mjs — o estado da cena, sem DOM — e confere a sintaxe do
// renderizador.
//
// Com o relayout contínuo do modelo de andares e cômodos (issue #4), nenhuma
// coordenada é estável entre eventos. Por isso as asserções são invariantes de
// layout: propriedades que valem sempre, não posições fixas.
//
//   node selftest.mjs

import {
  createScene, apply, hydrate, roomRect, ROOMS_PER_FLOOR, FLOOR, GROUND,
  PLAN, DOOR, STATIONS,
} from './public/scene.mjs';
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

// ── invariantes de layout ──────────────────────────────────────────────────

function insideRoom(x, y, i) {
  const r = roomRect(i);
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Devolve a lista de invariantes violadas na cena. Vazia = tudo em ordem. */
function violations(s) {
  const bad = [];
  const agents = [...s.agents.values()];

  // No máximo um ocupante por cômodo; nenhum andar excede cinco agentes.
  const byRoom = new Map();
  for (const a of agents) {
    if (byRoom.has(a.room)) bad.push(`cômodo ${a.room} com dois ocupantes`);
    byRoom.set(a.room, a);
    if (a.room < 0 || a.room >= ROOMS_PER_FLOOR) bad.push(`agente ${a.id} fora dos cômodos`);
  }
  if (agents.length > ROOMS_PER_FLOOR) bad.push(`andar com ${agents.length} agentes`);

  // Todo robô dentro do seu cômodo.
  for (const a of agents) {
    if (!insideRoom(a.x, a.y, a.room)) bad.push(`robô ${a.id} fora do cômodo ${a.room}`);
  }

  // Nenhum robô se sobrepõe a outro.
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      if (Math.hypot(agents[i].x - agents[j].x, agents[i].y - agents[j].y) < 24) {
        bad.push(`robôs ${agents[i].id} e ${agents[j].id} sobrepostos`);
      }
    }
  }

  // Todo móvel de cômodo dentro do cômodo do dono; toda estação no térreo.
  for (const p of s.props.values()) {
    if (p.fixed) {
      if (p.y < GROUND.y) bad.push(`estação ${p.key} fora do térreo`);
    } else {
      const owner = s.agents.get(p.owner);
      if (!owner) continue;   // dono já saiu; o móvel some com ele no render
      if (!insideRoom(p.x, p.y, owner.room)) bad.push(`móvel ${p.key} fora do cômodo do dono`);
    }
  }
  return bad;
}

const invariantsHold = (s) => { const v = violations(s); return { ok: !v.length, detail: v.join('; ') }; };

// ── um agente chega e vai trabalhar num arquivo do cômodo ───────────────────
{
  const s = createScene();
  const c1 = apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  ok('spawn monta o agente', cmdsOf(c1, 'agent-enter').length === 1);
  ok('agente ganha um cômodo', s.agents.get('a1').room != null);

  const c2 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('auth.ts') }));
  ok('tool_start cria o móvel', cmdsOf(c2, 'prop-add').length === 1);
  ok('tool_start acende o móvel', cmdsOf(c2, 'prop-hit').length === 1);

  const a = s.agents.get('a1');
  const p = s.props.get('a1|file:auth.ts');
  ok('móvel nasce no cômodo do dono', p && p.owner === 'a1' && insideRoom(p.x, p.y, a.room));
  ok('status vira trabalhando', a.status === 'working' && a.tool === 'Read');
  { const v = invariantsHold(s); ok('invariantes valem com um agente', v.ok, v.detail); }

  apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', tool: 'Read' }));
  ok('tool_end solta o móvel', s.agents.get('a1').propKey === null);
}

// ── dois agentes no mesmo arquivo produzem dois móveis ──────────────────────
{
  const s = createScene();
  const prop = deskProp('shared.ts');
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop }));

  const a1 = s.agents.get('a1');
  const a2 = s.agents.get('a2');
  ok('mesmo arquivo, dois móveis', s.props.size === 2);
  ok('cada móvel no cômodo do seu dono',
     insideRoom(s.props.get('a1|file:shared.ts').x, s.props.get('a1|file:shared.ts').y, a1.room) &&
     insideRoom(s.props.get('a2|file:shared.ts').x, s.props.get('a2|file:shared.ts').y, a2.room));
  ok('os dois estão em cômodos diferentes', a1.room !== a2.room);
  { const v = invariantsHold(s); ok('invariantes valem com dois agentes', v.ok, v.detail); }
}

// ── cinco agentes enchem o andar, um por cômodo ─────────────────────────────
{
  const s = createScene();
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) {
    apply(s, evt({ kind: 'spawn', agentId: 'ag' + i, agentType: 'sub' + i }));
    apply(s, evt({ kind: 'tool_start', agentId: 'ag' + i, agentType: 'sub' + i, tool: 'Read', prop: deskProp('f' + i + '.ts') }));
  }
  const rooms = new Set([...s.agents.values()].map((a) => a.room));
  ok('cinco agentes ocupam cinco cômodos', rooms.size === ROOMS_PER_FLOOR);
  ok('a plaqueta carrega o agent_type', [...s.agents.values()].every((a) => a.type && a.room != null));
  { const v = invariantsHold(s); ok('invariantes valem com o andar cheio', v.ok, v.detail); }
}

// ── mais móveis do que cabem confortavelmente num cômodo ────────────────────
{
  const s = createScene();
  for (let i = 0; i < 40; i++) {
    apply(s, evt({ kind: 'tool_start', tool: 'Read', prop: deskProp('m' + i + '.ts') }));
  }
  ok('todo arquivo vira móvel', s.props.size === 40);
  const main = s.agents.get('main');
  const fora = [...s.props.values()].filter((p) => !insideRoom(p.x, p.y, main.room));
  ok('nenhum móvel escapa do cômodo', fora.length === 0, `${fora.length} fora`);
  { const v = invariantsHold(s); ok('invariantes valem com o cômodo lotado', v.ok, v.detail); }
}

// ── estações são singulares e moram no térreo ───────────────────────────────
{
  const s = createScene();
  for (const [kind, st] of Object.entries(STATIONS)) {
    apply(s, evt({ kind: 'tool_start', tool: 'X', prop: { kind, key: kind, label: kind } }));
    const p = s.props.get(kind);
    ok(`${kind} ancora em ${st.label}`, p.x === st.x && p.y === st.y && p.fixed);
    ok(`${kind} está no térreo`, p.y >= GROUND.y);
  }
  // Dois agentes usando o terminal compartilham a mesma estação global.
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  ok('terminal não duplica entre agentes', s.props.get('terminal').uses === 2);
  { const v = invariantsHold(s); ok('invariantes valem com estações em uso', v.ok, v.detail); }
}

// ── saída libera o cômodo, que é reciclado ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const room1 = s.agents.get('a1').room;
  const c = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'achei 4 handlers' }));
  ok('sai andando até a porta', cmdsOf(c, 'agent-move').some((m) => m.x === DOOR.x));
  ok('fala antes de sumir', cmdsOf(c, 'say').length === 1);
  ok('some do elenco', !s.agents.has('a1'));

  apply(s, evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }));
  ok('o próximo recicla a vaga', s.agents.get('a2').room === room1);
}

// ── troca de sessão reconstrói os cômodos ───────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'tool_start', tool: 'Read', prop: deskProp('velho.ts') }));
  const c = hydrate(s, {
    props: [{ kind: 'desk', key: 'file:novo.ts', label: 'novo.ts' }, { kind: 'terminal', key: 'terminal', label: 'terminal' }],
    agents: [
      { id: 'main', type: 'main', status: 'working', tool: 'Bash', prop: 'terminal', toolCount: 3 },
      { id: 'a1', type: 'Explore', status: 'working', tool: 'Read', prop: 'file:novo.ts', toolCount: 1 },
    ],
  });
  ok('sala antiga é esvaziada', !s.props.has('main|file:velho.ts'));
  ok('a sessão nova é montada', s.agents.size === 2);
  ok('o agente é recolocado sem "chegar"', cmdsOf(c, 'agent-enter').every((e) => e.instant === true));
  const a1 = s.agents.get('a1');
  ok('o móvel renasce no cômodo do dono', insideRoom(s.props.get('a1|file:novo.ts').x, s.props.get('a1|file:novo.ts').y, a1.room));
  { const v = invariantsHold(s); ok('invariantes valem após a troca', v.ok, v.detail); }
}

// ── o cômodo do principal fica no 1º andar ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', text: 'oi' }));
  const main = s.agents.get('main');
  ok('o principal ocupa um cômodo do 1º andar', main.room >= 0 && main.room < ROOMS_PER_FLOOR && insideRoom(main.x, main.y, main.room));
}

// ── entrada estranha não derruba ──────────────────────────────────────────
{
  const s = createScene();
  ok('evento sem tipo é ignorado', apply(s, evt({ kind: 'coisa-nova' })).length === 0);
  ok('tool_start sem prop se vira', apply(s, evt({ kind: 'tool_start', tool: 'Esquisito' })).length > 0);
  ok('shape descarta hook irrelevante', shape({ hook_event_name: 'PreCompact' }) === null);
  ok('shape aceita hook sem agente', shape({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }).agentId === 'main');
  ok('shape traduz SubagentStart', shape({ hook_event_name: 'SubagentStart', agent_id: 'x', agent_type: 'Explore' }).kind === 'spawn');
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

// PLAN mantido no import para o renderizador; referência silencia o linter.
void PLAN;
void FLOOR;
