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
  createScene, apply, rebuild, roomRect, roomQuad, ROOMS_PER_FLOOR,
  DOOR, STATIONS, MAIN_ROOM, floorCount, floorRect, buildingRect, PLAN,
  SHAFT, shaftRect, cabinRect, cabinStand, iso, PLATE, GROUND_FLOOR, GROUND_PLATE,
} from './public/scene.mjs';
import { shape } from './shape.mjs';
import { appendEvent, logPathFor } from './logstore.mjs';
import { SESSION_TTL, openSession, isDead, liveSessions } from './sessions.mjs';
import { buildSettings, HTTP_EVENTS } from './install-hooks.mjs';
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

// ── invariantes de layout ──────────────────────────────────────────────────

// O cômodo é um losango, não um retângulo: ponto-dentro-de-polígono, com uma
// folga para o robô que encosta na beirada do piso.
function insideRoom(x, y, i, pad = 26) {
  const q = roomQuad(i);
  let inside = false;
  for (let a = 0, b = q.length - 1; a < q.length; b = a++) {
    const hit = (q[a].y > y) !== (q[b].y > y) &&
      x < ((q[b].x - q[a].x) * (y - q[a].y)) / (q[b].y - q[a].y) + q[a].x;
    if (hit) inside = !inside;
  }
  if (inside) return true;
  // Beirada: aceita o que está a menos de `pad` do losango.
  const cx = q.reduce((t, p) => t + p.x, 0) / 4;
  const cy = q.reduce((t, p) => t + p.y, 0) / 4;
  const shrunk = q.map((p) => ({ x: p.x + Math.sign(cx - p.x) * -pad, y: p.y + Math.sign(cy - p.y) * -pad }));
  let grown = false;
  for (let a = 0, b = shrunk.length - 1; a < shrunk.length; b = a++) {
    const hit = (shrunk[a].y > y) !== (shrunk[b].y > y) &&
      x < ((shrunk[b].x - shrunk[a].x) * (y - shrunk[a].y)) / (shrunk[b].y - shrunk[a].y) + shrunk[a].x;
    if (hit) grown = !grown;
  }
  return grown;
}

// A caixa do térreo de serviço, onde os robôs ficam quando descem às estações.
const groundBox = floorRect(GROUND_FLOOR);
const onGround = (x, y) =>
  x >= groundBox.x - 40 && x <= groundBox.x + groundBox.w + 40 &&
  y >= groundBox.y && y <= groundBox.y + groundBox.h + 40;

/** Devolve a lista de invariantes violadas na cena. Vazia = tudo em ordem. */
function violations(s) {
  const bad = [];
  const agents = [...s.agents.values()];

  // No máximo um ocupante por cômodo; todo cômodo tem endereço inteiro válido.
  const byRoom = new Map();
  for (const a of agents) {
    if (byRoom.has(a.room)) bad.push(`cômodo ${a.room} com dois ocupantes`);
    byRoom.set(a.room, a);
    if (a.room == null || a.room < 0 || !Number.isInteger(a.room)) bad.push(`agente ${a.id} sem cômodo válido`);
  }

  // Nenhum andar excede cinco agentes; nenhum andar vazio existe entre o térreo
  // e o topo (o prédio cresce e encolhe sem deixar andar oco no meio).
  const perFloor = new Map();
  for (const a of agents) {
    const f = Math.floor(a.room / ROOMS_PER_FLOOR);
    perFloor.set(f, (perFloor.get(f) || 0) + 1);
  }
  for (const [f, n] of perFloor) if (n > ROOMS_PER_FLOOR) bad.push(`andar ${f} com ${n} agentes`);
  if (perFloor.size) {
    const maxF = Math.max(...perFloor.keys());
    for (let f = 0; f <= maxF; f++) if (!perFloor.has(f)) bad.push(`andar ${f} vazio abaixo do topo`);
  }

  // Todo robô está no seu cômodo — ou no térreo, quando desce para usar uma
  // estação (issue #9). Nunca num terceiro lugar.
  for (const a of agents) {
    const atGround = onGround(a.x, a.y);
    const placed = a.away ? atGround : insideRoom(a.x, a.y, a.room);
    if (!placed) bad.push(`robô ${a.id} nem no cômodo ${a.room} nem no térreo`);
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
      if (!onGround(p.x, p.y)) bad.push(`estação ${p.key} fora do térreo`);
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
  ok('tool_end sem falha volta a ocioso', s.agents.get('a1').status === 'idle');
}

// ── falha de ferramenta acende o rosto de erro do robô ────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('quebra.ts') }));
  const c = apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', tool: 'Read', failed: true }));
  ok('falha marca o robô com erro', s.agents.get('a1').status === 'error');
  ok('a falha emite estado para o rosto', cmdsOf(c, 'agent-state').length === 1);

  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('ok.ts') }));
  ok('a ação seguinte limpa o erro', s.agents.get('a1').status === 'working');
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
    ok(`${kind} está no térreo`, onGround(p.x, p.y));
  }
  // Dois agentes usando o terminal compartilham a mesma estação global.
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  ok('terminal não duplica entre agentes', s.props.get('terminal').uses === 2);
  { const v = invariantsHold(s); ok('invariantes valem com estações em uso', v.ok, v.detail); }
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

// ── reconstrução a partir do log (recarregar / trocar de sessão) ──────────
{
  const events = [
    evt({ kind: 'tool_start', agentId: 'main', agentType: 'main', tool: 'Read', prop: deskProp('velho.ts') }),
    evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }),
    evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }),
  ];
  const s = createScene();
  const c = rebuild(s, events);
  ok('rebuild monta os móveis do log', s.props.size === 2);
  ok('rebuild monta os agentes do log', s.agents.size === 2);
  ok('rebuild entra instantâneo', cmdsOf(c, 'agent-enter').every((e) => e.instant === true));
  ok('rebuild não anima o movimento', cmdsOf(c, 'agent-move').every((m) => m.instant === true));
}


// ── o cômodo do principal fica no 1º andar ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', text: 'oi' }));
  const main = s.agents.get('main');
  ok('o principal ocupa um cômodo do 1º andar', main.room >= 0 && main.room < ROOMS_PER_FLOOR && insideRoom(main.x, main.y, main.room));
}

// ── o sexto agente inaugura o 2º andar (issue #7) ───────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));

  ok('seis agentes cabem no prédio', s.agents.size === 6);
  ok('o 1º andar ainda tem exatamente cinco', [...s.agents.values()].filter((a) => Math.floor(a.room / ROOMS_PER_FLOOR) === 0).length === ROOMS_PER_FLOOR);
  ok('o sexto abre o 2º andar', floorCount(s) === 2 && [...s.agents.values()].some((a) => Math.floor(a.room / ROOMS_PER_FLOOR) === 1));
  { const v = invariantsHold(s); ok('invariantes valem com dois andares', v.ok, v.detail); }
}

// ── o cômodo é esvaziado dos móveis do ocupante anterior (issue #7) ──────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const c1 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('velho.ts') }));
  ok('o móvel do primeiro nasce', s.props.has('a1|file:velho.ts') && cmdsOf(c1, 'prop-add').length === 1);
  const room1 = s.agents.get('a1').room;

  const c2 = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'saí' }));
  ok('a saída remove o móvel do ocupante', !s.props.has('a1|file:velho.ts') && cmdsOf(c2, 'prop-remove').length === 1);

  apply(s, evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop: deskProp('novo.ts') }));
  ok('o próximo recicla a vaga já vazia', s.agents.get('a2').room === room1);
  ok('nenhuma mobília do anterior sobra no cômodo', ![...s.props.values()].some((p) => p.owner === 'a1'));
  { const v = invariantsHold(s); ok('invariantes valem após reciclar a vaga', v.ok, v.detail); }
}

// ── andar sem ocupantes é demolido (issue #7) ───────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));
  ok('o prédio tem dois andares com seis agentes', floorCount(s) === 2);

  // Some o único ocupante do 2º andar; o andar deixa de existir.
  const upstairs = [...s.agents.values()].find((a) => Math.floor(a.room / ROOMS_PER_FLOOR) === 1);
  apply(s, evt({ kind: 'stop', agentId: upstairs.id, agentType: upstairs.type, text: 'saí' }));
  ok('o 2º andar é demolido ao esvaziar', floorCount(s) === 1);
  ok('ninguém sobra acima do 1º andar', ![...s.agents.values()].some((a) => a.room >= ROOMS_PER_FLOOR));
  { const v = invariantsHold(s); ok('invariantes valem após demolir o andar', v.ok, v.detail); }
}

// ── o endereço do cômodo do principal não muda a sessão inteira (issue #7) ───
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  const addr = s.agents.get('main').room;
  ok('o principal nasce no cômodo reservado', addr === MAIN_ROOM);

  // Enche o prédio, abre e demole o 2º andar, tudo em volta do principal.
  for (let i = 0; i < ROOMS_PER_FLOOR + 1; i++) apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));
  for (let i = 0; i < ROOMS_PER_FLOOR + 1; i++) apply(s, evt({ kind: 'stop', agentId: 'sub' + i, agentType: 'Explore', text: 'tchau' }));
  const main = s.agents.get('main');
  ok('o endereço do principal ficou constante', main.room === addr && main.room === MAIN_ROOM);
  ok('o principal segue no 1º andar', Math.floor(main.room / ROOMS_PER_FLOOR) === 0 && insideRoom(main.x, main.y, main.room));
}

// ── o principal chega depois dos subagentes e ainda pega o cômodo dele ───────
{
  const s = createScene();
  // Cinco subagentes tomam o andar antes de o principal aparecer.
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) {
    apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));
    apply(s, evt({ kind: 'tool_start', agentId: 'sub' + i, agentType: 'Explore', tool: 'Read', prop: deskProp('f' + i + '.ts') }));
  }
  const squatter = [...s.agents.values()].find((a) => a.room === MAIN_ROOM);
  const c = apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'cheguei' }));
  const main = s.agents.get('main');
  ok('o principal toma o cômodo reservado', main.room === MAIN_ROOM);
  ok('o invasor foi realocado', s.agents.get(squatter.id).room !== MAIN_ROOM);
  ok('o móvel do realocado o acompanha', cmdsOf(c, 'prop-move').length >= 1 &&
     insideRoom(s.props.get(squatter.id + '|file:f' + squatter.id.slice(3) + '.ts').x, s.props.get(squatter.id + '|file:f' + squatter.id.slice(3) + '.ts').y, s.agents.get(squatter.id).room));
  { const v = invariantsHold(s); ok('invariantes valem após o principal chegar tarde', v.ok, v.detail); }
}

// ── elevador até a estação: o robô desce ao térreo e volta (issue #9) ────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const room = s.agents.get('a1').room;

  const c = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  const a = s.agents.get('a1');
  ok('usar estação marca o robô como fora', a.away === true);
  ok('o robô desce ao térreo', onGround(a.x, a.y), `x=${a.x} y=${a.y}`);
  ok('o robô encosta na estação do térreo', Math.abs(a.x - STATIONS.terminal.x) < 60, `x=${a.x}`);
  ok('o cômodo do robô continua reservado', a.room === room);
  ok('a viagem até a estação é de elevador', cmdsOf(c, 'agent-move').some((m) => m.elevator === true));
  { const v = invariantsHold(s); ok('invariantes valem com o robô na estação', v.ok, v.detail); }

  const back = apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', tool: 'Bash' }));
  const a2 = s.agents.get('a1');
  ok('ao terminar, o robô deixa de estar fora', a2.away === false);
  ok('o robô volta para o próprio cômodo', insideRoom(a2.x, a2.y, a2.room));
  ok('a volta também é de elevador', cmdsOf(back, 'agent-move').some((m) => m.elevator === true));
}

// ── usar móvel (não estação) continua dentro do cômodo (issue #9) ────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('x.ts') }));
  const a = s.agents.get('a1');
  ok('móvel do cômodo não manda o robô ao térreo', a.away === false && insideRoom(a.x, a.y, a.room));
}

// ── dois robôs na mesma estação não se sobrepõem (issue #9) ──────────────────
{
  const s = createScene();
  const term = { kind: 'terminal', key: 'terminal', label: 'terminal' };
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: term }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: term }));
  const a1 = s.agents.get('a1');
  const a2 = s.agents.get('a2');
  ok('os dois na estação, no térreo', a1.away && a2.away && onGround(a1.x, a1.y) && onGround(a2.x, a2.y));
  ok('os dois não se sobrepõem na estação', Math.hypot(a1.x - a2.x, a1.y - a2.y) > 24, `a1=${a1.x} a2=${a2.x}`);
  { const v = invariantsHold(s); ok('invariantes valem com dois na estação', v.ok, v.detail); }
}

// ── pureza (ADR-0001): reconstruir do log é idêntico ao construído ao vivo ─
{
  const events = [
    evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }),
    evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('auth.ts') }),
    evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }),
    evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop: deskProp('auth.ts') }),
    evt({ kind: 'tool_start', agentId: 'main', agentType: 'main', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }),
  ];

  const live = createScene();
  for (const ev of events) apply(live, ev);   // ao vivo: um evento de cada vez

  const rebuilt = createScene();
  rebuild(rebuilt, events);                    // reconstruído: o log inteiro de uma vez

  const posA = (s) => [...s.agents.values()].map((a) => `${a.id}:${a.x},${a.y}`).sort().join('|');
  const posP = (s) => [...s.props.values()].map((p) => `${p.key}:${p.x},${p.y}`).sort().join('|');
  ok('agentes reconstruídos idênticos ao ao vivo', posA(live) === posA(rebuilt), `${posA(live)} ≠ ${posA(rebuilt)}`);
  ok('móveis reconstruídos idênticos ao ao vivo', posP(live) === posP(rebuilt), `${posP(live)} ≠ ${posP(rebuilt)}`);
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

// ── ciclo de vida da sessão ────────────────────────────────────────────────
{
  const NOW = Date.now();
  const store = new Map();

  const s = openSession(store, 'sess-1', '/proj/app', NOW);
  s.events.push({ seq: 1 });   // um pouco de trabalho aconteceu
  ok('sessão nova nasce viva', !isDead(s, NOW));
  ok('sessão viva entra na lista', liveSessions(store, NOW).length === 1);

  // SessionEnd mata: marcada como fechada, some da lista, é varrida do armazém.
  s.closed = true;
  ok('SessionEnd mata a sessão', isDead(s, NOW));
  ok('sessão morta sai da lista', liveSessions(store, NOW).length === 0);
  ok('a morta é varrida do armazém', !store.has('sess-1'));

  // Ressuscita ao voltar a agir — e o prédio vem reconstruído (sem os agentes de antes).
  const s2 = openSession(store, 'sess-1', '/proj/app', NOW + 1000);
  ok('sessão ressuscita ao voltar a agir', !isDead(s2, NOW + 1000));
  ok('a ressuscitada volta à lista', liveSessions(store, NOW + 1000).length === 1);
  ok('o prédio ressuscita reconstruído', s2.events.length === 0);

  // Ressureição de uma morta que ainda não foi varrida: openSession reconstrói.
  const a = openSession(store, 'sess-2', null, NOW);
  a.events.push({ seq: 1 });
  a.closed = true;
  const b = openSession(store, 'sess-2', null, NOW + 5);
  ok('openSession reconstrói a morta ainda no armazém', b !== a && !b.closed && b.events.length === 0);

  // Rede de segurança: trinta minutos de silêncio matam sozinhos.
  const later = NOW + 1000 + SESSION_TTL + 1;
  ok('silêncio de 30 min mata a sessão', isDead(s2, later));
  ok('a morta por silêncio sai da lista', liveSessions(store, later).length === 0);
}

// ── os hooks no settings.json ─────────────────────────────────────────────
{
  const s = buildSettings({}, { repoDir: '/repo' });
  const h = s.hooks;

  // Todo evento que a cena consome vira um hook http apontando para /hook.
  const httpOk = HTTP_EVENTS.every((e) => {
    const groups = h[e] || [];
    return groups.some((g) => g.hooks.some((x) => x.type === 'http' && x.url.endsWith('/hook')));
  });
  ok('todo evento da cena vira hook http', httpOk);
  ok('SubagentStart e SubagentStop estão cobertos',
     HTTP_EVENTS.includes('SubagentStart') && HTTP_EVENTS.includes('SubagentStop'));

  // Só PreToolUse/PostToolUse peneiram por matcher; os demais não.
  ok('PreToolUse tem matcher', (h.PreToolUse || []).some((g) => g.matcher === '*'));
  ok('UserPromptSubmit não tem matcher', (h.UserPromptSubmit || []).every((g) => g.matcher === undefined));

  // SessionStart é command (sobe o servidor), não http.
  const start = (h.SessionStart || [])[0]?.hooks?.[0];
  ok('SessionStart é command', start?.type === 'command');
  ok('SessionStart chama o ensure-server', String(start?.command).includes('ensure-server.mjs'));

  // Idempotente: reinstalar não duplica nem clona o que já existe.
  const twice = buildSettings(s, { repoDir: '/repo' });
  ok('reinstalar é idempotente', JSON.stringify(twice) === JSON.stringify(s));

  // Não pisa em hooks de terceiros nem em outras chaves.
  const mine = { type: 'command', command: 'meu-hook' };
  const withOther = buildSettings(
    { permissions: { allow: ['Bash'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [mine] }] } },
    { repoDir: '/repo' },
  );
  ok('preserva outras chaves', withOther.permissions.allow[0] === 'Bash');
  ok('preserva hook de terceiro', withOther.hooks.PreToolUse.some((g) => g.hooks.some((x) => x.command === 'meu-hook')));
  ok('mas acrescenta o nosso', withOther.hooks.PreToolUse.some((g) => g.hooks.some((x) => x.type === 'http')));
}

// ── enquadramento das vistas: corte vertical e andar cheio (issue #11) ─────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));

  // Vista empilhada com um andar: cobre o andar 0 e o térreo inteiro.
  const b1 = buildingRect(s);
  ok('o corte vertical cobre a planta toda', b1.w > 0 && b1.h > 0 && b1.w <= PLAN.w + 80);
  ok('o corte vertical desce até o térreo', b1.y + b1.h >= groundBox.y + groundBox.h - 1);
  ok('o corte vertical cobre o 1º andar', b1.y <= roomRect(0).y);

  // O andar cheio enquadra os cinco cômodos daquele andar, e só eles.
  const f0 = floorRect(0);
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) {
    const r = roomRect(i);
    ok(`o andar cheio contém o cômodo ${i}`, r.y >= f0.y && r.y + r.h <= f0.y + f0.h && r.x >= f0.x && r.x + r.w <= f0.x + f0.w);
  }
  ok('o andar cheio não desce ao térreo', f0.y + f0.h < groundBox.y + groundBox.h);
  ok('o andar cheio é mais baixo que o prédio de um andar', f0.h < b1.h);

  // O sexto agente abre o 2º andar: o corte vertical cresce para cima.
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));
  const b2 = buildingRect(s);
  ok('o prédio tem dois andares', floorCount(s) === 2);
  ok('o corte vertical sobe com o andar novo', b2.y < b1.y && b2.h > b1.h);
  ok('o corte vertical cobre o andar de cima', b2.y <= floorRect(1).y);

  // Andares não se sobrepõem: cada um é uma faixa própria, de baixo para cima.
  ok('o andar de cima fica acima do de baixo', floorRect(1).y < floorRect(0).y);
  ok('todo robô cabe no enquadramento do prédio',
     [...s.agents.values()].every((a) => a.y >= b2.y && a.y <= b2.y + b2.h));
}

// ── o poço do elevador e a viagem em três pernas ───────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));

  // O poço é uma coluna própria: nenhum cômodo invade a faixa dele.
  // O poço fica atrás das plataformas (wy negativo): nenhum cômodo o alcança.
  ok('o poço fica atrás dos cômodos', SHAFT.wy + SHAFT.d <= 0);
  ok('o poço está na faixa da plataforma', SHAFT.wx >= 0 && SHAFT.wx + SHAFT.w <= PLATE.x);
  const sh = shaftRect(s);
  ok('o poço vai do último andar até o térreo', sh.y <= roomRect(0).y && sh.y + sh.h >= cabinRect(GROUND_FLOOR).y);
  ok('a cabine cabe dentro do poço', cabinRect(0).x >= sh.x && cabinRect(0).x + cabinRect(0).w <= sh.x + sh.w);
  ok('a cabine do térreo fica abaixo da do 1º andar', cabinRect(GROUND_FLOOR).y > cabinRect(0).y);
  ok('a cabine nasce no térreo', s.cabinFloor === -1);

  // Usar uma estação vira uma viagem: entrar na cabine, descer, sair.
  const c = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  const legs = cmdsOf(c, 'agent-move').map((m) => m.leg);
  ok('a ida é em três pernas pelo poço', legs.join(',') === 'board,ride,off', legs.join(','));
  const board = cmdsOf(c, 'agent-move')[0];
  ok('a primeira perna entra na cabine do próprio andar',
     Math.abs(board.x - cabinStand(0).x) < 1 && Math.abs(board.y - cabinStand(0).y) < 1);
  ok('a cabine é chamada na viagem', cmdsOf(c, 'cabin').length === 1);
  ok('a cabine desce ao térreo', s.cabinFloor === -1 && cmdsOf(c, 'cabin')[0].to === -1);
  ok('o robô termina na estação', Math.abs(s.agents.get('a1').x - STATIONS.terminal.x) < 60);
  { const v = invariantsHold(s); ok('invariantes valem depois da descida', v.ok, v.detail); }

  // E a volta sobe de novo, pelas mesmas três pernas.
  const back = apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', tool: 'Bash' }));
  ok('a volta também é em três pernas', cmdsOf(back, 'agent-move').map((m) => m.leg).join(',') === 'board,ride,off');
  ok('a cabine sobe ao andar do robô', s.cabinFloor === 0);
  ok('o robô volta ao próprio cômodo', insideRoom(s.agents.get('a1').x, s.agents.get('a1').y, s.agents.get('a1').room));
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
