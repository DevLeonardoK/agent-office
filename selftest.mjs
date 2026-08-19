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
  createScene, apply, rebuild, roomRect, officeShape, walls, partitions,
  DOOR, STATIONS, MAIN_SEAT, buildingBounds, fixedProps, deskOf, seatOf, seatHome,
  stationStand, LOBBY, LOBBY_X0, LOBBY_X1, LOBBY_SIDE, LANE, CORRIDOR_D, apelido,
  NECK, NECK_CX, NECK_W, NECK_D, NECK_X0, NECK_X1,
  PLATE, ROOM_COUNT, ROOM_W, ROOM_D, SEATS_PER_ROOM, SEAT_COUNT, WALL_H, FLOOR_Y,
  HUE_COUNT, terrainRect, TERRAIN_MARGIN,
  SCALE, BODY, PROP_FOOT, footprint, obstacles, freeRects, route,
} from './public/scene.mjs';
import { shape } from './shape.mjs';
import { BUILDING, PROPS, AGENT_HUES, ERROR_HUE, BACKDROP, SHELL_L, hueGap } from './public/palette.mjs';
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
//
// O mundo é 3D (ADR-0003) e tem **um pavimento só**: as asserções falam de
// unidades de mundo, e `wy` nunca muda. Um ponto pertence a uma sala quando cai
// dentro do retângulo dela.

/** Ponto dentro de um contorno fechado (que pode ter reentrância). */
function insideOutline(poly, p) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.wz > p.wz) !== (b.wz > p.wz) &&
        p.wx < ((b.wx - a.wx) * (p.wz - a.wz)) / (b.wz - a.wz) + a.wx) hit = !hit;
  }
  return hit;
}

function insideRoom(p, room, pad = 0.7) {
  const r = roomRect(room);
  return p.wx >= r.lx - pad && p.wx <= r.lx + r.w + pad &&
         p.wz >= r.lz - pad && p.wz <= r.lz + r.d + pad;
}

/** No saguão: o quadrado da entrada, onde ficam as estações e a porta. */
function inLobby(p, pad = 0.8) {
  return p.wx >= LOBBY.lx - pad && p.wx <= LOBBY.lx + LOBBY.w + pad &&
         p.wz >= LOBBY.lz - pad && p.wz <= LOBBY.lz + LOBBY.d + pad;
}

/** No corredor das salas, ou na galeria que leva ao saguão. */
function inCorridor(p, pad = 0.8) {
  const noCorredor = p.wz >= ROOM_D - pad && p.wz <= NECK.lz + pad && p.wx >= -pad && p.wx <= PLATE.x + pad;
  const naGaleria = p.wz >= NECK.lz - pad && p.wz <= NECK.lz + NECK.d + pad &&
                    p.wx >= NECK.lx - pad && p.wx <= NECK.lx + NECK.w + pad;
  return noCorredor || naGaleria;
}

/** Devolve a lista de invariantes violadas na cena. Vazia = tudo em ordem. */
function violations(s) {
  const bad = [];
  const agents = [...s.agents.values()];

  // Um ocupante por posto; todo posto tem endereço inteiro válido.
  const bySeat = new Map();
  for (const a of agents) {
    if (bySeat.has(a.slot)) bad.push(`posto ${a.slot} com dois ocupantes`);
    bySeat.set(a.slot, a);
    if (a.slot == null || a.slot < 0 || !Number.isInteger(a.slot)) bad.push(`agente ${a.id} sem posto válido`);
  }

  // Nenhuma sala passa de dois ocupantes: são dois postos por sala.
  const perRoom = new Map();
  for (const a of agents) {
    const r = seatOf(a.slot).room;
    perRoom.set(r, (perRoom.get(r) || 0) + 1);
  }
  for (const [r, n] of perRoom) if (n > SEATS_PER_ROOM) bad.push(`sala ${r} com ${n} ocupantes`);

  // Todo robô pisa no piso, e num dos três lugares que existem: a sala dele, o
  // corredor (de passagem) ou o saguão.
  for (const a of agents) {
    if (Math.abs(a.wy - FLOOR_Y) > 1e-9) bad.push(`robô ${a.id} fora do piso (wy=${a.wy})`);
    const room = seatOf(a.slot).room;
    if (!(insideRoom(a, room) || inCorridor(a) || inLobby(a))) {
      bad.push(`robô ${a.id} nem na sala ${room} nem no corredor nem no saguão`);
    }
  }

  // Nenhum robô se sobrepõe a outro.
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const d = Math.hypot(agents[i].wx - agents[j].wx, agents[i].wz - agents[j].wz);
      if (d < 0.9) bad.push(`robôs ${agents[i].id} e ${agents[j].id} sobrepostos`);
    }
  }

  // Todo móvel dentro do espaço dele: o da sala na sala, a estação e a porta no saguão.
  for (const p of s.props.values()) {
    if (p.station || p.kind === 'door') {
      if (!inLobby(p)) bad.push(`${p.key} fora do saguão`);
    } else {
      const room = Number(String(p.key).match(/^sala(\d+)/)?.[1] ?? seatOf(p.slot).room);
      if (!insideRoom(p, room, 0.3)) bad.push(`móvel ${p.key} fora da sala ${room}`);
    }
  }
  return bad;
}

const invariantsHold = (s) => { const v = violations(s); return { ok: !v.length, detail: v.join('; ') }; };

/** Todas as pernas de caminhada de uma leva de comandos. */
const legsOf = (cmds) => cmdsOf(cmds, 'agent-move');

// ── o escritório já vem mobiliado, e a mobília não some ────────────────────
{
  // A queixa que originou o redesenho: o escritório aparecia vazio de móveis, e
  // sala sem móvel lê como sala não construída. Agora a mobília é da planta.
  const s = createScene();
  const esperado = ROOM_COUNT * (3 + SEATS_PER_ROOM) + Object.keys(STATIONS).length + 1;
  ok('a cena nasce mobiliada', s.props.size === esperado, `${s.props.size} móveis, esperava ${esperado}`);
  ok('a mobília é função pura da planta', fixedProps().length === esperado);

  // Nenhum comando monta ou desmonta móvel: eles não existem mais.
  const cmds = [];
  for (const ev of [
    evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }),
    evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('auth.ts') }),
    evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore' }),
  ]) cmds.push(...apply(s, ev));
  ok('nenhum comando monta móvel', cmdsOf(cmds, 'prop-add').length === 0);
  ok('nenhum comando desmonta móvel', cmdsOf(cmds, 'prop-remove').length === 0);
  ok('a mobília sobrevive à saída do agente', s.props.size === esperado);

  // Cada sala tem a mesma mobília, e cada posto tem a mesa dele.
  for (let r = 0; r < ROOM_COUNT; r++) {
    for (const kind of ['shelf', 'cabinet', 'whiteboard']) {
      ok(`a sala ${r} tem ${kind}`, !!s.props.get(`sala${r}|${kind}`));
    }
  }
  for (let slot = 0; slot < SEAT_COUNT; slot++) {
    ok(`o posto ${slot} tem mesa`, !!s.props.get(`posto${slot}|desk`));
  }
  ok('há uma porta', s.props.get('door')?.kind === 'door');
}

// ── a mobília está espalhada pela sala, não enfileirada ────────────────────
{
  const daSala = fixedProps().filter((p) => String(p.key).startsWith('sala0') || p.key === 'posto0|desk' || p.key === 'posto1|desk');
  ok('a sala tem cinco volumes', daSala.length === 5, daSala.map((p) => p.kind).join(','));

  // Enfileirados, os volumes liam como um balcão só. Duas medidas seguram isso:
  // nenhum par colado, e nem todos na mesma faixa de profundidade.
  for (let i = 0; i < daSala.length; i++) {
    for (let j = i + 1; j < daSala.length; j++) {
      const d = Math.hypot(daSala[i].wx - daSala[j].wx, daSala[i].wz - daSala[j].wz);
      ok(`${daSala[i].kind} e ${daSala[j].kind} não se encostam`, d >= 1.9, `${d.toFixed(2)}`);
    }
  }
  const zs = daSala.map((p) => p.wz);
  ok('os móveis ocupam profundidades diferentes', Math.max(...zs) - Math.min(...zs) >= 3.5);
  const xs = daSala.map((p) => p.wx);
  ok('e larguras diferentes', Math.max(...xs) - Math.min(...xs) >= 3.5);
}

// ── um agente chega, trabalha e sai ────────────────────────────────────────
{
  const s = createScene();
  const c1 = apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  ok('spawn monta o agente', cmdsOf(c1, 'agent-enter').length === 1);
  const a = s.agents.get('a1');
  ok('o agente ganha um posto', Number.isInteger(a.slot));
  ok('o agente caminha até o posto', legsOf(c1).length > 0);
  ok('e termina dentro da sala dele', insideRoom(a, seatOf(a.slot).room));

  const c2 = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('auth.ts') }));
  ok('usar arquivo acende a mesa do posto', cmdsOf(c2, 'prop-hit')[0]?.prop.key === `posto${a.slot}|desk`);
  ok('o robô fica na sala para usar a mesa', insideRoom(a, seatOf(a.slot).room));
  ok('o nome do arquivo vive no agente, não no móvel', a.subject === 'auth.ts');

  apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore' }));
  ok('acabar a ferramenta traz de volta ao posto', s.agents.get('a1').status === 'idle');

  const c4 = apply(s, evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore' }));
  ok('sair caminha até a porta', legsOf(c4).at(-1)?.wz > LOBBY.lz);
  ok('e o agente some do elenco', !s.agents.has('a1'));
  { const v = invariantsHold(s); ok('invariantes valem depois da saída', v.ok, v.detail); }
}

// ── falha de ferramenta acende o rosto de erro do robô ────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  apply(s, evt({ kind: 'tool_end', agentId: 'a1', agentType: 'Explore', failed: true }));
  ok('falha marca o robô com erro', s.agents.get('a1').status === 'error');
  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('x.ts') }));
  ok('a ação seguinte tira o erro', s.agents.get('a1').status === 'working');
}

// ── cada ferramenta acende o móvel do tipo dela ────────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const slot = s.agents.get('a1').slot;
  const room = seatOf(slot).room;

  const casos = [
    ['Read', deskProp('x.ts'), `posto${slot}|desk`],
    ['Skill', { kind: 'shelf', key: 'shelf', label: 'manuais' }, `sala${room}|shelf`],
    ['Grep', { kind: 'cabinet', key: 'cabinet', label: 'arquivo morto' }, `sala${room}|cabinet`],
    ['TodoWrite', { kind: 'whiteboard', key: 'whiteboard', label: 'quadro' }, `sala${room}|whiteboard`],
    ['Bash', { kind: 'terminal', key: 'terminal', label: 'terminal' }, 'terminal'],
    ['WebFetch', { kind: 'library', key: 'library', label: 'biblioteca' }, 'library'],
  ];
  for (const [tool, prop, chave] of casos) {
    const c = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool, prop }));
    ok(`${tool} acende ${chave}`, cmdsOf(c, 'prop-hit')[0]?.prop.key === chave,
       cmdsOf(c, 'prop-hit')[0]?.prop.key);
  }

  // Tipo sem casa própria cai na mesa do agente.
  const c = apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Coisa', prop: { kind: 'inexistente', key: 'k', label: 'k' } }));
  ok('tipo sem móvel próprio cai na mesa', cmdsOf(c, 'prop-hit')[0]?.prop.key === `posto${slot}|desk`);
}

// ── quadro e arquivo ficam na sala; terminal e biblioteca, no saguão ───────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const a = s.agents.get('a1');

  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'TodoWrite', prop: { kind: 'whiteboard', key: 'whiteboard', label: 'quadro' } }));
  ok('riscar o quadro não tira o robô da sala', insideRoom(a, seatOf(a.slot).room) && !a.away);

  apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  ok('usar o terminal leva o robô ao saguão', a.away && inLobby(a), `${a.wx},${a.wz}`);

  // A estação é singular: dois agentes usam a mesma, e não a duplicam.
  apply(s, evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }));
  apply(s, evt({ kind: 'tool_start', agentId: 'a2', agentType: 'Plan', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
  ok('a estação é uma só', [...s.props.values()].filter((p) => p.kind === 'terminal').length === 1);
  const [x, y] = [s.agents.get('a1'), s.agents.get('a2')];
  ok('dois no mesmo terminal não se sobrepõem', Math.hypot(x.wx - y.wx, x.wz - y.wz) >= 0.9);
  { const v = invariantsHold(s); ok('invariantes valem com dois no terminal', v.ok, v.detail); }
}

// ── ferramenta não deixa marca: 40 usos, mobília igual ────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }));
  const antes = [...s.props.keys()].sort().join(',');
  for (let i = 0; i < 40; i++) {
    apply(s, evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp(`f${i}.ts`) }));
  }
  ok('40 arquivos não criam móvel nenhum', [...s.props.keys()].sort().join(',') === antes);
  ok('mas o uso é contado', s.props.get(`posto${s.agents.get('a1').slot}|desk`).uses === 40);
}

// ── todo subagente entra pela porta; o principal nasce no posto ────────────
{
  const s = createScene();
  const c = apply(s, evt({ kind: 'spawn', agentId: 'sub', agentType: 'Explore' }));
  const entrada = cmdsOf(c, 'agent-enter')[0];
  ok('o subagente nasce na porta', Math.abs(entrada.wx - DOOR.wx) < 1e-9 && Math.abs(entrada.wz - DOOR.wz) < 1e-9);
  ok('e caminha de lá até o posto', legsOf(c).length >= 2);

  const cm = apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  const m = cmdsOf(cm, 'agent-enter')[0];
  ok('o principal nasce no posto dele', Math.abs(m.wx - seatHome(MAIN_SEAT).wx) < 1e-9);
}

// ── seis postos, três salas, dois por sala ────────────────────────────────
{
  ok('são três salas', ROOM_COUNT === 3);
  ok('são dois postos por sala', SEATS_PER_ROOM === 2);
  ok('são seis postos ao todo', SEAT_COUNT === 6);
  ok('há um posto por matiz da paleta', SEAT_COUNT === HUE_COUNT);

  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  for (let i = 0; i < SEAT_COUNT - 1; i++) apply(s, evt({ kind: 'spawn', agentId: 's' + i, agentType: 'Explore' }));
  ok('o escritório cheio tem seis agentes', s.agents.size === SEAT_COUNT);
  const salas = new Map();
  for (const a of s.agents.values()) salas.set(seatOf(a.slot).room, (salas.get(seatOf(a.slot).room) || 0) + 1);
  ok('as três salas ficam ocupadas', salas.size === ROOM_COUNT);
  ok('nenhuma sala passa de dois', [...salas.values()].every((n) => n === SEATS_PER_ROOM));
  { const v = invariantsHold(s); ok('invariantes valem com o escritório cheio', v.ok, v.detail); }

  // O sétimo divide posto — e não inventa sala nem andar.
  apply(s, evt({ kind: 'spawn', agentId: 'extra', agentType: 'Explore' }));
  const extra = s.agents.get('extra');
  ok('o sétimo cabe no escritório', seatOf(extra.slot).room < ROOM_COUNT);
  ok('e fica ao lado, não em cima', (() => {
    const outro = [...s.agents.values()].find((o) => o !== extra && seatOf(o.slot).room === seatOf(extra.slot).room && seatOf(o.slot).seat === seatOf(extra.slot).seat);
    return !outro || Math.hypot(extra.wx - outro.wx, extra.wz - outro.wz) >= 0.85;
  })());
}

// ── o posto do principal fica reservado e a vaga é reciclada ──────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'spawn', agentId: 'x', agentType: 'Explore' }));
  ok('o primeiro subagente pega o posto do principal enquanto ele não chega', s.agents.get('x').slot === MAIN_SEAT);

  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  ok('o principal toma o posto reservado', s.agents.get('main').slot === MAIN_SEAT);
  ok('e o subagente cede a vaga', s.agents.get('x').slot !== MAIN_SEAT);
  { const v = invariantsHold(s); ok('invariantes valem depois da cessão', v.ok, v.detail); }

  const antes = s.agents.get('x').slot;
  apply(s, evt({ kind: 'stop', agentId: 'x', agentType: 'Explore' }));
  apply(s, evt({ kind: 'spawn', agentId: 'y', agentType: 'Plan' }));
  ok('a vaga liberada é reciclada', s.agents.get('y').slot === antes);
  ok('e o principal continua no posto dele', s.agents.get('main').slot === MAIN_SEAT);
}

// ── ninguém anda no ar, ninguém corta caminho pela parede ─────────────────
{
  // A invariante que o pavimento único torna trivial de afirmar — e por isso
  // mesmo vale afirmar: `wy` é constante. Era a altura que fazia o robô parecer
  // subir pelo vazio quando havia escada.
  const s = createScene();
  const cmds = [];
  const push = (ev) => cmds.push(...apply(s, ev));
  push(evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  for (let i = 0; i < 4; i++) push(evt({ kind: 'spawn', agentId: 'p' + i, agentType: 'Explore' }));
  for (let i = 0; i < 4; i++) {
    push(evt({ kind: 'tool_start', agentId: 'p' + i, agentType: 'Explore', tool: 'Bash', prop: { kind: 'terminal', key: 'terminal', label: 'terminal' } }));
    push(evt({ kind: 'tool_end', agentId: 'p' + i, agentType: 'Explore' }));
    push(evt({ kind: 'tool_start', agentId: 'p' + i, agentType: 'Explore', tool: 'Read', prop: deskProp('a.ts') }));
  }
  push(evt({ kind: 'stop', agentId: 'p0', agentType: 'Explore' }));

  const pernas = legsOf(cmds);
  ok('há trajeto de sobra para conferir', pernas.length > 20, `${pernas.length} pernas`);
  ok('nenhuma perna sai do piso', pernas.every((l) => Math.abs(l.wy - FLOOR_Y) < 1e-9));

  // Toda perna termina dentro da planta: ninguém caminha para fora do escritório.
  const contorno = officeShape();
  const fora = pernas.filter((l) => !insideOutline(contorno, { wx: l.wx, wz: l.wz }));
  ok('nenhuma perna termina fora da planta', fora.length === 0, `${fora.length} fora`);

  // E nenhuma perna atravessa uma divisória entre salas: quem muda de sala passa
  // pelo corredor. Era o atalho na diagonal que se lia como robô cruzando parede.
  const cruza = (a, b, seg) => {
    const d = (p, q, r) => (q.wx - p.wx) * (r.wz - p.wz) - (q.wz - p.wz) * (r.wx - p.wx);
    const s1 = d(a, b, seg.a), s2 = d(a, b, seg.b), s3 = d(seg.a, seg.b, a), s4 = d(seg.a, seg.b, b);
    return ((s1 > 0) !== (s2 > 0)) && ((s3 > 0) !== (s4 > 0));
  };
  let anterior = new Map();
  let atravessou = 0;
  for (const l of pernas) {
    const de = anterior.get(l.id);
    if (de) for (const seg of partitions()) if (cruza(de, l, seg)) atravessou++;
    anterior.set(l.id, l);
  }
  ok('nenhuma perna atravessa uma divisória', atravessou === 0, `${atravessou} travessias`);

  // E nenhuma perna atravessa uma parede. Isto virou obrigatório quando o saguão
  // se afastou: a galeria é estreita, e o L simples de antes cortava a diagonal
  // por cima da parede dela — o robô entrava no saguão pelo lado de fora.
  let furou = 0;
  const culpadas = [];
  anterior = new Map();
  for (const l of pernas) {
    const de = anterior.get(l.id);
    if (de) {
      for (const seg of walls()) {
        if (cruza(de, l, seg)) {
          furou++;
          culpadas.push(`${l.id} ${de.wx.toFixed(1)},${de.wz.toFixed(1)}→${l.wx.toFixed(1)},${l.wz.toFixed(1)}`);
        }
      }
    }
    anterior.set(l.id, l);
  }
  ok('nenhuma perna atravessa uma parede', furou === 0, culpadas.slice(0, 4).join(' | '));

  // Quem troca de lado passa **por dentro** da galeria. A conta é no meio dela: toda
  // perna que cruza aquela profundidade tem de estar entre as duas paredes. O robô
  // não para na galeria — ele a atravessa —, então medir por ponto de parada não
  // enxergava a travessia; medir por cruzamento enxerga.
  const zMeio = (NECK.lz + LOBBY.lz) / 2;
  let travessias = 0;
  let porFora = 0;
  anterior = new Map();
  for (const l of pernas) {
    const de = anterior.get(l.id);
    if (de && (de.wz > zMeio) !== (l.wz > zMeio)) {
      travessias++;
      const t = (zMeio - de.wz) / (l.wz - de.wz);
      const x = de.wx + (l.wx - de.wx) * t;
      if (x < NECK_X0 - 1e-9 || x > NECK_X1 + 1e-9) porFora++;
    }
    anterior.set(l.id, l);
  }
  ok('há travessias entre os dois lados para conferir', travessias > 0, `${travessias}`);
  ok('toda travessia passa por dentro da galeria', porFora === 0, `${porFora} de ${travessias} por fora`);
  { const v = invariantsHold(s); ok('invariantes valem no fim da encenação', v.ok, v.detail); }
}

// ── reconstrução a partir do log (recarregar / trocar de sessão) ──────────
{
  const events = [
    evt({ kind: 'spawn', agentId: 'a1', agentType: 'Explore' }),
    evt({ kind: 'tool_start', agentId: 'a1', agentType: 'Explore', tool: 'Read', prop: deskProp('auth.ts') }),
    evt({ kind: 'spawn', agentId: 'a2', agentType: 'Plan' }),
    evt({ kind: 'stop', agentId: 'a1', agentType: 'Explore' }),
  ];
  const s = createScene();
  const cmds = rebuild(s, events);
  ok('reconstruir marca tudo como instantâneo', cmds.every((c) => c.instant));
  ok('reconstruir deixa só quem ficou', [...s.agents.keys()].join(',') === 'a2');
  ok('e a mobília continua inteira', s.props.size === fixedProps().length);
  { const v = invariantsHold(s); ok('invariantes valem no reconstruído', v.ok, v.detail); }
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

// ── a planta: três salas, um corredor e o saguão quadrado ─────────────────
{
  const shape = officeShape();
  ok('o contorno tem o estrangulamento da galeria', shape.length === 12, `${shape.length} pontos`);
  ok('a planta inteira está no piso', shape.every((p) => p.wy === FLOOR_Y));

  // O saguão avança para fora da fita das salas: é esse avanço que o faz ler como
  // entrada sem depender de rótulo. Sem ele a planta era um retângulo e a entrada
  // ficava sendo um canto qualquer.
  // O quanto o saguão avança para fora da fita das salas: a galeria inteira mais o
  // corpo dele. É esse avanço que o faz ler como entrada sem depender de rótulo.
  const fitaZ1 = ROOM_D + CORRIDOR_D;
  const avanco = Math.max(...shape.map((p) => p.wz)) - fitaZ1;
  ok('o saguão avança à frente das salas', avanco >= LOBBY_SIDE + NECK_D - 1e-9, `${avanco.toFixed(2)}`);
  ok('nenhuma quina da fita das salas passa da boca da galeria',
     shape.filter((p) => p.wx < LOBBY_X0 - 1e-9).every((p) => p.wz <= fitaZ1 + 1e-9));
  ok('o saguão é quadrado', Math.abs(LOBBY.w - LOBBY.d) < 1e-9);
  ok('o saguão é menor que uma sala', LOBBY.w * LOBBY.d < ROOM_W * ROOM_D);
  ok('o saguão fica centrado na planta', Math.abs((LOBBY_X0 + LOBBY_X1) / 2 - PLATE.x / 2) < 1e-9);

  // As três salas cabem lado a lado e não se invadem.
  for (let i = 0; i < ROOM_COUNT; i++) {
    const r = roomRect(i);
    ok(`a sala ${i} cabe na planta`, r.lx >= 0 && r.lx + r.w <= PLATE.x && r.lz >= 0 && r.lz + r.d <= ROOM_D);
    if (i > 0) {
      const ant = roomRect(i - 1);
      ok(`a sala ${i} não invade a ${i - 1}`, r.lx >= ant.lx + ant.w);
    }
  }

  // O corredor fica entre as salas e o saguão, e a faixa de caminhada dentro dele.
  ok('a faixa de caminhada fica dentro do corredor', LANE > ROOM_D && LANE < ROOM_D + CORRIDOR_D);

  // O saguão é separado e ligado por passagem: colado na fita das salas, ele se
  // lia como um recorte da mesma sala em vez de outro espaço.
  ok('o saguão fica afastado da fita das salas', LOBBY.lz - (ROOM_D + CORRIDOR_D) >= NECK_D - 1e-9,
     `${(LOBBY.lz - ROOM_D - CORRIDOR_D).toFixed(2)} de afastamento`);
  ok('a galeria liga o corredor ao saguão',
     Math.abs(NECK.lz - (ROOM_D + CORRIDOR_D)) < 1e-9 && Math.abs(NECK.lz + NECK.d - LOBBY.lz) < 1e-9);
  ok('a galeria é estreita', NECK_W < LOBBY_SIDE / 2, `${NECK_W} contra ${LOBBY_SIDE}`);
  ok('a galeria fica centrada com o saguão', Math.abs(NECK_CX - (LOBBY_X0 + LOBBY_X1) / 2) < 1e-9);
  ok('a boca da galeria cabe no fundo do saguão', NECK_X0 > LOBBY_X0 && NECK_X1 < LOBBY_X1);

  // A porta pisa na planta: fora dela, quem saía caminhava para o vazio.
  ok('a porta fica dentro da planta', insideOutline(shape, DOOR));
  ok('a porta fica no saguão', inLobby(DOOR, 0));
  ok('a porta fica na borda da frente', Math.abs(DOOR.wz - (PLATE.z - 1.0)) < 1e-9);
}

// ── as paredes fecham o que deve fechar e abrem o que deve abrir ──────────
{
  const ws = walls();
  ok('toda parede tem pé-direito desenhado', ws.every((w) => w.h === WALL_H));
  ok('toda parede começa e termina no piso', ws.every((w) => w.a.wy === FLOOR_Y && w.b.wy === FLOOR_Y));

  // As duas bocas da galeria ficam abertas: é por elas que se passa do corredor ao
  // saguão. Uma parede atravessada ali trancava o escritório e ninguém entrava.
  const atravessa = (z) => ws.filter((w) =>
    Math.abs(w.a.wz - z) < 1e-9 && Math.abs(w.b.wz - z) < 1e-9 &&
    Math.max(w.a.wx, w.b.wx) > NECK_X0 + 1e-9 && Math.min(w.a.wx, w.b.wx) < NECK_X1 - 1e-9);
  ok('a boca da galeria no corredor fica aberta', atravessa(NECK.lz).length === 0);
  ok('a boca da galeria no saguão fica aberta', atravessa(LOBBY.lz).length === 0);
  // E as duas paredes da galeria existem: sem elas ela não é passagem, é vão.
  const laterais = ws.filter((w) => Math.abs(w.a.wx - w.b.wx) < 1e-9 &&
    (Math.abs(w.a.wx - NECK_X0) < 1e-9 || Math.abs(w.a.wx - NECK_X1) < 1e-9));
  ok('a galeria tem as duas paredes', laterais.length === 2, `${laterais.length}`);

  // A frente do saguão também: é onde fica a porta.
  const naFrente = ws.filter((w) => Math.abs(w.a.wz - PLATE.z) < 1e-9 && Math.abs(w.b.wz - PLATE.z) < 1e-9);
  ok('a frente do saguão fica aberta', naFrente.length === 0);

  // As divisórias vão do fundo até a boca do corredor, e não entram nele: sala se
  // sai pela frente, e divisória avançando no corredor fechava a saída.
  const ps = partitions();
  ok('há uma divisória entre salas vizinhas', ps.length === ROOM_COUNT - 1);
  ok('a divisória para na boca do corredor', ps.every((w) => Math.max(w.a.wz, w.b.wz) <= ROOM_D + 1e-9));
  ok('a divisória é mais baixa que a parede', ps.every((w) => w.h <= WALL_H));
}

// ── cada móvel assenta no lugar dele ──────────────────────────────────────
{
  const todos = fixedProps();
  const shape = officeShape();
  ok('todo móvel assenta no piso', todos.every((p) => p.wy === FLOOR_Y));
  ok('todo móvel fica dentro da planta', todos.every((p) => insideOutline(shape, p)));

  // Nenhum móvel em cima de outro — nem entre salas diferentes.
  let colados = 0;
  for (let i = 0; i < todos.length; i++) {
    for (let j = i + 1; j < todos.length; j++) {
      if (Math.hypot(todos[i].wx - todos[j].wx, todos[i].wz - todos[j].wz) < 1.5) colados++;
    }
  }
  ok('nenhum par de móveis se sobrepõe', colados === 0, `${colados} pares colados`);

  // A mesa de cada posto é a mesa daquele posto, e fica na sala daquele posto.
  for (let slot = 0; slot < SEAT_COUNT; slot++) {
    const d = deskOf(slot);
    ok(`a mesa do posto ${slot} fica na sala ${seatOf(slot).room}`, insideRoom(d, seatOf(slot).room, 0.3));
    // E o lugar de trabalho fica à frente dela, não dentro dela.
    const h = seatHome(slot);
    ok(`o posto ${slot} fica à frente da mesa`, h.wz > d.wz && insideRoom(h, seatOf(slot).room));
  }

  // As estações são do saguão, e as duas ficam afastadas uma da outra.
  const est = todos.filter((p) => p.station);
  ok('há duas estações', est.length === 2);
  ok('as estações ficam no saguão', est.every((p) => inLobby(p, 0)));
  ok('as duas estações não se encostam', Math.hypot(est[0].wx - est[1].wx, est[0].wz - est[1].wz) >= 3);

  // Quem usa uma estação fica de frente para ela, dentro do saguão.
  for (const st of est) {
    for (let rank = 0; rank < 3; rank++) {
      const p = stationStand(st, rank);
      ok(`o lugar ${rank} da estação ${st.kind} fica no saguão`, inLobby(p, 0.2), `${p.wx.toFixed(1)},${p.wz.toFixed(1)}`);
    }
  }
}

// ── o robô sabe onde a mobília está, e a contorna ─────────────────────────
{
  // A planta cresceu 1,7× e o móvel não: é a folga que sobra que paga o desvio.
  ok('a planta está na escala nova', SCALE === 1.7);
  ok('a sala cresceu junto', Math.abs(ROOM_W - 8 * SCALE) < 1e-9 && Math.abs(ROOM_D - 8 * SCALE) < 1e-9);

  const caixas = obstacles();
  const dentro = (q, c) => q.wx > c.x0 && q.wx < c.x1 && q.wz > c.z0 && q.wz < c.z1;

  // Toda pegada tem tamanho, e nenhuma cobre mais que um quinto da sala: uma
  // pegada inflada faria o robô contornar o ar e o desvio pareceria capricho.
  ok('todo móvel tem pegada', fixedProps().every((q) => PROP_FOOT[q.kind]));
  const grande = caixas.filter((c) => (c.x1 - c.x0) * (c.z1 - c.z0) > (ROOM_W * ROOM_D) / 5);
  ok('nenhuma pegada engole a sala', grande.length === 0, `${grande.length} grandes`);

  // Nenhuma pegada de sala invade o corredor nem a divisória vizinha.
  const daSala = fixedProps().filter((q) => !q.station && q.kind !== 'door');
  const vazadas = daSala.filter((q) => {
    const f = footprint(q, 0);
    const sala = Math.floor(q.wx / ROOM_W);
    return f.x0 < sala * ROOM_W || f.x1 > (sala + 1) * ROOM_W || f.z0 < 0 || f.z1 > ROOM_D;
  });
  ok('nenhuma pegada vaza da sala', vazadas.length === 0, vazadas.map((q) => q.key).join(', '));

  // Onde alguém fica em pé nunca cai dentro de um móvel — nem o posto, nem o
  // lugar de usar uma estação. Era 1,5 fixo à frente da mesa, e com a mesa de 2,3
  // de fundo o robô parava dentro da própria cadeira.
  const paradas = [];
  for (let slot = 0; slot < SEAT_COUNT; slot++) paradas.push({ nome: `posto ${slot}`, p: seatHome(slot) });
  for (const st of Object.values(STATIONS)) {
    for (let r = 0; r < 3; r++) paradas.push({ nome: `estação ${st.label} ${r}`, p: stationStand(st, r) });
  }
  const presas = paradas.filter(({ p }) => caixas.some((c) => dentro(p, c)));
  ok('ninguém fica em pé dentro de um móvel', presas.length === 0, presas.map((x) => x.nome).join(', '));

  // E o crivo que interessa: nenhum trajeto entre dois lugares de parada corta a
  // pegada de móvel nenhum. É a asserção que impede o robô de voltar a atravessar
  // a mesa como se ela fosse fumaça.
  const corta = (a, b, c) => {
    if (dentro(a, c) || dentro(b, c)) return false;
    let t0 = 0;
    let t1 = 1;
    for (const [p0, d, lo, hi] of [[a.wx, b.wx - a.wx, c.x0, c.x1], [a.wz, b.wz - a.wz, c.z0, c.z1]]) {
      if (Math.abs(d) < 1e-9) {
        if (p0 <= lo || p0 >= hi) return false;
        continue;
      }
      let e = (lo - p0) / d;
      let f = (hi - p0) / d;
      if (e > f) [e, f] = [f, e];
      t0 = Math.max(t0, e);
      t1 = Math.min(t1, f);
      if (t0 >= t1) return false;
    }
    return true;
  };

  const pontos = [...paradas, { nome: 'porta', p: DOOR }];
  let atropelos = 0;
  let pares = 0;
  const exemplos = [];
  for (const A of pontos) {
    for (const B of pontos) {
      if (A === B) continue;
      pares++;
      let de = A.p;
      for (const q of route(A.p, B.p)) {
        for (const c of caixas) {
          if (corta(de, q, c)) {
            atropelos++;
            exemplos.push(`${A.nome}→${B.nome} em ${c.key}`);
          }
        }
        de = q;
      }
    }
  }
  ok('há trajetos de sobra para conferir', pares > 100, `${pares} pares`);
  ok('nenhum trajeto passa por dentro de um móvel', atropelos === 0, exemplos.slice(0, 3).join(' | '));

  // O desvio não pode inventar chão: todo ponto do trajeto cai num retângulo livre.
  const livres = freeRects();
  let noVazio = 0;
  for (const A of pontos) {
    for (const q of route(A.p, DOOR)) {
      if (!livres.some((r) => q.wx >= r.x0 - 0.31 && q.wx <= r.x1 + 0.31 && q.wz >= r.z0 - 0.31 && q.wz <= r.z1 + 0.31)) noVazio++;
    }
  }
  ok('nenhum desvio cai fora do piso', noVazio === 0, `${noVazio} pontos`);

  // E o desvio é desvio, não passeio: contornar um móvel custa poucas pernas.
  const longos = pontos.filter((A) => route(A.p, DOOR).length > 9);
  ok('o desvio não vira passeio', longos.length === 0, longos.map((x) => x.nome).join(', '));

  ok('a folga do desvio cabe um robô', BODY >= 0.5 && BODY <= 1);
}

// ── a caixa do escritório é constante ─────────────────────────────────────
{
  // Sem andares, o prédio não muda de tamanho durante a sessão — e foi isso que
  // parou o enquadramento de saltar a cada agente que entrava.
  const vazio = buildingBounds();
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  for (let i = 0; i < SEAT_COUNT; i++) apply(s, evt({ kind: 'spawn', agentId: 'q' + i, agentType: 'Explore' }));
  const cheio = buildingBounds();
  ok('a caixa não muda com o escritório cheio', JSON.stringify(vazio) === JSON.stringify(cheio));
  ok('a caixa cobre a planta inteira',
     cheio.min.x <= 0 && cheio.max.x >= PLATE.x && cheio.min.z <= 0 && cheio.max.z >= PLATE.z);
  ok('a caixa vai do piso ao topo da parede', cheio.min.y === FLOOR_Y && cheio.max.y === FLOOR_Y + WALL_H);
}

// ── o agente é nomeado pela tarefa que o convocou ─────────────────────────
{
  // `general-purpose` não nomeia ninguém: três deles na planta e ninguém sabe quem
  // é quem. A descrição do `Task` é que diz o que aquele agente veio fazer.
  ok('o apelido tira as palavras de ligação', apelido('mapear todos os handlers de auth') === 'mapear handlers',
     apelido('mapear todos os handlers de auth'));
  ok('o apelido cabe numa plaqueta', apelido('medir o custo das consultas repetidas de sessão') === 'medir custo');
  ok('o apelido funciona em inglês', apelido('Review the changes on this branch') === 'review changes');
  ok('sem descrição não há apelido', apelido(null) === null && apelido('') === null);
  ok('descrição só de ligação não vira apelido', apelido('de o a') === null);
  ok('o apelido não estoura o tamanho', (apelido('supercalifragilisticoexpialidoso extraordinariamente') || '').length <= 24);

  const s = createScene();
  apply(s, evt({ kind: 'tool_start', agentId: 'main', agentType: 'main', tool: 'Task',
                 text: 'mapear todos os handlers de auth',
                 prop: { kind: 'door', key: 'door', label: 'porta' } }));
  apply(s, evt({ kind: 'spawn', agentId: 'f1', agentType: 'general-purpose' }));
  ok('o filho convocado herda o nome da tarefa', s.agents.get('f1').name === 'mapear handlers',
     s.agents.get('f1').name);
  ok('e o tipo continua lá, como legenda', s.agents.get('f1').type === 'general-purpose');

  // A convocação é consumida: o próximo a entrar sem `Task` não rouba o nome.
  apply(s, evt({ kind: 'spawn', agentId: 'f2', agentType: 'general-purpose' }));
  ok('a convocação tem um dono só', !s.agents.get('f2').name);
}

// ── os seis matizes giram pela paleta ─────────────────────────────────────
{
  // O rosa é o sexto. Com o índice vindo de `agents.size % 6`, ele só existiria com
  // cinco subagentes vivos ao mesmo tempo — e o índice 0 nunca saía, porque o
  // principal contava no tamanho.
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  apply(s, evt({ kind: 'spawn', agentId: 'a', agentType: 'Explore' }));
  ok('o primeiro subagente pega o primeiro matiz', s.agents.get('a').hueIndex === 0);

  // Entra e sai, seis vezes: os seis matizes aparecem, mesmo com um vivo por vez.
  const vistos = new Set([0]);
  for (let i = 1; i < HUE_COUNT + 2; i++) {
    apply(s, evt({ kind: 'stop', agentId: 'x' + (i - 1), agentType: 'Explore' }));
    apply(s, evt({ kind: 'spawn', agentId: 'x' + i, agentType: 'Explore' }));
    vistos.add(s.agents.get('x' + i).hueIndex);
  }
  ok('os seis matizes aparecem ao longo da sessão', vistos.size === HUE_COUNT, [...vistos].sort().join(','));
  ok('o rosa é o sexto e existe', vistos.has(HUE_COUNT - 1));
}

// ── a paleta dos subagentes, com o rosa (issue #17) ────────────────────────
{
  const s = createScene();
  apply(s, evt({ kind: 'prompt', agentId: 'main', agentType: 'main', text: 'vai' }));
  ok('o principal não tira matiz da paleta', s.agents.get('main').hueIndex === -1);

  // Seis subagentes vivos ao mesmo tempo recebem os seis matizes, sem repetir.
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

// ── o terreno cobre o escritório inteiro ──────────────────────────────────
{
  const t = terrainRect();
  const b = buildingBounds();
  ok('o terreno fica abaixo do piso', t.y < FLOOR_Y);
  ok('o terreno cobre a pegada do escritório, com folga',
     t.x0 <= b.min.x - TERRAIN_MARGIN + 1e-9 && t.x1 >= b.max.x + TERRAIN_MARGIN - 1e-9 &&
     t.z0 <= b.min.z - TERRAIN_MARGIN + 1e-9 && t.z1 >= b.max.z + TERRAIN_MARGIN - 1e-9);
  ok('a porta fica sobre o terreno',
     DOOR.wx > t.x0 && DOOR.wx < t.x1 && DOOR.wz > t.z0 && DOOR.wz < t.z1);
  // A folga é fina de propósito: um pátio largo de terra fazia o escritório
  // parecer perdido no lote, e o olho ia para a grama em vez de ir para dentro.
  ok('a folga em volta é fina', TERRAIN_MARGIN <= 5);
}

// ── a paleta colorida ainda deixa achar o agente (ADR-0004) ────────────────
{
  // A invariante "desenho frio, gente quente" foi revogada: o prédio é colorido. O
  // que substitui o atalho de leitura é distância de matiz e diferença de valor —
  // e é isso que estas asserções seguram. Pintar uma parede da cor de um robô
  // reprova aqui.
  const MIN_ENTRE_AGENTES = 24;
  const MIN_DO_FUNDO = 20;

  ok('a paleta tem seis matizes de agente', AGENT_HUES.length === HUE_COUNT);

  for (let i = 0; i < AGENT_HUES.length; i++) {
    for (let j = i + 1; j < AGENT_HUES.length; j++) {
      const d = hueGap(AGENT_HUES[i], AGENT_HUES[j]);
      ok(`agentes ${AGENT_HUES[i]} e ${AGENT_HUES[j]} se distinguem`, d >= MIN_ENTRE_AGENTES, `${d}°`);
    }
  }

  for (const h of AGENT_HUES) {
    for (const fundo of BACKDROP) {
      // Cinza não tem matiz que dispute: o que separa o robô ali é o valor.
      if (fundo.s < 0.12) continue;
      const d = hueGap(h, fundo.h);
      ok(`agente ${h} se separa do fundo ${fundo.h}`, d >= MIN_DO_FUNDO, `${d}°`);
    }
  }

  ok('nenhum agente se confunde com o rosto de erro',
     AGENT_HUES.every((h) => hueGap(h, ERROR_HUE) >= 6), AGENT_HUES.map((h) => hueGap(h, ERROR_HUE)).join(','));

  // Valor, na direção Sumida (ADR-0006): a regra inverteu. O fundo é escuro e quem
  // emite é quem se lê — então toda superfície grande fica abaixo de 30% de luz, e
  // o que é luz fica acima de 55%. Sem este par de asserções, uma parede clarinha
  // entra sem ninguém notar e apaga o robô que passa na frente dela.
  const AREA = ['wall', 'floorA', 'floorB', 'slab', 'terrain', 'sidewalk'];
  for (const k of AREA) ok(`a superfície ${k} é escura`, BUILDING[k].l <= 0.30, `${BUILDING[k].l}`);
  ok('a fita de néon é luz', BUILDING.wallTrim.l >= 0.55);
  ok('o vidro aceso é luz', PROPS.screenLit.l >= 0.55);
  ok('o vidro apagado não é luz', PROPS.screen.l <= 0.25);
  ok('o saguão tem piso de cor própria',
     BUILDING.floorA.l !== BUILDING.floorB.l || BUILDING.floorA.h !== BUILDING.floorB.h);

  // E a carcaça do robô, no valor em que é desenhada, tem de bater o fundo por
  // margem de luz — é isso que o olho usa quando o matiz não basta.
  for (const fundo of BACKDROP) {
    ok(`o robô se separa de ${fundo.h} por valor`, SHELL_L - fundo.l >= 0.25,
       `${(SHELL_L - fundo.l).toFixed(2)}`);
  }

  // Cada tipo de móvel tem cor própria: com mobília fixa, é a cor que distingue de
  // longe. Nenhum par de tipos pode ter o mesmo matiz saturado.
  const tipos = ['desk', 'shelf', 'terminal', 'library', 'whiteboard', 'cabinet'];
  for (const t of tipos) ok(`o móvel ${t} tem cor na paleta`, !!PROPS[t]);
  const saturados = tipos.map((t) => PROPS[t]).filter((c) => c.s >= 0.2);
  for (let i = 0; i < saturados.length; i++) {
    for (let j = i + 1; j < saturados.length; j++) {
      ok(`móveis ${saturados[i].h} e ${saturados[j].h} se distinguem`, hueGap(saturados[i].h, saturados[j].h) >= 14,
         `${hueGap(saturados[i].h, saturados[j].h)}°`);
    }
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

// ── os sete móveis têm volume próprio (issue #12) ─────────────────────────
{
  // O volume mora no renderizador, que não roda em Node — então a asserção é
  // sobre a fonte: cada tipo que o `propFor` produz precisa ter um caso no
  // construtor, senão ele cai calado na mesa e dois tipos viram o mesmo móvel.
  const fonte = readFileSync(new URL('./public/office.js', import.meta.url), 'utf8');
  const tipos = ['desk', 'shelf', 'terminal', 'library', 'whiteboard', 'cabinet', 'door'];
  ok('há um construtor único de volume de móvel', /function propVolume\(/.test(fonte));
  for (const t of tipos) {
    ok(`o móvel ${t} tem material próprio`, new RegExp(`^  ${t}: \\(\\) =>`, 'm').test(fonte));
  }
  for (const t of tipos.filter((k) => k !== 'desk')) {
    ok(`o móvel ${t} tem volume próprio`, new RegExp(`case '${t}':`).test(fonte));
  }
  // A mesa é o padrão: ela é o `default`, e é isso que faz tipo sem móvel cair nela.
  ok('a mesa é o volume padrão', /default:\n\s+\/\/ mesa:/.test(fonte));
}

// ── resultado ─────────────────────────────────────────────────────────────
console.log();
if (fails.length) {
  for (const f of fails) console.log('  ✖ ' + f);
  console.log(`\n  ${pass} passaram, ${fails.length} falharam\n`);
  process.exit(1);
}
console.log(`  ✔ ${pass} verificações passaram\n`);
