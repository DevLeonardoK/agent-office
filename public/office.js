// Renderizador do escritório: DOM + SVG, animado com motion.dev.
//
// Toda a lógica de posicionamento mora em scene.mjs. Aqui só se decide como
// cada comando da cena vira pixel e movimento.

import { animate, stagger } from './vendor/motion.js';
import {
  createScene, apply, rebuild, PLAN, DOOR, STATIONS, GROUND, FLOOR, ROOMS_PER_FLOOR,
  roomRect, floorRect, buildingRect, floorCount, SHAFT, shaftRect, cabinRect,
} from './scene.mjs';

const params = new URLSearchParams(location.search);

// Carimbo do desenho carregado. Suba isto quando o desenho mudar de forma —
// é o que distingue "não mudou" de "o navegador está com o arquivo velho".
const BUILD = '2.5d · poço · robô-foto';

// `instant` despeja o roteiro de uma vez; sem cortar as animações, o resultado
// seria um congelado com todo mundo no meio do caminho.
const STILL = params.has('instant') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const REDUCED = STILL;

// Springs: a mesma massa para todo mundo, para a cena ter um "peso" coerente.
const WALK = STILL ? { duration: 0 } : { type: 'spring', stiffness: 42, damping: 15, mass: 1.1 };
const POP = STILL ? { duration: 0 } : { type: 'spring', stiffness: 320, damping: 24 };

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
const $floors = el('floors');
const $app = el('app');
el('build').textContent = BUILD;
const $viewBack = el('viewBack');

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

// Desenha o prédio com `floors` andares empilhados sobre o térreo.
//
// Projeção oblíqua (a "isométrica de prancheta"): a face de frente fica no
// plano da cena — é nela que os robôs e os móveis vivem, com as coordenadas
// que o scene.mjs calcula — e o volume vem de duas faces auxiliares, o topo e
// a lateral, deslocadas pelo vetor de profundidade. Nada que o scene.mjs
// posiciona passa pela projeção: só a arquitetura ganha corpo.
const DEPTH = { x: 30, y: -19 };
const back = (x, y) => [x + DEPTH.x, y + DEPTH.y];

function drawBlueprint(floors) {
  $blueprint.replaceChildren();
  const ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, parent = $blueprint) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };
  const line = (x1, y1, x2, y2, o = .55, w = 1) =>
    add('path', { d: `M${x1} ${y1}L${x2} ${y2}`, stroke: 'var(--draft)', 'stroke-width': w, opacity: o });
  const label = (x, y, text, o = .5) => {
    const t = add('text', {
      x, y, fill: 'var(--draft)', opacity: o,
      'font-family': 'var(--mono)', 'font-size': 10, 'letter-spacing': 3.4, 'text-anchor': 'middle',
    });
    t.textContent = text;
  };
  // Face de profundidade: o mesmo retângulo empurrado para trás, fechado nos
  // quatro cantos. É o que dá volume sem sair do azul de prancheta.
  const slab = (x, y, w, h, fill = .07) => {
    const [bx, by] = back(x, y);
    add('path', {
      d: `M${x} ${y}L${bx} ${by}L${bx + w} ${by}L${x + w} ${y}Z`,
      fill: 'var(--draft)', stroke: 'var(--draft)', 'stroke-width': .6, 'fill-opacity': fill + .04, opacity: .5,
    });
    add('path', {
      d: `M${x + w} ${y}L${bx + w} ${by}L${bx + w} ${by + h}L${x + w} ${y + h}Z`,
      fill: 'var(--draft)', stroke: 'var(--draft)', 'stroke-width': .6, 'fill-opacity': fill, opacity: .45,
    });
  };

  // Gradiente arco-íris do agente principal. Vive aqui, no SVG da planta, mas a
  // carcaça do robô o referencia por id de qualquer outro SVG do documento — é
  // o mesmo matiz que o elenco e o registro pintam por CSS, para o principal se
  // ler igual nos três lugares.
  const defs = add('defs', {});
  const grad = add('linearGradient', { id: 'agentRainbow', x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
  const stops = [['0', 'hsl(0 80% 62%)'], ['.2', 'hsl(32 85% 60%)'], ['.4', 'hsl(52 85% 58%)'],
                 ['.6', 'hsl(145 60% 52%)'], ['.8', 'hsl(210 70% 58%)'], ['1', 'hsl(280 60% 64%)']];
  for (const [off, col] of stops) add('stop', { offset: off, 'stop-color': col }, grad);

  const M = 24;                       // margem do desenho
  const top = floorRect(floors - 1).y - 16;   // teto do último andar
  const W = PLAN.w - M * 2;
  const H = PLAN.h - M - top;

  // Volume do prédio: o teto e a lateral direita, empurrados para trás.
  slab(M, top, W, H, .03);

  // parede externa: linha dupla, como em planta de verdade
  add('rect', { x: M, y: top, width: W, height: H, fill: 'none', stroke: 'var(--draft)', 'stroke-width': 2, opacity: .55 });
  add('rect', { x: M + 5, y: top + 5, width: W - 10, height: H - 10, fill: 'none', stroke: 'var(--draft)', 'stroke-width': .6, opacity: .3 });

  // marcas de canto (registro de prancheta)
  for (const [cx, cy, sx, sy] of [[M, top, 1, 1], [PLAN.w - M, top, -1, 1], [M, PLAN.h - M, 1, -1], [PLAN.w - M, PLAN.h - M, -1, -1]]) {
    add('path', {
      d: `M${cx} ${cy + sy * 20}L${cx} ${cy}L${cx + sx * 20} ${cy}`,
      fill: 'none', stroke: 'var(--draft)', 'stroke-width': 1.6, opacity: .75,
    });
  }

  // Um andar de cada vez, de baixo para cima: cinco cômodos separados por
  // divisórias, o vão da porta no topo de cada um, e a laje que o sustenta.
  const roomW = SHAFT.x / ROOMS_PER_FLOOR;
  for (let f = 0; f < floors; f++) {
    const fr = floorRect(f);
    const ceiling = fr.y + 6;                     // topo dos cômodos deste andar
    const base = ceiling + roomRect(0).h;         // piso deste andar
    for (let i = 0; i < ROOMS_PER_FLOOR; i++) {
      if (i > 0) line(i * roomW, ceiling, i * roomW, base, .3, 1);
      const r = roomRect(f * ROOMS_PER_FLOOR + i);
      // vão da porta, sugerido no topo do cômodo
      add('rect', { x: r.cx - 20, y: ceiling - 2, width: 40, height: 4, fill: 'var(--ink)' });
      line(r.cx - 20, ceiling, r.cx - 20, ceiling + 14, .35, 1);
      line(r.cx + 20, ceiling, r.cx + 20, ceiling + 14, .35, 1);
    }
    // A laje entre este andar e o de baixo tem espessura: é ela que se lê como
    // "andar" quando o prédio é olhado de lado.
    slab(M, base + 3, W, 8, .06);
    line(M, base + 3, PLAN.w - M, base + 3, .5, 1.6);
    line(M, base + 11, PLAN.w - M, base + 11, .3, 1);
    label(SHAFT.x / 2, ceiling - 12, `${f + 1}º ANDAR`, .38);
  }

  // ── o poço do elevador ──────────────────────────────────────────────────
  // Coluna própria, atravessando os andares até o térreo. A cabine é desenhada
  // depois, fora do redesenho, porque ela se move.
  const sh = shaftRect(scene);
  slab(sh.x, sh.y, sh.w, sh.h, .04);
  add('rect', {
    x: sh.x, y: sh.y, width: sh.w, height: sh.h,
    fill: 'var(--ink)', stroke: 'var(--draft)', 'stroke-width': 1.2, opacity: .9,
  });
  // guias do poço e as marcas de parada de cada andar
  line(sh.x + 12, sh.y, sh.x + 12, sh.y + sh.h, .3, 1);
  line(sh.x + sh.w - 12, sh.y, sh.x + sh.w - 12, sh.y + sh.h, .3, 1);
  for (let f = 0; f < floors; f++) {
    const c = cabinRect(f);
    line(sh.x + 4, c.y + c.h, sh.x + sh.w - 4, c.y + c.h, .28, 1);
  }
  const cap = add('text', {
    x: sh.x + sh.w / 2, y: sh.y + 12, fill: 'var(--draft)', opacity: .5,
    'font-family': 'var(--mono)', 'font-size': 9, 'letter-spacing': 3, 'text-anchor': 'middle',
  });
  cap.textContent = 'ELEVADOR';

  // A cabine: vive no SVG da planta e é movida pela motion, andar a andar.
  const cab = cabinRect(-1);
  $cabin = add('g', { class: 'cabin' });
  add('rect', {
    x: cab.x, y: cab.y, width: cab.w, height: cab.h, rx: 2,
    fill: 'var(--ink)', stroke: 'var(--draft)', 'stroke-width': 1.4, opacity: 1,
  }, $cabin);
  add('path', {
    d: `M${cab.x + cab.w / 2} ${cab.y + 6}v${cab.h - 12}`,
    stroke: 'var(--draft)', 'stroke-width': .8, opacity: .5,
  }, $cabin);   // as duas folhas da porta
  cabinAt = -1;

  // térreo de serviço: porta do prédio e as quatro estações
  const d = DOOR;
  slab(M, GROUND.y, W, GROUND.h - M, .06);
  line(M, GROUND.y, PLAN.w - M, GROUND.y, .5, 2);
  add('rect', { x: M - 3, y: d.y - 30, width: 11, height: 60, fill: 'var(--ink)' });
  add('path', {
    d: `M${M + 8} ${d.y + 26}A56 56 0 0 0 ${M + 64} ${d.y - 30}`,
    fill: 'none', stroke: 'var(--draft)', 'stroke-width': .9, 'stroke-dasharray': '3 4', opacity: .6,
  });
  for (const s of Object.values(STATIONS)) label(s.x, GROUND.y + GROUND.h - 16, s.label, .5);
  label(SHAFT.x - 96, GROUND.y + 18, 'TÉRREO DE SERVIÇO', .32);
}

// Leva a cabine ao andar pedido (-1 é o térreo). O robô viaja junto: a perna
// `ride` do trajeto dele tem a mesma duração.
let $cabin = null;
let cabinAt = -1;
const RIDE = { duration: 0.62, ease: [0.32, 0, 0.2, 1] };

function moveCabin(floor) {
  if (!$cabin || floor === cabinAt) return;
  cabinAt = floor;
  const dy = cabinRect(floor).y - cabinRect(-1).y;
  animate($cabin, { y: dy }, REDUCED ? { duration: 0 } : RIDE);
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
  node.querySelector('.prop-label').textContent = prop.label;
  node.title = prop.detail || prop.label;
  $props.appendChild(node);
  propNodes.set(prop.key, { root: node, timer: 0 });

  // A posição tem que entrar pela motion: ela compõe o `transform` a partir de
  // x/y/scale e sobrescreveria qualquer translate escrito na mão.
  animate(node, { x: prop.x, y: prop.y }, { duration: 0 });
  // Na reconstrução o móvel já nasce no lugar; ao vivo ele surge com um pop.
  animate(node, instant ? { opacity: 1, scale: 1 } : { opacity: [0, 1], scale: [0.82, 1] }, instant ? { duration: 0 } : POP);
  return node;
}

function hitProp(prop, instant) {
  if (instant) return;   // reacender cada uso do log de uma vez seria só ruído
  const n = propNodes.get(prop.key);
  if (!n) return;
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
  node.style.zIndex = String(10 + nodes.size);
  $agents.appendChild(node);

  const rec = { root: node, tool: node.querySelector('.agent-tool'), bubbleTimer: 0, chain: Promise.resolve() };
  nodes.set(agent.id, rec);

  // O ponto de entrada vem no comando: o `moveTo` da cena já mexeu em agent.x,
  // então sem o retrato o robô montaria no destino e a caminhada some.
  const start = cmd && cmd.x != null ? cmd : agent;
  animate(node, { x: start.x, y: start.y }, { duration: 0 });
  if (!instant) animate(node, { opacity: [0, 1], scale: [0.6, 1] }, POP);
  return rec;
}

function walkAgent(id, x, y, face, elevator, instant, leg) {
  const rec = nodes.get(id);
  if (!rec) return;

  // Na reconstrução o agente já está parado no destino: nada de caminhada.
  if (instant) {
    rec.root.dataset.face = String(face);
    rec.chain = Promise.resolve();
    animate(rec.root, { x, y }, { duration: 0 });
    return;
  }

  // A viagem de elevador vem em três pernas (entrar na cabine, descer, sair):
  // elas têm de acontecer uma depois da outra, senão a motion troca o destino
  // no meio e o robô atravessa a parede em diagonal — que era o que acontecia
  // antes de o poço existir.
  const step = () => {
    rec.root.dataset.face = String(face);
    rec.root.classList.toggle('riding', leg === 'ride');
    if (leg !== 'ride') rec.root.classList.add('walking');
    // O spring da motion preserva velocidade quando interrompido, então mudar
    // de destino no meio do caminho não dá solavanco. A descida na cabine é
    // outra coisa: tempo fixo, igual ao da cabine, para os dois irem juntos.
    const opts = leg === 'ride' ? (STILL ? { duration: 0 } : RIDE) : WALK;
    const anim = animate(rec.root, { x, y }, opts);
    return anim.finished
      .then(() => { rec.root.classList.remove('walking', 'riding'); })
      .catch(() => {});
  };

  if (!leg) {
    rec.chain = Promise.resolve();
    step();
    return;
  }
  rec.chain = (rec.chain || Promise.resolve()).then(step);
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
    const doing = a.tool
      ? `<b>${esc(VERB[a.tool] || a.tool)}</b> ${esc(propLabel(a.propKey))}`
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
    const r = roomRect(a.room);
    const plate = document.createElement('div');
    plate.className = 'door-plate';
    plate.style.setProperty('--h', hueOf(a));
    if (a.isMain) plate.dataset.main = '';
    if (a.status === 'leaving') plate.dataset.leaving = '';
    plate.textContent = a.isMain ? 'principal' : a.type;
    plate.style.left = r.cx + 'px';
    // A plaqueta acompanha o andar do cômodo, não o topo fixo do 1º andar.
    plate.style.top = r.y + 'px';
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
      mark.style.top = (r.y + r.h / 2) + 'px';
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
  if (!REDUCED) animate(row, { opacity: [0, 1], x: [8, 0] }, { duration: .28 });
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
      case 'prop-hit': hitProp(c.prop, c.instant); break;
      case 'prop-move': moveProp(c.prop, c.instant); break;
      case 'prop-remove': removeProp(c.key); break;
      case 'agent-enter':
        mountAgent(c.agent, c.instant, c);
        touchedCast = true;
        break;
      case 'agent-move': walkAgent(c.id, c.x, c.y, c.face, c.elevator, c.instant, c.leg); break;
      case 'cabin': moveCabin(c.instant ? c.to : c.to); break;
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

// ── vistas do prédio (issue #11) ──────────────────────────────────────────

// Duas vistas: o corte vertical (padrão), com os andares empilhados e o prédio
// inteiro na tela, e o andar cheio, para inspecionar um andar denso. Só muda o
// enquadramento — a planta e os robôs são os mesmos nos dois.
const view = { mode: 'stack', floor: 0 };
let drawnFloors = 0;

// `?floor=N` abre um andar em tela cheia assim que ele existir — é o único jeito
// de o print headless, que não clica, enquadrar a vista de andar cheio.
let pinned = params.has('floor') ? Number(params.get('floor')) : null;

const viewRect = () => (view.mode === 'floor' ? floorRect(view.floor) : buildingRect(scene));

// Enquadra o retângulo da vista no palco. O `#plan` é uma caixa de 1000×620
// centrada no palco, e a motion compõe o transform a partir de x/y/scale com
// origem no centro dela: um ponto p da planta cai em centro + (p - c)·s + (x,y).
// Daí a conta — levar o centro do retângulo da vista ao centro do palco.
function fit(animated = true) {
  const r = $stage.getBoundingClientRect();
  const v = viewRect();
  const pad = 28;
  const scale = Math.min((r.width - pad * 2) / v.w, (r.height - pad * 2) / v.h, 1.35);
  const c = { x: PLAN.w / 2, y: PLAN.h / 2 };
  const x = -(v.x + v.w / 2 - c.x) * scale;
  const y = -(v.y + v.h / 2 - c.y) * scale;
  const opts = REDUCED || !animated ? { duration: 0 } : { type: 'spring', stiffness: 110, damping: 20 };
  animate($plan, { x, y, scale }, opts);
}

function setView(next) {
  Object.assign(view, next);
  $stage.dataset.view = view.mode;
  $viewBack.hidden = view.mode === 'stack';
  renderFloors();
  fit();
}

// As áreas de clique de cada andar. Ficam sobre a planta, invisíveis até o
// ponteiro passar por cima; no andar cheio sobra uma só, e clicar nela volta
// para a vista empilhada.
function renderFloors() {
  $floors.replaceChildren();
  const floors = floorCount(scene);
  for (let f = 0; f < floors; f++) {
    if (view.mode === 'floor' && f !== view.floor) continue;
    const fr = floorRect(f);
    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = 'floor-hit';
    hit.style.left = fr.x + 'px';
    hit.style.top = fr.y + 'px';
    hit.style.width = fr.w + 'px';
    hit.style.height = fr.h + 'px';
    const aberto = view.mode === 'floor';
    hit.title = aberto ? 'voltar à vista empilhada' : `abrir o ${f + 1}º andar em tela cheia`;
    hit.setAttribute('aria-label', hit.title);
    hit.addEventListener('click', () => setView(aberto ? { mode: 'stack' } : { mode: 'floor', floor: f }));
    $floors.appendChild(hit);
  }
}

// Mantém a planta desenhada do tamanho do prédio. Chamada depois de cada lote
// de comandos: é aqui que um andar novo ganha paredes e a vista se reenquadra.
function syncBuilding() {
  const floors = floorCount(scene);
  // `?floor=N` só pode ser honrado quando o andar existir: no arranque o prédio
  // ainda está vazio, e o roteiro do demo é aplicado depois.
  if (pinned != null && view.mode === 'stack' && floors > pinned) {
    setView({ mode: 'floor', floor: pinned });
    pinned = null;
    return;
  }
  if (view.mode === 'floor' && view.floor >= floors) {
    setView({ mode: 'stack' });   // o andar aberto foi demolido
    return;
  }
  if (floors !== drawnFloors) {
    drawnFloors = floors;
    drawBlueprint(floors);
    // O SVG da planta cobre o prédio inteiro: sem esticar a caixa para cima, o
    // viewBox cortaria os andares de cima, que vivem em y negativo.
    const top = floorRect(floors - 1).y - 40;
    $blueprint.style.top = top + 'px';
    $blueprint.style.height = PLAN.h - top + 'px';
    $blueprint.setAttribute('viewBox', `0 ${top} ${PLAN.w} ${PLAN.h - top}`);
  }
  renderFloors();
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

$viewBack.addEventListener('click', () => setView({ mode: 'stack' }));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && view.mode === 'floor') setView({ mode: 'stack' });
});

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

setView({ mode: 'stack' });
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
