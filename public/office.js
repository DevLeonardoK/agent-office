// Renderizador do escritório: DOM + SVG, animado com motion.dev.
//
// Toda a lógica de posicionamento mora em scene.mjs. Aqui só se decide como
// cada comando da cena vira pixel e movimento.

import { animate, stagger } from './vendor/motion.js';
import {
  createScene, apply, rebuild, PLAN, DOOR, STATIONS, ROOMS_PER_FLOOR,
  roomRect, roomQuad, floorRect, buildingRect, floorCount, depth,
  SHAFT, shaftRect, cabinRect, cabinBox, iso, TILE, PLATE, GROUND_FLOOR, GROUND_PLATE,
} from './scene.mjs';

const params = new URLSearchParams(location.search);

// Carimbo do desenho carregado. Suba isto quando o desenho mudar de forma —
// é o que distingue "não mudou" de "o navegador está com o arquivo velho".
const BUILD = 'isométrico · trajeto';

// `instant` despeja o roteiro de uma vez; sem cortar as animações, o resultado
// seria um congelado com todo mundo no meio do caminho.
const STILL = params.has('instant') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const REDUCED = STILL;

// Springs: a mesma massa para todo mundo, para a cena ter um "peso" coerente.
// Ritmo do prédio. O robô é uma máquina pesada de esteira, não um cursor: ele
// arranca devagar e assenta no destino. Rígido demais e a cena vira pisca-pisca
// — a sessão real dispara ferramentas em rajada, e é a lentidão que deixa o
// olho acompanhar quem foi para onde.
const WALK = STILL ? { duration: 0 } : { type: 'spring', stiffness: 16, damping: 17, mass: 1.6 };
const POP = STILL ? { duration: 0 } : { type: 'spring', stiffness: 180, damping: 20 };

const el = (id) => document.getElementById(id);
const $stage = el('stage');
const $plan = el('plan');
const $props = el('props');
const $agents = el('agents');
const $doors = el('doors');
const $blueprint = el('blueprint');
const $rooms = el('rooms');
const $follow = el('follow');
const $dot = el('dot');
const $statusText = el('statusText');
const $castList = el('castList');
const $castCount = el('castCount');
const $logList = el('logList');
const $logCount = el('logCount');
const $empty = el('empty');
const $app = el('app');
el('build').textContent = BUILD;

// ── estado do cliente ─────────────────────────────────────────────────────

const scene = createScene();
const nodes = new Map();      // agentId -> {root, name, tool, bubbleTimer}
const propNodes = new Map();  // propKey -> {root, timer}
const rooms = new Map();
let currentRoom = null;
let roomActivity = 0;
let logged = 0;

// Cinco matizes quentes contra o azul técnico do prédio. O agente principal
// não usa nenhuma delas — ele é claro, de outro material.
const HUES = [38, 8, 165, 262, 328];
const hueOf = (a) => (a.isMain ? 0 : HUES[a.hueIndex % HUES.length]);

// O rosto do robô: olhos apertados trabalhando, X numa falha de ferramenta,
// olhos abertos no resto. É o que a tela-rosto mostra.
const moodOf = (a) => (a.status === 'working' ? 'work' : a.status === 'error' ? 'error' : 'idle');

// ── a planta ──────────────────────────────────────────────────────────────

// Desenha o prédio isométrico: uma plataforma de ladrilhos por andar, empilhadas
// sobre o térreo de serviço. A geometria toda vem projetada do scene.mjs — aqui
// só se decide traço, opacidade e ordem de desenho.
//
// Minimalista de propósito: ladrilho é linha fina, parede é um plano só, e o
// preenchimento existe apenas para separar piso de parede. Nada de textura.
const NS = 'http://www.w3.org/2000/svg';
const WALL_H = 96;                     // pé-direito desenhado atrás da plataforma

function drawBlueprint(floors) {
  $blueprint.replaceChildren();
  const add = (tag, attrs, parent = $blueprint) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };
  const poly = (pts, attrs, parent = $blueprint) => add('path', { d: 'M' + pts.map((p) => `${p.x} ${p.y}`).join('L') + 'Z', ...attrs }, parent);
  const line = (a, b, o = .5, w = 1) =>
    add('path', { d: `M${a.x} ${a.y}L${b.x} ${b.y}`, stroke: 'var(--draft)', 'stroke-width': w, opacity: o });
  const label = (at, text, o = .45, size = 10) => {
    const t = add('text', {
      x: at.x, y: at.y, fill: 'var(--draft)', opacity: o,
      'font-family': 'var(--mono)', 'font-size': size, 'letter-spacing': 2.6, 'text-anchor': 'middle',
    });
    t.textContent = text;
  };

  // Gradiente arco-íris do agente principal. Vive aqui, no SVG da planta, mas a
  // carcaça do robô o referencia por id de qualquer outro SVG do documento.
  const defs = add('defs', {});
  const grad = add('linearGradient', { id: 'agentRainbow', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
  for (const [off, col] of [['0', 'hsl(0 80% 62%)'], ['.2', 'hsl(32 85% 60%)'], ['.4', 'hsl(52 85% 58%)'],
                            ['.6', 'hsl(145 60% 52%)'], ['.8', 'hsl(210 70% 58%)'], ['1', 'hsl(280 60% 64%)']]) {
    add('stop', { offset: off, 'stop-color': col }, grad);
  }

  // Uma plataforma: as duas paredes do fundo, o piso ladrilhado e a espessura
  // da laje. Desenhada de trás para a frente, que é a ordem que se sobrepõe.
  const platform = (floor, tx, ty, opts = {}) => {
    const c = { back: iso(0, 0, floor), right: iso(tx, 0, floor), front: iso(tx, ty, floor), left: iso(0, ty, floor) };

    // paredes: dois planos verticais, subindo do fundo
    const up = (p) => ({ x: p.x, y: p.y - WALL_H });
    poly([c.left, c.back, up(c.back), up(c.left)], { fill: 'var(--wall)', stroke: 'var(--draft)', 'stroke-width': .8, opacity: .9 });
    poly([c.back, c.right, up(c.right), up(c.back)], { fill: 'var(--wall-2)', stroke: 'var(--draft)', 'stroke-width': .8, opacity: .9 });

    // piso
    poly([c.back, c.right, c.front, c.left], { fill: 'var(--floor)', stroke: 'var(--draft)', 'stroke-width': 1.1, opacity: .95 });

    // ladrilhos: as duas famílias de linhas do losango
    for (let i = 1; i < tx; i++) line(iso(i, 0, floor), iso(i, ty, floor), .1);
    for (let j = 1; j < ty; j++) line(iso(0, j, floor), iso(tx, j, floor), .1);

    // espessura da laje: o que dá o degrau entre um andar e o de baixo
    const drop = (p) => ({ x: p.x, y: p.y + 14 });
    poly([c.left, c.front, drop(c.front), drop(c.left)], { fill: 'var(--slab)', stroke: 'var(--draft)', 'stroke-width': .8, opacity: .95 });
    poly([c.front, c.right, drop(c.right), drop(c.front)], { fill: 'var(--slab-2)', stroke: 'var(--draft)', 'stroke-width': .8, opacity: .95 });

    if (opts.label) label(up(iso(tx / 2, 0, floor)), opts.label, .4);
    return c;
  };

  // ── o poço do elevador ──────────────────────────────────────────────────
  // Desenhado antes das plataformas: ele passa por trás do prédio, e é o que
  // faz a cabine parecer correr dentro da estrutura em vez de sobre ela.
  const shaftRails = (floors_) => {
    const topF = floors_ - 1;
    const a = iso(SHAFT.wx, SHAFT.wy, topF);
    const b = iso(SHAFT.wx + SHAFT.w, SHAFT.wy, topF);
    const c = iso(SHAFT.wx + SHAFT.w, SHAFT.wy, GROUND_FLOOR);
    const d2 = iso(SHAFT.wx, SHAFT.wy, GROUND_FLOOR);
    poly([{ x: a.x, y: a.y - WALL_H }, { x: b.x, y: b.y - WALL_H }, c, d2],
         { fill: 'var(--wall-2)', 'fill-opacity': .7, stroke: 'var(--draft)', 'stroke-width': 1, opacity: .45 });
    label({ x: (a.x + b.x) / 2, y: a.y - WALL_H - 12 }, 'ELEVADOR', .4, 8);
  };
  shaftRails(floors);

  // Térreo de serviço primeiro: ele fica atrás e embaixo de tudo.
  platform(GROUND_FLOOR, GROUND_PLATE.x, GROUND_PLATE.y, { label: 'TÉRREO DE SERVIÇO' });

  // A porta do prédio, na quina de quem chega de fora.
  const d = DOOR;
  add('path', {
    d: `M${d.x - 16} ${d.y}l16 -8 16 8`, fill: 'none',
    stroke: 'var(--draft)', 'stroke-width': 1.2, opacity: .6, 'stroke-dasharray': '3 4',
  });
  label({ x: d.x, y: d.y + 22 }, 'PORTA', .34, 8);

  // As quatro estações, no chão do térreo: um losango marcado e o nome.
  for (const st of Object.values(STATIONS)) {
    const q = [iso(st.wx - .6, st.wy - .6, GROUND_FLOOR), iso(st.wx + .6, st.wy - .6, GROUND_FLOOR),
               iso(st.wx + .6, st.wy + .6, GROUND_FLOOR), iso(st.wx - .6, st.wy + .6, GROUND_FLOOR)];
    poly(q, { fill: 'var(--draft)', 'fill-opacity': .07, stroke: 'var(--draft)', 'stroke-width': .9, opacity: .55 });
  }

  // Os andares, de baixo para cima.
  for (let f = 0; f < floors; f++) {
    platform(f, PLATE.x, PLATE.y, { label: `${f + 1}º ANDAR` });

    // divisórias entre os cinco cômodos: uma linha só, do fundo à frente
    for (let i = 1; i < ROOMS_PER_FLOOR; i++) {
      const wx = (PLATE.x / ROOMS_PER_FLOOR) * i;
      line(iso(wx, 0, f), iso(wx, PLATE.y, f), .26, 1);
    }
  }

  // A cabine por último: ela corre dentro do poço, mas tem de ser vista. Caixa
  // isométrica como o resto do prédio — um retângulo chapado aqui saltaria aos
  // olhos como erro de desenho.
  const box = cabinBox(GROUND_FLOOR);
  const [bk, rt, ft, lf] = box.floor;
  const up = (p) => ({ x: p.x, y: p.y - box.h });
  $cabin = add('g', { class: 'cabin' });
  poly([lf, ft, up(ft), up(lf)], { fill: 'var(--ink)', stroke: 'var(--draft)', 'stroke-width': 1.1, opacity: .95 }, $cabin);
  poly([ft, rt, up(rt), up(ft)], { fill: 'var(--slab-2)', stroke: 'var(--draft)', 'stroke-width': 1.1, opacity: .95 }, $cabin);
  poly([up(bk), up(rt), up(ft), up(lf)], { fill: 'var(--slab)', stroke: 'var(--draft)', 'stroke-width': 1, opacity: .95 }, $cabin);
  add('path', { d: `M${ft.x} ${ft.y}L${ft.x} ${ft.y - box.h}`, stroke: 'var(--draft)', 'stroke-width': .8, opacity: .5 }, $cabin);
  cabinAt = GROUND_FLOOR;
}


// Leva a cabine ao andar pedido (-1 é o térreo). O robô viaja junto: a perna
// `ride` do trajeto dele tem a mesma duração.
let $cabin = null;
let cabinAt = -1;

function moveCabin(floor, instant) {
  if (!$cabin || floor === cabinAt) return;
  cabinAt = floor;
  const dy = cabinRect(floor).y - cabinRect(GROUND_FLOOR).y;
  // A cabine espera a fila do prédio: ela sai quando o robô já embarcou. Uma
  // cabine que parte antes do passageiro é o tipo de detalhe que faz a cena
  // parecer quebrada mesmo quando as posições estão certas.
  const go = () => animate($cabin, { y: dy }, REDUCED || instant ? { duration: 0 } : { duration: RIDE_SECONDS, ease: [0.4, 0, 0.2, 1] });
  if (instant || REDUCED) { go(); return; }
  setTimeout(go, 520);
}

// ── símbolos de planta para cada móvel ────────────────────────────────────

// Desenhados como em planta baixa: visto de cima, contorno fino. A mesa tem
// o arco da cadeira; a estante, as prateleiras; o arquivo, as gavetas.
const SYMBOL = {
  desk: `<rect class="sym-fill" x="14" y="12" width="48" height="26"/><rect class="sym" x="14" y="12" width="48" height="26"/>
         <path class="sym" d="M30 44a8 8 0 0 1 16 0"/><path class="sym" d="M31 44h14"/>`,
  terminal: `<rect class="sym-fill" x="10" y="10" width="56" height="30"/><rect class="sym" x="10" y="10" width="56" height="30"/>
         <path class="sym" d="M18 18h40M18 24h40M18 30h26" opacity=".55"/><path class="sym" d="M26 46h24"/>`,
  cabinet: `<rect class="sym-fill" x="18" y="8" width="40" height="42"/><rect class="sym" x="18" y="8" width="40" height="42"/>
         <path class="sym" d="M18 22h40M18 36h40"/><path class="sym" d="M34 15h8M34 29h8M34 43h8"/>`,
  library: `<rect class="sym-fill" x="12" y="10" width="52" height="38"/><rect class="sym" x="12" y="10" width="52" height="38"/>
         <path class="sym" d="M12 29h52"/><path class="sym" d="M20 10v19M30 10v19M42 29v19M52 29v19"/>`,
  shelf: `<rect class="sym-fill" x="16" y="8" width="44" height="42"/><rect class="sym" x="16" y="8" width="44" height="42"/>
         <path class="sym" d="M16 24h44M16 38h44"/>`,
  whiteboard: `<path class="sym" d="M8 12h60"/><rect class="sym-fill" x="12" y="14" width="52" height="30"/>
         <rect class="sym" x="12" y="14" width="52" height="30"/><path class="sym" d="M20 24h22M20 32h34" opacity=".55"/>`,
  door: `<path class="sym" d="M20 46V12"/><path class="sym" d="M20 12a34 34 0 0 1 34 34" stroke-dasharray="3 4" opacity=".6"/>`,
};

function mountProp(prop, instant) {
  const node = document.createElement('div');
  node.className = 'prop';
  node.innerHTML =
    `<svg width="76" height="56" viewBox="0 0 76 56">${SYMBOL[prop.kind] || SYMBOL.desk}</svg>` +
    `<span class="prop-label"></span>`;
  // Só a estação leva rótulo na planta. A mobília do cômodo é genérica e igual
  // em todos os cômodos: escrever "mesa" cinco vezes por andar era só ruído.
  node.querySelector('.prop-label').textContent = prop.fixed ? prop.label : '';
  node.title = prop.detail || prop.label;
  $props.appendChild(node);
  propNodes.set(prop.key, { root: node, timer: 0 });

  // A posição tem que entrar pela motion: ela compõe o `transform` a partir de
  // x/y/scale e sobrescreveria qualquer translate escrito na mão.
  animate(node, { x: prop.x, y: prop.y }, { duration: 0 });
  // Na reconstrução o móvel já nasce no lugar; ao vivo ele surge com um pop.
  node.style.opacity = '1';
  if (!instant) animate(node, { scale: [0.82, 1] }, POP);
  return node;
}

function hitProp(prop, instant, subject) {
  const n = propNodes.get(prop.key);
  if (!n) return;
  // O móvel é fixo e genérico; o que passa por ele agora fica no title, para
  // quem quiser saber sem ir ao registro.
  n.root.title = [prop.label, subject, prop.detail].filter(Boolean).join(' · ');
  if (instant) return;   // reacender cada uso do log de uma vez seria só ruído
  n.root.classList.add('hit');
  clearTimeout(n.timer);
  n.timer = setTimeout(() => n.root.classList.remove('hit'), 2600);
}

// O móvel segue o dono quando ele muda de cômodo (realocação da issue #7).
function moveProp(prop, instant) {
  const n = propNodes.get(prop.key);
  if (!n) return;
  animate(n.root, { x: prop.x, y: prop.y }, instant ? { duration: 0 } : WALK);
}

// O móvel some quando o dono deixa o prédio: o cômodo é esvaziado para o
// próximo que reciclar a vaga.
function removeProp(key) {
  const n = propNodes.get(key);
  if (!n) return;
  clearTimeout(n.timer);
  propNodes.delete(key);
  animate(n.root, { opacity: 0, scale: 0.8 }, { duration: REDUCED ? 0 : 0.3 })
    .finished.then(() => n.root.remove())
    .catch(() => n.root.remove());
}

// ── o robô ──────────────────────────────────────────────────────────────

// Robô de esteira: carcaça arredondada (a carcaça é o matiz), tela-rosto com os
// três estados, e esteiras que são desenho — nunca animação, senão congelam
// deformadas no primeiro frame do print headless. A plaqueta com o `agent_type`
// fica fora do grupo `flip`, em HTML, para o texto nunca sair espelhado.
const ROBOT = `
<svg width="46" height="56" viewBox="0 0 46 56">
  <ellipse class="drop" cx="23" cy="53" rx="16" ry="3.6"/>
  <g class="flip">
    <!-- alça de transporte no topo da carcaça, como nas fotos de referência -->
    <path class="handle" d="M16 7.5V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v1.5"/>

    <!-- esteiras: correia escura com roldana em cada ponta e os dentes no meio -->
    <g class="treads">
      <rect class="belt" x="1.5" y="39" width="19" height="12" rx="6"/>
      <rect class="belt" x="25.5" y="39" width="19" height="12" rx="6"/>
      <path class="tread-teeth" d="M5 40.5v9M8.5 40.5v9M12 40.5v9M15.5 40.5v9M29 40.5v9M32.5 40.5v9M36 40.5v9M39.5 40.5v9"/>
      <circle class="roller" cx="6" cy="45" r="3.4"/><circle class="roller" cx="16" cy="45" r="3.4"/>
      <circle class="roller" cx="30" cy="45" r="3.4"/><circle class="roller" cx="40" cy="45" r="3.4"/>
      <path class="axle" d="M20.5 45h5"/>
    </g>

    <!-- carcaça: o cubo de quinas arredondadas. A carcaça é o matiz. -->
    <rect class="chassis" x="4" y="7" width="38" height="34" rx="7.5"/>
    <path class="chassis-shade" d="M42 14.5v19a7.5 7.5 0 0 1-7.5 7.5H30V7h4.5A7.5 7.5 0 0 1 42 14.5Z"/>
    <path class="panel" d="M30 7v34" opacity=".5"/>
    <path class="vent" d="M33 11h6M33 13.5h6M33 16h6"/>
    <g class="screws">
      <circle cx="7.6" cy="10.6" r="1"/><circle cx="26.4" cy="10.6" r="1"/>
      <circle cx="7.6" cy="37.4" r="1"/><circle cx="26.4" cy="37.4" r="1"/>
    </g>

    <!-- tela-rosto: domina a face, com moldura funda e brilho da cor do agente -->
    <rect class="bezel" x="6.5" y="9.5" width="21" height="21" rx="4.5"/>
    <rect class="screen" x="8.5" y="11.5" width="17" height="17" rx="3"/>
    <g class="face">
      <g class="m m-idle">
        <ellipse class="eye" cx="13.6" cy="18" rx="2.1" ry="2.3"/>
        <ellipse class="eye" cx="20.4" cy="18" rx="2.1" ry="2.3"/>
        <path class="mouth" d="M15.4 23.4h3.2"/>
      </g>
      <g class="m m-work">
        <path class="eye-line" d="M11.6 18h4M18.4 18h4"/>
        <path class="mouth" d="M15.4 23.4h3.2"/>
      </g>
      <g class="m m-error">
        <path class="eye-x" d="M11.8 16.2l3.4 3.4M15.2 16.2l-3.4 3.4M18.8 16.2l3.4 3.4M22.2 16.2l-3.4 3.4"/>
      </g>
    </g>

    <!-- plaqueta gravada na carcaça, abaixo da tela: SUBAGENT 01 nas fotos -->
    <rect class="badge" x="6.5" y="32.5" width="21" height="6" rx="1.5"/>
    <path class="badge-etch" d="M9 35.5h5M15.5 35.5h9" opacity=".55"/>
  </g>
</svg>`;

function mountAgent(agent, instant, cmd) {
  const node = document.createElement('div');
  node.className = 'agent';
  node.style.setProperty('--h', hueOf(agent));
  node.dataset.face = String(agent.face);
  node.dataset.mood = moodOf(agent);
  if (agent.isMain) node.dataset.main = '';
  const who = agent.isMain ? 'principal' : agent.type;
  node.innerHTML =
    `<div class="figure">${ROBOT}<div class="plate"><span class="plate-type"></span></div></div>` +
    `<div class="agent-name"><span class="agent-tool"></span></div>`;

  // A plaqueta carrega o `agent_type`; o nome cru cabe no title para quando o
  // tipo é longo demais e a plaqueta corta com reticências.
  const plate = node.querySelector('.plate-type');
  plate.textContent = who;
  plate.parentElement.title = who;
  // Quem fala fica acima de quem só trabalha, e balões de agentes diferentes
  // se escalonam em altura para não se cobrirem quando todos falam juntos.
  node.style.setProperty('--lift', (nodes.size % 3) * 48 + 'px');
  // Em isométrico a ordem de desenho é a profundidade: o robô mais à frente
  // (y de tela maior) tapa quem está atrás dele.
  node.style.zIndex = String(1000 + Math.round(agent.y));
  $agents.appendChild(node);

  const rec = { root: node, tool: node.querySelector('.agent-tool'), bubbleTimer: 0, chain: Promise.resolve() };
  nodes.set(agent.id, rec);

  // O ponto de entrada vem no comando: o `moveTo` da cena já mexeu em agent.x,
  // então sem o retrato o robô montaria no destino e a caminhada some.
  const start = cmd && cmd.x != null ? cmd : agent;
  animate(node, { x: start.x, y: start.y }, { duration: 0 });
  // Visível por padrão: a opacidade não pode depender de uma animação começar.
  // Numa rajada, animações WAAPI ficam pendentes e o robô nunca aparecia — a
  // planta ficava vazia com o elenco cheio.
  node.style.opacity = '1';
  if (!instant) animate(node, { scale: [0.6, 1] }, POP);
  return rec;
}

const SPEED = 105;          // pixels por segundo — o passo do robô
const RIDE_SECONDS = 1.4;   // a cabine é lenta de propósito

function walkAgent(id, x, y, face, kind, instant, start) {
  const rec = nodes.get(id);
  if (!rec) return;

  // Na reconstrução o agente já está parado no destino: nada de caminhada.
  if (instant) {
    rec.root.dataset.face = String(face);
    rec.chain = Promise.resolve();
    rec.at = { x, y };
    rec.root.style.zIndex = String(1000 + Math.round(y));
    animate(rec.root, { x, y }, { duration: 0 });
    return;
  }

  // Cada perna do trajeto espera a anterior. Sem a fila, a motion troca o
  // destino no meio e o robô corta caminho pelo ar — que era exatamente o que
  // fazia a cena parecer confusa.
  const step = () => {
    const from = rec.at || { x, y };
    const dist = Math.hypot(x - from.x, y - from.y);
    rec.at = { x, y };
    rec.root.dataset.face = String(face);
    rec.root.classList.toggle('riding', kind === 'ride');
    rec.root.classList.toggle('walking', kind === 'walk' || kind === 'off');
    rec.root.style.zIndex = String(1000 + Math.round(y));

    // Velocidade constante: percurso longo leva mais tempo. É o que faz duas
    // caminhadas diferentes parecerem o mesmo robô, e não dois ritmos.
    let opts;
    if (STILL) opts = { duration: 0 };
    else if (kind === 'ride') opts = { duration: RIDE_SECONDS, ease: [0.4, 0, 0.2, 1] };
    else if (kind === 'board' || kind === 'off') opts = { duration: 0.5, ease: [0.3, 0, 0.3, 1] };
    else opts = { duration: Math.max(0.32, dist / SPEED), ease: [0.35, 0, 0.25, 1] };

    const anim = animate(rec.root, { x, y }, opts);
    return anim.finished
      .then(() => { rec.root.classList.remove('walking', 'riding'); })
      .catch(() => {});
  };

  // Trajeto novo abandona o anterior: a fila guarda as pernas de um caminho só.
  // Sem isto, uma sessão em rajada acumula minutos de caminhada pendente e o
  // prédio passa a mostrar onde os agentes estavam, não onde estão.
  if (start) {
    rec.gen = (rec.gen || 0) + 1;
    rec.chain = Promise.resolve();
  }
  const gen = rec.gen || 0;
  rec.chain = (rec.chain || Promise.resolve()).then(() => (gen === rec.gen ? step() : null));
}

function stateAgent(agent) {
  const rec = nodes.get(agent.id);
  if (!rec) return;
  rec.root.classList.toggle('working', agent.status === 'working');
  rec.root.dataset.mood = moodOf(agent);
  rec.tool.textContent = agent.tool || '';
}

function leaveAgent(id, instant) {
  const rec = nodes.get(id);
  if (!rec) return;
  nodes.delete(id);
  rec.root.classList.remove('working');
  // Reconstruindo, quem já saiu na sessão simplesmente não está no prédio.
  if (instant) { rec.root.remove(); return; }
  animate(rec.root, { opacity: 0, scale: 0.72 }, { duration: REDUCED ? 0 : 0.5, delay: REDUCED ? 0 : 1.6 })
    .finished.then(() => rec.root.remove())
    .catch(() => rec.root.remove());
}

function sayAgent(id, text, tone, instant) {
  if (instant) return;   // balão de fala é do agora; o passado fica no registro
  const rec = nodes.get(id);
  if (!rec || !text) return;

  rec.root.querySelector('.bubble')?.remove();
  const b = document.createElement('div');
  b.className = 'bubble';
  b.dataset.tone = tone;
  // Junto à porta um balão centrado vazaria para fora da planta; ali ele abre
  // para a direita, para dentro da sala.
  const at = scene.agents.get(id);
  if (at && at.x < 240) b.dataset.anchor = 'left';
  b.textContent = text;
  rec.root.appendChild(b);

  animate(b, { opacity: [0, 1], y: [8, 0], scale: [0.94, 1] }, POP);
  clearTimeout(rec.bubbleTimer);
  rec.bubbleTimer = setTimeout(() => {
    animate(b, { opacity: 0, y: -6 }, { duration: REDUCED ? 0 : 0.35 })
      .finished.then(() => b.remove())
      .catch(() => b.remove());
  }, 5200 + Math.min(text.length * 26, 3200));
}

// ── trilhos ───────────────────────────────────────────────────────────────

const VERB = {
  Read: 'lê', Edit: 'edita', Write: 'escreve', NotebookEdit: 'edita',
  Bash: 'roda', PowerShell: 'roda', Grep: 'busca', Glob: 'vasculha',
  WebFetch: 'consulta', WebSearch: 'pesquisa', Task: 'convoca', Agent: 'convoca',
  Skill: 'abre', TodoWrite: 'anota', Workflow: 'orquestra',
};

function renderCast() {
  const cast = [...scene.agents.values()].sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0));
  $castCount.textContent = cast.length || '0';
  $castList.replaceChildren();

  for (const a of cast) {
    const row = document.createElement('div');
    row.className = 'cast-row';
    row.dataset.status = a.status;
    if (a.isMain) row.dataset.main = '';
    row.style.setProperty('--h', hueOf(a));
    // O que a ferramenta tocou vem do agente: com mobília fixa (issue #14) o
    // móvel não carrega mais o nome do arquivo.
    const doing = a.tool
      ? `<b>${esc(VERB[a.tool] || a.tool)}</b> ${esc(a.subject || propLabel(a.propKey))}`
      : `ocioso · ${a.toolCount} ${a.toolCount === 1 ? 'ação' : 'ações'}`;
    row.innerHTML =
      `<i class="chip"></i>` +
      `<div><div class="cast-name">${esc(a.isMain ? 'principal' : a.type)}</div>` +
      `<div class="cast-doing">${doing}</div></div>`;
    $castList.appendChild(row);
  }
  if (!REDUCED && cast.length) {
    animate($castList.children, { opacity: [0, 1], x: [-6, 0] }, { duration: .3, delay: stagger(0.03) });
  }
}

// A plaqueta da porta: mostra o agent_type do ocupante do cômodo. Posicionada
// por left/top, não por transform — o transform é da motion, e as plaquetas não
// são animadas por ela.
function renderDoors() {
  $doors.replaceChildren();
  for (const a of scene.agents.values()) {
    if (a.room == null) continue;
    const q = roomQuad(a.room);
    const r = roomRect(a.room);
    const plate = document.createElement('div');
    plate.className = 'door-plate';
    plate.style.setProperty('--h', hueOf(a));
    if (a.isMain) plate.dataset.main = '';
    if (a.status === 'leaving') plate.dataset.leaving = '';
    plate.textContent = a.isMain ? 'principal' : a.type;
    // No canto esquerdo do cômodo, rente ao piso: em isométrico o alto da parede
    // do fundo cai por cima do andar de cima, e as plaquetas se atropelavam.
    plate.style.left = (q[3].x + 34) + 'px';
    plate.style.top = (q[3].y - 12) + 'px';
    $doors.appendChild(plate);

    // O dono desceu ao térreo para usar uma estação (issue #9): o cômodo fica
    // reservado, com a marca "ocupado, fora", para não se confundir com um
    // cômodo vazio.
    if (a.away) {
      plate.dataset.away = '';
      const mark = document.createElement('div');
      mark.className = 'room-mark';
      mark.style.setProperty('--h', hueOf(a));
      if (a.isMain) mark.dataset.main = '';
      mark.style.left = r.cx + 'px';
      mark.style.top = (r.y + r.h * 0.55) + 'px';
      mark.textContent = 'ocupado · fora';
      $doors.appendChild(mark);
    }
  }
}

function propLabel(key) {
  return scene.props.get(key)?.label || '';
}

function renderLog(ev) {
  const row = document.createElement('div');
  row.className = 'log-row';
  const speech = ev.kind === 'stop' || ev.kind === 'prompt' || ev.kind === 'turn_end';
  row.dataset.tone = speech ? 'speech' : 'work';

  const a = scene.agents.get(ev.agentId);
  row.style.setProperty('--h', a ? hueOf(a) : 0);
  if (ev.agentId === 'main') row.dataset.main = '';

  const who = ev.kind === 'prompt' ? 'você' : ev.agentId === 'main' ? 'principal' : ev.agentType;
  let what;
  if (ev.kind === 'tool_start') {
    // Caminho inteiro cabe no `title`; na linha fica só o que se lê de relance.
    const detail = ev.prop?.detail || '';
    const short = ev.prop?.kind === 'desk' ? ev.prop.label : detail || ev.prop?.label || '';
    if (detail) row.title = detail;
    what = `<span class="verb">${esc(VERB[ev.tool] || ev.tool)}</span> ${esc(short)}`;
  } else if (ev.kind === 'spawn') {
    what = '<span class="verb">entrou</span>';
  } else if (ev.text) {
    what = esc(ev.text);
  } else {
    return;
  }

  row.innerHTML =
    `<span class="log-at">${clock(ev.at)}</span>` +
    `<span class="log-what"><span class="log-who">${esc(who)}</span> ${what}</span>`;
  $logList.appendChild(row);

  while ($logList.children.length > 140) $logList.firstChild.remove();
  $logCount.textContent = ++logged;
  $logList.scrollTop = $logList.scrollHeight;
  // A linha entra sem animação: uma WAAPI por linha, numa rajada de eventos,
  // deixava dezenas de animações pendentes e o registro aparecia em branco.
  // O registro é texto que rola — o movimento aqui não somava nada.
}

function clock(at) {
  const d = new Date(at || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── execução dos comandos da cena ─────────────────────────────────────────

function run(cmds) {
  let touchedCast = false;

  for (const c of cmds) {
    switch (c.op) {
      case 'prop-add': mountProp(c.prop, c.instant); break;
      case 'prop-hit': hitProp(c.prop, c.instant, c.subject); break;
      case 'prop-move': moveProp(c.prop, c.instant); break;
      case 'prop-remove': removeProp(c.key); break;
      case 'agent-enter':
        mountAgent(c.agent, c.instant, c);
        touchedCast = true;
        break;
      case 'agent-move': walkAgent(c.id, c.x, c.y, c.face, c.kind, c.instant, c.start); break;
      case 'cabin': moveCabin(c.to, c.instant); break;
      case 'agent-state': stateAgent(c.agent); touchedCast = true; break;
      case 'agent-leave': leaveAgent(c.id, c.instant); touchedCast = true; break;
      case 'say': sayAgent(c.id, c.text, c.tone, c.instant); break;
      case 'log': renderLog(c.event); break;
    }
  }

  if (touchedCast) { renderCast(); renderDoors(); }
  syncBuilding();
  $empty.hidden = scene.agents.size > 0;
}

// ── salas ─────────────────────────────────────────────────────────────────

function clearRoom() {
  for (const rec of nodes.values()) rec.root.remove();
  nodes.clear();
  for (const n of propNodes.values()) n.root.remove();
  propNodes.clear();
  $doors.replaceChildren();
  $logList.replaceChildren();
  logged = 0;
  $logCount.textContent = '';
}

function enterRoom(id, room) {
  currentRoom = id;
  clearRoom();
  // Monta o prédio aplicando a lista de eventos da sessão desde o começo.
  run(rebuild(scene, room?.events));
  renderCast();
  renderDoors();
  $empty.hidden = scene.agents.size > 0;
}

async function switchRoom(id, pending) {
  currentRoom = id;
  let room = null;
  try {
    const snap = await (await fetch('/state')).json();
    for (const s of snap.sessions) rooms.set(s.id, s);
    room = snap.sessions.find((s) => s.id === id) || null;
  } catch {
    /* servidor mudo: entra na sala vazia mesmo */
  }
  enterRoom(id, room);
  refreshRooms();
  if (pending && !room?.events.some((h) => h.seq === pending.seq)) run(apply(scene, pending));
}

function refreshRooms() {
  const list = [...rooms.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  $rooms.replaceChildren();
  if (!list.length) {
    $rooms.innerHTML = '<option>sem sessões</option>';
    return;
  }
  for (const r of list) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `● ${r.cwd || r.label} · ${r.id.slice(0, 8)}`;
    $rooms.appendChild(o);
  }
  if (currentRoom) $rooms.value = currentRoom;
}

$rooms.addEventListener('change', () => {
  $follow.checked = false;   // escolha manual manda mais que o piloto automático
  switchRoom($rooms.value);
});

// ── enquadramento (vista empilhada) ───────────────────────────────────────
//
// Uma vista só: o prédio inteiro empilhado na tela. A vista de andar cheio foi
// removida — com o prédio isométrico ela dava duas leituras do mesmo espaço e
// confundia mais do que ajudava.
let drawnFloors = 0;

// Enquadra o prédio no palco. O `#plan` é uma caixa centrada, e a motion compõe
// o transform a partir de x/y/scale com origem no centro dela: um ponto p cai
// em centro + (p - c)·s + (x,y). Daí a conta.
function fit(animated = true) {
  const r = $stage.getBoundingClientRect();
  const v = buildingRect(scene);
  const pad = 34;
  const scale = Math.min((r.width - pad * 2) / v.w, (r.height - pad * 2) / v.h, 1.2);
  const c = { x: PLAN.w / 2, y: PLAN.h / 2 };
  const x = -(v.x + v.w / 2 - c.x) * scale;
  const y = -(v.y + v.h / 2 - c.y) * scale;
  const opts = REDUCED || !animated ? { duration: 0 } : { type: 'spring', stiffness: 60, damping: 18 };
  animate($plan, { x, y, scale }, opts);
}

// Mantém a planta desenhada do tamanho do prédio. Chamada depois de cada lote
// de comandos: é aqui que um andar novo ganha plataforma e a vista se reenquadra.
function syncBuilding() {
  const floors = floorCount(scene);
  if (floors !== drawnFloors) {
    drawnFloors = floors;
    drawBlueprint(floors);
    // O SVG cobre o prédio inteiro: sem esticar a caixa para cima, o viewBox
    // cortaria os andares de cima, que vivem em y negativo.
    const top = buildingRect(scene).y - 40;
    $blueprint.style.top = top + 'px';
    $blueprint.style.height = PLAN.h - top + 'px';
    $blueprint.setAttribute('viewBox', `0 ${top} ${PLAN.w} ${PLAN.h - top}`);
  }
  fit();
}

// Trilhos recolhíveis: o registro e o elenco viram lombada, e a planta fica com
// o espaço. A escolha fica no localStorage — quem trabalha com o registro
// fechado não quer reabri-lo a cada recarga.
function railSetup(name, btn) {
  const key = 'office.rail.' + name;
  const set = (off) => {
    $app.dataset[name] = off ? 'off' : 'on';
    btn.title = (off ? 'abrir' : 'recolher') + (name === 'feed' ? ' o registro' : ' o elenco');
    try { localStorage.setItem(key, off ? 'off' : 'on'); } catch {}
    fit(false);
  };
  let stored = null;
  try { stored = localStorage.getItem(key); } catch {}
  set(stored === 'off');
  btn.addEventListener('click', () => set($app.dataset[name] !== 'off'));
}
railSetup('roster', el('rosterToggle'));
railSetup('feed', el('feedToggle'));

// ── conexão ───────────────────────────────────────────────────────────────

function connect() {
  const es = new EventSource('/events');

  es.onopen = () => {
    $dot.classList.add('live');
    $statusText.textContent = 'ao vivo';
  };

  es.onerror = () => {
    $dot.classList.remove('live');
    $statusText.textContent = 'reconectando';
  };

  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);

    if (msg.type === 'snapshot') {
      rooms.clear();
      for (const s of msg.sessions) rooms.set(s.id, s);
      if (!currentRoom || !rooms.has(currentRoom)) {
        const first = msg.sessions[0];
        if (first) {
          enterRoom(first.id, first);
          roomActivity = first.lastSeen;
        }
      }
      refreshRooms();
      return;
    }

    if (msg.type !== 'event') return;
    const ev = msg.event;
    const now = Date.now();

    // SessionEnd mata a sala: sai do seletor na hora. Se era a sala aberta,
    // cai para a próxima viva, ou para a tela vazia se não sobrou nenhuma.
    if (ev.kind === 'session_end') {
      rooms.delete(ev.session);
      refreshRooms();
      if (ev.session === currentRoom) {
        const next = [...rooms.values()].sort((a, b) => b.lastSeen - a.lastSeen)[0];
        if (next) {
          switchRoom(next.id);
        } else {
          currentRoom = null;
          clearRoom();
          renderCast();
          $empty.hidden = false;
        }
      }
      return;
    }

    if (!rooms.has(ev.session)) {
      rooms.set(ev.session, { id: ev.session, label: ev.session.slice(0, 8), cwd: ev.cwd, lastSeen: now });
      refreshRooms();
    } else {
      rooms.get(ev.session).lastSeen = now;
    }

    if (ev.session === currentRoom) {
      roomActivity = now;
      run(apply(scene, ev));
      return;
    }

    // Outra sessão se mexeu. Só troca se ninguém escolheu na mão e a sala atual
    // está parada — senão duas janelas ficariam arrancando a tela uma da outra.
    if (!currentRoom || ($follow.checked && now - roomActivity > 20_000)) {
      roomActivity = now;
      switchRoom(ev.session, ev);
    }
  };
}

// ── arranque ──────────────────────────────────────────────────────────────

syncBuilding();
new ResizeObserver(() => fit(false)).observe($stage);

if (params.has('demo')) {
  // Sem SSE: a cena vem de um roteiro. Serve para ver o escritório sem o
  // Claude Code rodando — e é o único jeito de um navegador headless
  // conseguir tirar print, já que o stream SSE nunca deixa a página "carregar".
  currentRoom = 'demo';
  rooms.set('demo', { id: 'demo', label: 'demonstração', cwd: 'projeto-demo', lastSeen: Date.now() });
  refreshRooms();
  $statusText.textContent = 'demonstração';
  const { playDemo } = await import('./demo.mjs');
  const upto = Number(params.get('upto')) || Infinity;
  playDemo((ev) => run(apply(scene, ev)), params.has('instant'), upto);
} else {
  connect();
}
