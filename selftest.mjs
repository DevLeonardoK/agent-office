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
  createScene, apply, rebuild, roomTiles, roomQuad, ROOMS_PER_FLOOR,
  DOOR, STATIONS, MAIN_ROOM, floorCount, buildingBounds, platformShape, platformOrigin,
  plateOf, world, levelY, stairSteps, stairFoot, stairHead, STEPS, LEVEL, STAGGER,
  PLATE, GROUND_FLOOR, GROUND_PLATE, WALL_H, STAIR_LANES, stairLaneOffset, stairWell, WELL_W,
  HUE_COUNT,
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
// A mobília é do cômodo (issue #14): a chave é do cômodo e do tipo, e o nome do
// arquivo não entra nela.
const furniture = (s, slot) => [...s.props.values()].filter((p) => p.slot === slot);
const roomProp = (s, slot, kind) => s.props.get(`room${slot}|${kind}`);

// ── invariantes de layout ──────────────────────────────────────────────────
//
// O mundo é 3D (ADR-0003): as asserções falam de unidades de mundo, não de
// pixels. Um ponto pertence a um cômodo quando cai dentro do retângulo local
// daquele cômodo, no andar dele.

const localOf = (p, floor) => {
  const o = platformOrigin(floor);
  return { lx: p.wx - o.x, lz: p.wz - o.z };
};

function insideRoom(p, slot, pad = 0.6) {
  const r = roomTiles(slot);
  if (Math.abs((p.wy ?? levelY(r.floor)) - levelY(r.floor)) > 0.35) return false;
  const l = localOf(p, r.floor);
  return l.lx >= r.lx - pad && l.lx <= r.lx + r.w + pad &&
         l.lz >= r.lz - pad && l.lz <= r.lz + r.d + pad;
}

/** No térreo de serviço: no andar -1 e dentro da plataforma dele. */
function onGround(p, pad = 2) {
  if (Math.abs(p.wy - levelY(GROUND_FLOOR)) > 0.35) return false;
  const l = localOf(p, GROUND_FLOOR);
  return l.lx >= -pad && l.lx <= GROUND_PLATE.x + pad && l.lz >= -pad && l.lz <= GROUND_PLATE.z + pad;
}

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

  // Nenhum andar excede cinco agentes; nenhum andar vazio entre o térreo e o topo.
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

  // Todo robô está no seu cômodo, no térreo (usando estação), ou na escada.
  for (const a of agents) {
    const onStair = Math.abs(a.wy - levelY(a.floor ?? 0)) > 0.2;
    const placed = a.away ? onGround(a) : insideRoom(a, a.room) || onGround(a) || onStair;
    if (!placed) bad.push(`robô ${a.id} nem no cômodo ${a.room} nem no térreo nem na escada`);
  }

  // Nenhum robô se sobrepõe a outro.
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const d = Math.hypot(agents[i].wx - agents[j].wx, agents[i].wy - agents[j].wy, agents[i].wz - agents[j].wz);
      if (d < 0.9) bad.push(`robôs ${agents[i].id} e ${agents[j].id} sobrepostos`);
    }
  }

  // Todo móvel de cômodo dentro do cômodo do dono; toda estação no térreo.
  for (const p of s.props.values()) {
    if (p.fixed) {
      if (!onGround(p)) bad.push(`estação ${p.key} fora do térreo`);
    } else if (!insideRoom(p, p.slot)) {
      bad.push(`móvel ${p.key} fora do cômodo ${p.slot}`);
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
  ok('tool_start não cria móvel', cmdsOf(c2, 'prop-add').length === 0);
  ok('tool_start acende o móvel do cômodo', cmdsOf(c2, 'prop-hit').length === 1);

  const a = s.agents.get('a1');
  const p = roomProp(s, a.room, 'desk');
  ok('a mesa nasceu com o cômodo', p && p.slot === a.room && insideRoom(p, a.room));
  ok('a mobília chegou com o ocupante', cmdsOf(c1, 'prop-add').length === 2);
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

// ── dois agentes no mesmo arquivo usam a mesa de cada cômodo (issue #14) ────
{
  const s = createScene();
  const prop = deskProp('shared.ts');
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop }));

  const a1 = s.agents.get('a1');
  const a2 = s.agents.get('a2');
  ok('nenhum móvel carrega o nome do arquivo', ![...s.props.keys()].some((k) => k.includes('shared.ts')));
  ok('cada um usa a mesa do próprio cômodo',
     a1.propKey === `room${a1.room}|desk` && a2.propKey === `room${a2.room}|desk`);
  ok('a mesa de cada cômodo está dentro dele',
     insideRoom(roomProp(s, a1.room, 'desk'), a1.room) &&
     insideRoom(roomProp(s, a2.room, 'desk'), a2.room));
  ok('o arquivo tocado fica no agente, para o elenco', a1.subject === 'shared.ts');
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

// ── ferramenta não deixa marca: 40 usos, mobília igual (issue #14) ──────────
{
  const s = createScene();
  apply(s, evt({ kind: 'tool_start', tool: 'Read', prop: deskProp('primeiro.ts') }));
  const main = s.agents.get('main');
  const antes = furniture(s, main.room).length;

  for (let i = 0; i < 40; i++) {
    apply(s, evt({ kind: 'tool_start', tool: 'Read', prop: deskProp('m' + i + '.ts') }));
  }
  ok('a mobília do cômodo não cresce com o uso', furniture(s, main.room).length === antes, `${antes} → ${furniture(s, main.room).length}`);
  ok('o cômodo tem a mobília fixa e nada mais', antes === 2);
  ok('nenhum móvel guarda nome de arquivo', ![...s.props.keys()].some((k) => k.includes('.ts')));
  ok('o último arquivo tocado fica no agente', s.agents.get('main').subject === 'm39.ts');
  const fora = furniture(s, main.room).filter((p) => !insideRoom(p, main.room));
  ok('nenhum móvel escapa do cômodo', fora.length === 0, `${fora.length} fora`);
  { const v = invariantsHold(s); ok('invariantes valem depois de 40 ferramentas', v.ok, v.detail); }
}

// ── a ferramenta acende o móvel do tipo dela (issue #14) ────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const slot = s.agents.get('a1').room;

  const c1 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('x.ts') }));
  ok('o Read acende a mesa', cmdsOf(c1, 'prop-hit')[0].prop.key === `room${slot}|desk`);
  ok('acender não cria móvel', cmdsOf(c1, 'prop-add').length === 0);

  const c2 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Skill', prop: { kind: 'shelf', key: 'shelf', label: 'manuais' } }));
  ok('o Skill acende a estante', cmdsOf(c2, 'prop-hit')[0].prop.key === `room${slot}|shelf`);

  const c3 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Esquisita', prop: { kind: 'sofa', key: 'sofa', label: 'sofá' } }));
  ok('tipo sem móvel próprio cai na mesa', cmdsOf(c3, 'prop-hit')[0].prop.key === `room${slot}|desk`);
}

// ── estações são singulares e moram no térreo ───────────────────────────────
{
  const s = createScene();
  for (const [kind, st] of Object.entries(STATIONS)) {
    apply(s, evt({ kind: 'tool_start', tool: 'X', prop: { kind, key: kind, label: kind } }));
    const p = s.props.get(kind);
    ok(`${kind} ancora em ${st.label}`, p.wx === st.wx && p.wy === st.wy && p.wz === st.wz && p.fixed);
    ok(`${kind} está no térreo`, onGround(p));
  }
  // Dois agentes usando o terminal compartilham a mesma estação global.
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  ok('terminal não duplica entre agentes', s.props.get('terminal').uses === 2);
  { const v = invariantsHold(s); ok('invariantes valem com estações em uso', v.ok, v.detail); }
}

// ── todo subagente entra pela porta do prédio e sobe a escada ──────────────
{
  const s = createScene();
  // o principal convoca um subagente
  apply(s, evt({ kind: 'tool_start', tool: 'Task', prop: { kind: 'door', key: 'door', label: 'porta' } }));
  const pai = s.agents.get('main');

  const c = apply(s, evt({ kind: 'spawn', agentId: 'ag-1', agentType: 'Explore' }));
  const enter = cmdsOf(c, 'agent-enter')[0];
  ok('o filho entra pela porta do prédio, não ao lado do pai',
     enter && Math.abs(enter.wx - DOOR.wx) < 0.01 && Math.abs(enter.wz - DOOR.wz) < 0.01,
     `enter=(${enter?.wx},${enter?.wz})`);
  ok('o filho nasce no térreo, mesmo com o pai num andar', enter.wy === levelY(GROUND_FLOOR));

  const legs = cmdsOf(c, 'agent-move');
  ok('o filho sobe a escada até o cômodo', legs.some((m) => m.kind === 'stair'));
  ok('e chega ao próprio andar', Math.abs(legs[legs.length - 1].wy - levelY(0)) < 0.01);

  const filho = s.agents.get('ag-1');
  ok('o cômodo do filho não é o do pai', filho.room !== pai.room, `filho=${filho.room} pai=${pai.room}`);
  ok('a linhagem não cria móvel: só a mobília dos dois cômodos', s.props.size === 4);
  { const v = invariantsHold(s); ok('invariantes valem depois da chegada do filho', v.ok, v.detail); }
}

// ── quem chega entra igual, com ou sem pai no prédio ───────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'tool_start', tool: 'Task', prop: { kind: 'door', key: 'door', label: 'porta' } }));
  apply(s, evt({ kind: 'stop', agentId: 'main' }));   // o pai vai embora antes do filho chegar
  const c = apply(s, evt({ kind: 'spawn', agentId: 'ag-1', agentType: 'Explore' }));
  const enter = cmdsOf(c, 'agent-enter')[0];
  ok('sem pai no prédio, o filho entra pela mesma porta',
     enter && Math.abs(enter.wx - DOOR.wx) < 0.01 && Math.abs(enter.wz - DOOR.wz) < 0.01,
     `enter=(${enter?.wx},${enter?.wz})`);
}

// ── saída libera o cômodo, que é reciclado ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const room1 = s.agents.get('a1').room;
  const c = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'achei 4 handlers' }));
  ok('sai andando até a porta', cmdsOf(c, 'agent-move').some((m) => Math.abs(m.wx - DOOR.wx) < 0.01));
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
  ok('rebuild monta a mobília dos cômodos e a estação usada', s.props.size === 5);
  ok('rebuild monta os agentes do log', s.agents.size === 2);
  ok('rebuild entra instantâneo', cmdsOf(c, 'agent-enter').every((e) => e.instant === true));
  ok('rebuild não anima o movimento', cmdsOf(c, 'agent-move').every((m) => m.instant === true));
}


// ── o cômodo do principal fica no 1º andar ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', text: 'oi' }));
  const main = s.agents.get('main');
  ok('o principal ocupa um cômodo do 1º andar', main.room >= 0 && main.room < ROOMS_PER_FLOOR && insideRoom(main, main.room));
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
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('velho.ts') }));
  const room1 = s.agents.get('a1').room;
  ok('o cômodo do primeiro está mobiliado', furniture(s, room1).length === 2);

  const c2 = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'saí' }));
  ok('a saída desmobilia o cômodo', furniture(s, room1).length === 0 && cmdsOf(c2, 'prop-remove').length === 2);

  apply(s, evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop: deskProp('novo.ts') }));
  ok('o próximo recicla a vaga já vazia', s.agents.get('a2').room === room1);
  ok('o cômodo reciclado é remobiliado do zero', furniture(s, room1).length === 2 && !s.agents.get('a2').subject === false);
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
  ok('o principal segue no 1º andar', Math.floor(main.room / ROOMS_PER_FLOOR) === 0 && insideRoom(main, main.room));
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
  // A mobília é do cômodo: o realocado deixa a do antigo e encontra a do novo.
  const novo = s.agents.get(squatter.id).room;
  ok('o cômodo novo do realocado está mobiliado', furniture(s, novo).length === 2);
  ok('a mobília do realocado fica dentro do cômodo novo',
     furniture(s, novo).every((p) => insideRoom(p, novo)));
  { const v = invariantsHold(s); ok('invariantes valem após o principal chegar tarde', v.ok, v.detail); }
}

// ── usar móvel (não estação) continua dentro do cômodo (issue #9) ────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('x.ts') }));
  const a = s.agents.get('a1');
  ok('móvel do cômodo não manda o robô ao térreo', a.away === false && insideRoom(a, a.room));
}


// ── saída libera o cômodo, que é reciclado ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const room1 = s.agents.get('a1').room;
  const c = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'achei 4 handlers' }));
  ok('sai andando até a porta', cmdsOf(c, 'agent-move').some((m) => Math.abs(m.wx - DOOR.wx) < 0.01));
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
  ok('rebuild monta a mobília dos cômodos e a estação usada', s.props.size === 5);
  ok('rebuild monta os agentes do log', s.agents.size === 2);
  ok('rebuild entra instantâneo', cmdsOf(c, 'agent-enter').every((e) => e.instant === true));
  ok('rebuild não anima o movimento', cmdsOf(c, 'agent-move').every((m) => m.instant === true));
}


// ── o cômodo do principal fica no 1º andar ──────────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', text: 'oi' }));
  const main = s.agents.get('main');
  ok('o principal ocupa um cômodo do 1º andar', main.room >= 0 && main.room < ROOMS_PER_FLOOR && insideRoom(main, main.room));
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
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('velho.ts') }));
  const room1 = s.agents.get('a1').room;
  ok('o cômodo do primeiro está mobiliado', furniture(s, room1).length === 2);

  const c2 = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'saí' }));
  ok('a saída desmobilia o cômodo', furniture(s, room1).length === 0 && cmdsOf(c2, 'prop-remove').length === 2);

  apply(s, evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Read', prop: deskProp('novo.ts') }));
  ok('o próximo recicla a vaga já vazia', s.agents.get('a2').room === room1);
  ok('o cômodo reciclado é remobiliado do zero', furniture(s, room1).length === 2 && !s.agents.get('a2').subject === false);
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
  ok('o principal segue no 1º andar', Math.floor(main.room / ROOMS_PER_FLOOR) === 0 && insideRoom(main, main.room));
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
  // A mobília é do cômodo: o realocado deixa a do antigo e encontra a do novo.
  const novo = s.agents.get(squatter.id).room;
  ok('o cômodo novo do realocado está mobiliado', furniture(s, novo).length === 2);
  ok('a mobília do realocado fica dentro do cômodo novo',
     furniture(s, novo).every((p) => insideRoom(p, novo)));
  { const v = invariantsHold(s); ok('invariantes valem após o principal chegar tarde', v.ok, v.detail); }
}

// ── usar móvel (não estação) continua dentro do cômodo (issue #9) ────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('x.ts') }));
  const a = s.agents.get('a1');
  ok('móvel do cômodo não manda o robô ao térreo', a.away === false && insideRoom(a, a.room));
}

// ── dois robôs na mesma estação não se sobrepõem (issue #9) ──────────────────
{
  const s = createScene();
  const term = { kind: 'terminal', key: 'terminal', label: 'terminal' };
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: term }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: term }));
  const a1 = s.agents.get('a1');
  const a2 = s.agents.get('a2');
  ok('os dois na estação, no térreo', a1.away && a2.away && onGround(a1) && onGround(a2));
  ok('os dois não se sobrepõem na estação', Math.hypot(a1.wx - a2.wx, a1.wz - a2.wz) > 0.9, `a1=${a1.wx} a2=${a2.wx}`);
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

// ── o prédio 3D: plataformas pentagonais escalonadas (issue #15) ───────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));

  // Cada plataforma é um pentágono: o retângulo com o canto do fundo chanfrado.
  ok('a plataforma é um pentágono', platformShape(0).length === 5);
  ok('o chanfro está no canto do fundo à esquerda', (() => {
    const p = platformShape(0);
    const o = platformOrigin(0);
    // o primeiro vértice entra em x, o último desce em z: o canto (0,0) foi cortado
    return p[0].wx - o.x > 0 && p[0].wz - o.z === 0 && p[4].wx - o.x === 0 && p[4].wz - o.z > 0;
  })());

  // Escalonamento diagonal: o andar de cima nasce deslocado, e mais alto.
  const o0 = platformOrigin(0);
  const o1 = platformOrigin(1);
  ok('o andar de cima é deslocado em profundidade', o1.z !== o0.z);
  ok('o deslocamento é o mesmo em todo andar', o1.x - o0.x === STAGGER.x && o1.z - o0.z === STAGGER.z);
  // Sem desvio lateral, a escada corre reta e o vão dela é um retângulo alinhado —
  // era o desvio em x que fazia o vão furar a borda chanfrada da plataforma.
  ok('o escalonamento não desloca para o lado', STAGGER.x === 0);
  ok('o lance corre reto', Math.abs(stairFoot(0).wx - stairHead(0).wx) < 1e-9);
  ok('o andar de cima fica mais alto', levelY(1) - levelY(0) === LEVEL);
  ok('o térreo fica abaixo do 1º andar', levelY(GROUND_FLOOR) < levelY(0));
  ok('o térreo é a plataforma maior', plateOf(GROUND_FLOOR).z > plateOf(0).z);

  // A caixa do prédio cresce com o andar novo e acompanha o escalonamento.
  const b1 = buildingBounds(s);
  ok('a caixa do prédio cobre o térreo', b1.min.y <= levelY(GROUND_FLOOR));
  ok('a caixa do prédio cobre o topo', b1.max.y >= levelY(0) + WALL_H);

  for (let i = 0; i < ROOMS_PER_FLOOR; i++) apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));
  const b2 = buildingBounds(s);
  ok('o prédio tem dois andares', floorCount(s) === 2);
  ok('a caixa sobe com o andar novo', b2.max.y > b1.max.y);
  ok('a caixa acompanha o escalonamento', b2.min.z < b1.min.z);
  ok('todo robô cabe na caixa do prédio', [...s.agents.values()].every(
    (a) => a.wx >= b2.min.x - 2 && a.wx <= b2.max.x + 2 && a.wy >= b2.min.y - 1 && a.wy <= b2.max.y + 1));
  { const v = invariantsHold(s); ok('invariantes valem no prédio de dois andares', v.ok, v.detail); }
}

// ── a escada: um lance por vão, subindo degrau a degrau (issue #16) ─────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));

  // O lance liga o pé, num andar, ao topo, no de cima — vencendo altura e
  // deslocamento diagonal ao mesmo tempo.
  const foot = stairFoot(0);
  const head = stairHead(0);
  ok('o pé do lance está no andar de baixo', foot.wy === levelY(0));
  ok('o topo do lance está no andar de cima', head.wy === levelY(1));
  ok('o lance vence o deslocamento diagonal', Math.abs(head.wx - foot.wx) > 0 || Math.abs(head.wz - foot.wz) > 0);

  const steps = stairSteps(0);
  ok('o lance tem os degraus declarados', steps.length === STEPS);
  ok('cada degrau sobe em relação ao anterior', steps.every((st, i) => i === 0 ? st.wy > foot.wy : st.wy > steps[i - 1].wy));
  ok('o último degrau chega ao andar de cima', Math.abs(steps[steps.length - 1].wy - levelY(1)) < 1e-9);
  ok('o degrau final já pertence ao andar de cima', steps[steps.length - 1].floor === 1);

  // Usar uma estação é descer a escada: anda, desce, anda.
  const c = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  const kinds = cmdsOf(c, 'agent-move').map((m) => m.kind);
  ok('anda até a escada antes de descer', kinds[0] === 'walk', kinds.join(','));
  ok('a descida é feita por degraus', kinds.filter((k) => k === 'stair').length === STEPS, kinds.join(','));
  ok('depois da escada ainda caminha até a estação', kinds.lastIndexOf('walk') > kinds.lastIndexOf('stair'));
  ok('não existe mais elevador na cena', cmdsOf(c, 'cabin').length === 0);

  const a = s.agents.get('a1');
  ok('o robô desce ao térreo', a.floor === GROUND_FLOOR && onGround(a));
  ok('o robô encosta na estação', Math.abs(a.wx - STATIONS.terminal.wx) < 2 && Math.abs(a.wz - STATIONS.terminal.wz) < 2.5);
  ok('usar estação marca o robô como fora', a.away === true);
  { const v = invariantsHold(s); ok('invariantes valem com o robô na estação', v.ok, v.detail); }

  // E a volta sobe pela escada, terminando no próprio cômodo.
  const back = apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', tool: 'Bash' }));
  const volta = cmdsOf(back, 'agent-move').map((m) => m.kind);
  ok('a volta também sobe por degraus', volta.filter((k) => k === 'stair').length === STEPS, volta.join(','));
  const a2 = s.agents.get('a1');
  ok('ao terminar, o robô deixa de estar fora', a2.away === false);
  ok('o robô volta para o próprio cômodo', insideRoom(a2, a2.room) && a2.floor === 0);
}

// ── dois robôs na mesma estação não se sobrepõem ───────────────────────────
{
  const s = createScene();
  const term = { kind: 'terminal', key: 'terminal', label: 'terminal' };
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: term }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: term }));
  const a1 = s.agents.get('a1');
  const a2 = s.agents.get('a2');
  ok('os dois na estação, no térreo', a1.away && a2.away && onGround(a1) && onGround(a2));
  ok('os dois não se sobrepõem na estação', Math.hypot(a1.wx - a2.wx, a1.wz - a2.wz) > 0.9);
  { const v = invariantsHold(s); ok('invariantes valem com dois na estação', v.ok, v.detail); }
}

// ── a escadaria é contínua e ninguém atravessa o vazio (issue #19) ──────────
{
  const s = createScene();
  // Enche dois andares, para existir mais de um lance.
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) apply(s, evt({ kind: 'spawn', agentId: 'sub' + i, agentType: 'Explore' }));
  const floors = floorCount(s);
  ok('o prédio tem dois andares para testar a escadaria', floors === 2);

  // Cada vão tem o seu lance, e um lance encosta no seguinte: de qualquer andar
  // dá para descer, lance a lance, até o térreo.
  for (let f = GROUND_FLOOR; f < floors - 1; f++) {
    const foot = stairFoot(f);
    const head = stairHead(f);
    ok(`o lance ${f}→${f + 1} sai do andar ${f}`, foot.wy === levelY(f));
    ok(`o lance ${f}→${f + 1} chega ao andar ${f + 1}`, head.wy === levelY(f + 1));
    // o pé do lance está sobre a plataforma do andar de onde ele sai
    const l = localOf(foot, f);
    const plate = plateOf(f);
    ok(`o pé do lance ${f}→${f + 1} pisa na plataforma`, l.lx > 0 && l.lx < plate.x && l.lz > 0 && l.lz < plate.z,
       `local=(${l.lx.toFixed(1)},${l.lz.toFixed(1)})`);
  }
  // A cadeia fecha: descendo de lance em lance a partir do topo chega-se ao térreo.
  let y = levelY(floors - 1);
  for (let f = floors - 2; f >= GROUND_FLOOR; f--) {
    ok(`o lance ${f}→${f + 1} recebe quem vem de cima`, stairHead(f).wy === y);
    y = stairFoot(f).wy;
  }
  ok('a escadaria termina no térreo', y === levelY(GROUND_FLOOR));

  // E o trajeto: nenhuma perna de caminhada muda de altura sem degrau. Era assim
  // que o robô saía do prédio pelo ar, na diagonal.
  const upstairs = [...s.agents.values()].find((a) => Math.floor(a.room / ROOMS_PER_FLOOR) === 1);
  const c = apply(s, evt({ kind: 'stop', agentId: upstairs.id, agentType: upstairs.type, text: 'tchau' }));
  const legs = cmdsOf(c, 'agent-move');
  ok('sair do prédio passa pela escada', legs.some((m) => m.kind === 'stair'));
  let jumps = 0;
  for (let i = 1; i < legs.length; i++) {
    if (legs[i].kind !== 'stair' && Math.abs(legs[i].wy - legs[i - 1].wy) > 0.01) jumps++;
  }
  ok('nenhuma caminhada muda de altura fora da escada', jumps === 0, `${jumps} pernas suspeitas`);
  ok('a saída termina na porta, no térreo',
     Math.abs(legs[legs.length - 1].wy - levelY(GROUND_FLOOR)) < 0.01 &&
     Math.abs(legs[legs.length - 1].wx - DOOR.wx) < 0.01);
}

// ── faixas da escada: dois robôs não sobem no mesmo degrau (issue #18) ─────
{
  const s = createScene();
  const term = { kind: 'terminal', key: 'terminal', label: 'terminal' };
  const lib = { kind: 'library', key: 'library', label: 'biblioteca' };

  // Dois agentes do 1º andar descem para estações ao mesmo tempo.
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  apply(s, evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }));
  const c1 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: term }));
  const c2 = apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'WebFetch', prop: lib }));

  const stairsOf = (c) => cmdsOf(c, 'agent-move').filter((m) => m.kind === 'stair');
  const s1 = stairsOf(c1);
  const s2 = stairsOf(c2);
  ok('os dois usam a escada', s1.length === STEPS && s2.length === STEPS);

  // Nenhum degrau do primeiro coincide com um degrau do segundo.
  let colisoes = 0;
  for (const p of s1) {
    for (const q of s2) {
      if (Math.abs(p.wy - q.wy) < 0.01 && Math.hypot(p.wx - q.wx, p.wz - q.wz) < 0.8) colisoes++;
    }
  }
  ok('os dois sobem em faixas separadas', colisoes === 0, `${colisoes} degraus coincidentes`);
  ok('a escada tem as faixas declaradas', STAIR_LANES >= 2);
  ok('as faixas são perpendiculares à subida', (() => {
    const a = stairLaneOffset(0, 0);
    const b = stairLaneOffset(0, 1);
    return Math.hypot(a.x - b.x, a.z - b.z) > 0.8;
  })());
  { const v = invariantsHold(s); ok('invariantes valem com dois na escada', v.ok, v.detail); }
}

// ── o vão da escada: o robô não sobe contra a laje (issue #19) ──────────────
{
  const inside = (poly, x, z) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.wz > z) !== (b.wz > z) && x < ((b.wx - a.wx) * (z - a.wz)) / (b.wz - a.wz) + a.wx) hit = !hit;
    }
    return hit;
  };

  const well = stairWell(0);
  ok('o vão é um retângulo de quatro cantos', well.length === 4);
  ok('o vão está na altura da laje do andar', well.every((p) => p.wy === levelY(0)));
  ok('o vão tem a largura declarada', Math.abs(Math.hypot(well[0].wx - well[1].wx, well[0].wz - well[1].wz) - WELL_W) < 1e-9);

  // A boca do vão cobre o desembarque e os últimos degraus da subida: é por ali
  // que o robô passa, e é o que precisa estar aberto.
  const head = stairHead(-1);
  ok('o vão cobre o desembarque', inside(well, head.wx, head.wz));
  const steps = stairSteps(-1);
  const altos = steps.filter((st) => st.wy > levelY(0) - 1.6);
  ok('o vão cobre os últimos degraus', altos.length > 0 && altos.every((st) => inside(well, st.wx, st.wz)),
     `${altos.filter((st) => !inside(well, st.wx, st.wz)).length} degraus tapados`);

  // O vão inteiro cabe na plataforma: um canto de fora recortava a borda do prédio
  // e a abertura aparecia cortada.
  const outline = platformShape(0);
  ok('o vão está inteiro dentro da plataforma', well.every((p) => inside(outline, p.wx, p.wz)),
     `${well.filter((p) => !inside(outline, p.wx, p.wz)).length} cantos fora`);

  // E não é um buraco no meio do cômodo: fica na baia, fora dos cinco cômodos.
  for (let i = 0; i < ROOMS_PER_FLOOR; i++) {
    const r = roomTiles(i);
    const o = platformOrigin(0);
    const cx = o.x + r.lx + r.w / 2;
    const cz = o.z + r.lz + r.d / 2;
    ok(`o vão não invade o cômodo ${i}`, !inside(well, cx, cz));
  }
}

// ── a porta pisa na plataforma do térreo ───────────────────────────────────
{
  // Fora da plataforma, quem saía do prédio caminhava para o vazio — e o que se
  // via era um robô flutuando ao lado do prédio, como se houvesse escada ali.
  const o = platformOrigin(GROUND_FLOOR);
  ok('a porta está dentro da plataforma do térreo',
     DOOR.wx > o.x && DOOR.wx < o.x + GROUND_PLATE.x &&
     DOOR.wz > o.z && DOOR.wz < o.z + GROUND_PLATE.z,
     `porta=(${DOOR.wx.toFixed(1)},${DOOR.wz.toFixed(1)}) plataforma x=[${o.x},${(o.x + GROUND_PLATE.x)}] z=[${o.z},${(o.z + GROUND_PLATE.z)}]`);
  ok('a porta está na altura do térreo', DOOR.wy === levelY(GROUND_FLOOR));

  // E o trajeto de saída termina lá, pisando no chão.
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const c = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore', text: 'tchau' }));
  const last = cmdsOf(c, 'agent-move').at(-1);
  ok('quem sai termina na porta, sobre a plataforma', onGround(last, 0));
}

// ── a paleta dos subagentes, com o rosa (issue #17) ────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  ok('o principal não tira matiz da paleta', s.agents.get('main').hueIndex === -1);

  // Seis subagentes seguidos recebem os seis matizes, sem repetir.
  const vistos = new Set();
  for (let i = 0; i < HUE_COUNT; i++) {
    apply(s, evt({ kind: 'spawn', agentId: 'p' + i, agentType: 'Explore' }));
    vistos.add(s.agents.get('p' + i).hueIndex);
  }
  ok('a paleta tem seis matizes', HUE_COUNT === 6);
  ok('seis subagentes seguidos não repetem matiz', vistos.size === HUE_COUNT, [...vistos].join(','));
  ok('o índice de matiz fica dentro da paleta', [...vistos].every((i) => i >= 0 && i < HUE_COUNT));

  // O sétimo dá a volta na paleta — e não estoura o índice.
  apply(s, evt({ kind: 'spawn', agentId: 'p6', agentType: 'Explore' }));
  const setimo = s.agents.get('p6').hueIndex;
  ok('o sétimo recomeça a paleta', setimo >= 0 && setimo < HUE_COUNT);
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
