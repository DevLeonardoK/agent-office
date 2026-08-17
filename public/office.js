// Renderizador 3D do escritório: three.js (ADR-0003).
//
// Toda a geometria mora no scene.mjs, que devolve pontos de mundo (wx, wy, wz).
// Aqui só se decide como um ponto vira malha, cor e movimento. O laço de
// animação é o dono do movimento — em 3D não existe `transform` de CSS para a
// motion.dev compor, então ela saiu do renderizador.

import * as THREE from './vendor/three.js';
import {
  createScene, apply, rebuild, floorCount, buildingBounds, platformShape, plateOf,
  roomQuad, world, platformOrigin, levelY, ROOMS_PER_FLOOR, PLATE,
  WALL_H, GROUND_FLOOR, STATIONS, DOOR, stairSteps, stairFoot, stairHead, stairWell, HUE_COUNT,
} from './scene.mjs';

const params = new URLSearchParams(location.search);

// Carimbo do desenho carregado. Suba isto quando o desenho mudar de forma — é o
// que distingue "não mudou" de "o navegador está com o arquivo velho".
const BUILD = '3d · órbita · escadaria';

// `instant` despeja o roteiro de uma vez: os robôs aparecem já no destino.
const STILL = params.has('instant') || matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = (id) => document.getElementById(id);
const $stage = el('stage');
const $canvas = el('scene');
const $overlay = el('overlay');
const $dot = el('dot');
const $statusText = el('statusText');
const $castList = el('castList');
const $castCount = el('castCount');
const $logList = el('logList');
const $logCount = el('logCount');
const $empty = el('empty');
const $rooms = el('rooms');
const $follow = el('follow');
const $app = el('app');
el('build').textContent = BUILD;

// ── estado do cliente ─────────────────────────────────────────────────────

const scene = createScene();
const bots = new Map();     // agentId -> {group, face, queue, mood, hue}
const props = new Map();    // propKey -> {group, lit}
const rooms = new Map();
let currentRoom = null;
let roomActivity = 0;
let logged = 0;
let drawnFloors = 0;

// Os matizes dos subagentes, quentes contra o azul técnico do prédio. O principal
// não usa nenhum deles — ele carrega o arco-íris.
//
// O rosa (338) entrou como sexto matiz (issue #17). O magenta 328 de antes puxava
// para o roxo e não se distinguia do violeta; e, ao acrescentar o rosa, o magenta
// virou o terceiro vizinho da mesma faixa — três robôs parecidos na tela. Então a
// paleta foi reespaçada: os seis matizes ficam a pelo menos 50° um do outro.
const HUES = [38, 8, 90, 165, 262, 338];
const hueOf = (a) => (a.isMain ? 0 : HUES[a.hueIndex % HUES.length]);
if (HUES.length !== HUE_COUNT) console.warn('paleta e HUE_COUNT divergem: o matiz vai repetir fora de ordem');
// O rosa precisa de mais luz para não ler como o vermelho do rosto de erro.
const hueColor = (h, l = 0.54) => new THREE.Color().setHSL(h / 360, 0.62, h >= 300 ? l + 0.08 : l);

// ── a cena three ──────────────────────────────────────────────────────────

const three = new THREE.Scene();

// Ortográfica, não perspectiva: é a projeção que mantém a leitura de planta — um
// cômodo do 3º andar mede o mesmo que um do 1º, e nada afunila com a distância.
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -300, 600);
// A órbita da câmera. O azimute começa na diagonal clássica de planta e a
// elevação, mais alta que a isométrica pura: com a câmera baixa, a parede do
// fundo de um andar cobre o piso do próprio andar.
const HOME_VIEW = { azim: Math.PI / 4, elev: 0.72, zoom: 1 };
const view = { ...HOME_VIEW };

// `?view=azim,elev,zoom` (radianos) fixa a órbita no arranque: é o único jeito de
// um print headless, que não arrasta o mouse, mostrar outro ângulo.
if (params.has('view')) {
  const [azim, elev, zoom] = String(params.get('view')).split(',').map(Number);
  if (Number.isFinite(azim)) view.azim = azim;
  if (Number.isFinite(elev)) view.elev = Math.min(1.45, Math.max(0.16, elev));
  if (Number.isFinite(zoom) && zoom > 0) view.zoom = zoom;
}
let orbited = false;   // enquanto ninguém girou, o enquadramento é automático

/** A direção de onde a câmera olha, a partir dos ângulos da órbita. */
function viewDir() {
  const r = Math.cos(view.elev);
  return new THREE.Vector3(Math.sin(view.azim) * r, Math.sin(view.elev), Math.cos(view.azim) * r);
}

const renderer = new THREE.WebGLRenderer({ canvas: $canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

// Luz de prancheta: uma direcional fria de cima e preenchimento hemisférico, só
// o suficiente para as faces se distinguirem. Sombra projetada fica fora — custa
// um passe de render por quadro e sujaria o desenho minimalista.
const sun = new THREE.DirectionalLight(0xdcebff, 1.1);
sun.position.set(9, 16, 7);
three.add(sun);
three.add(new THREE.HemisphereLight(0x8fb6d8, 0x0a121c, 0.8));
three.add(new THREE.AmbientLight(0x24405c, 0.55));

const mat = {
  // DoubleSide no piso e nas paredes: a forma do pentágono vem do scene.mjs e a
  // ordem dos vértices não é garantida — com face única, uma plataforma podia
  // aparecer preta por estar de costas para a câmera.
  floor: new THREE.MeshLambertMaterial({ color: 0x1e3a55, side: THREE.DoubleSide }),
  slab: new THREE.MeshLambertMaterial({ color: 0x0d1a27 }),
  wall: new THREE.MeshLambertMaterial({ color: 0x152943, side: THREE.DoubleSide }),
  // A divisória é baixa e mais clara que a parede: alta e escura, ela se
  // confundia com móvel e o cômodo virava um corredor de barras.
  divider: new THREE.MeshLambertMaterial({ color: 0x2d4d6d }),
  line: new THREE.LineBasicMaterial({ color: 0x3d6c93, transparent: true, opacity: 0.42 }),
  edge: new THREE.LineBasicMaterial({ color: 0x5d93bc, transparent: true, opacity: 0.9 }),
  step: new THREE.MeshLambertMaterial({ color: 0x1b3048 }),
  furniture: new THREE.MeshLambertMaterial({ color: 0x39628a }),
  station: new THREE.MeshLambertMaterial({ color: 0x2a4c6b }),
  screen: new THREE.MeshBasicMaterial({ color: 0x0a1520 }),
  screenLit: new THREE.MeshBasicMaterial({ color: 0x2e5c7e }),
  dark: new THREE.MeshLambertMaterial({ color: 0x0a1119 }),
};

// O prédio inteiro vive num grupo só: redesenhar é limpar e montar de novo, o
// que é barato (algumas centenas de malhas) e evita sincronizar andar por andar.
const building = new THREE.Group();
three.add(building);

// ── desenho do prédio ─────────────────────────────────────────────────────

const STAIR_W = 3.0;   // largura do lance: cabem duas faixas de robô

const box = (w, h, d, material) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);

function put(mesh, wx, wy, wz) {
  mesh.position.set(wx, wy, wz);
  return mesh;
}

/** Linha de contorno no plano do piso, para o traço de prancheta. */
function outline(points, material, y) {
  const geo = new THREE.BufferGeometry().setFromPoints(
    points.map((p) => new THREE.Vector3(p.wx, y ?? p.wy, p.wz)),
  );
  return new THREE.Line(geo, material);
}

/** A plataforma pentagonal de um andar: laje, piso ladrilhado e duas paredes. */
function drawPlatform(floor) {
  const shape = platformShape(floor);
  const o = platformOrigin(floor);
  const p = plateOf(floor);
  const y = levelY(floor);
  const g = new THREE.Group();

  // A laje é o pentágono extrudado para baixo: é a espessura dela que se lê como
  // "andar" quando o prédio é olhado de lado.
  const s = new THREE.Shape(shape.map((pt) => new THREE.Vector2(pt.wx, pt.wz)));

  // O vão da escada: buraco na laje por onde o lance de baixo chega. Sem ele o
  // robô subiria contra o piso deste andar.
  if (floor > GROUND_FLOOR) {
    const well = stairWell(floor);
    s.holes.push(new THREE.Path(well.map((pt) => new THREE.Vector2(pt.wx, pt.wz))));
  }
  // A extrusão traz dois grupos de face, nesta ordem: as tampas e as laterais.
  // Invertê-los pintava o topo de escuro e a borda de claro — era isso que
  // deixava os andares de cima apagados.
  const slabGeo = new THREE.ExtrudeGeometry(s, { depth: 0.45, bevelEnabled: false });
  slabGeo.rotateX(Math.PI / 2);
  g.add(put(new THREE.Mesh(slabGeo, [mat.floor, mat.slab]), 0, y, 0));

  g.add(outline([...shape, shape[0]], mat.edge, y + 0.05));

  // Ladrilhos: as duas famílias de linhas, discretas.
  for (let i = 1; i < p.x; i++) g.add(outline([world(i, 0, floor), world(i, p.z, floor)], mat.line, y + 0.04));
  for (let j = 1; j < p.z; j++) g.add(outline([world(0, j, floor), world(p.x, j, floor)], mat.line, y + 0.04));

  // Paredes do fundo e da esquerda; a frente fica aberta para a câmera entrar.
  g.add(put(box(p.x, WALL_H, 0.2, mat.wall), o.x + p.x / 2, y + WALL_H / 2, o.z - 0.1));
  g.add(put(box(0.2, WALL_H, p.z, mat.wall), o.x - 0.1, y + WALL_H / 2, o.z + p.z / 2));

  return g;
}

/** As divisórias entre os cinco cômodos: um plano baixo cada, sem tapar a vista. */
function drawPartitions(floor) {
  const g = new THREE.Group();
  const y = levelY(floor);
  for (let i = 1; i < ROOMS_PER_FLOOR; i++) {
    const at = world((PLATE.x / ROOMS_PER_FLOOR) * i, PLATE.z * 0.42, floor);
    g.add(put(box(0.1, 0.55, PLATE.z * 0.86, mat.divider), at.wx, y + 0.275, at.wz));
  }
  return g;
}

/**
 * O lance que liga `floor` ao andar de cima: uma caixa por degrau, mais as duas
 * laterais e o patamar de desembarque. Sem as laterais os degraus flutuavam soltos
 * e a subida parecia acontecer onde não havia escada.
 */
function drawStairs(floor) {
  const g = new THREE.Group();
  const foot = stairFoot(floor);
  const head = stairHead(floor);
  const dx = head.wx - foot.wx;
  const dz = head.wz - foot.wz;
  const runTotal = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const width = STAIR_W;

  let prev = foot;
  for (const st of stairSteps(floor)) {
    const h = st.wy - prev.wy;
    const run = Math.hypot(st.wx - prev.wx, st.wz - prev.wz);
    // O degrau é um bloco cheio até o piso do degrau anterior: escada de
    // concreto, não tábua no ar.
    const rise = Math.max(0.22, h);
    const step = box(width, rise, run + 0.06, mat.step);
    step.position.set((st.wx + prev.wx) / 2, st.wy - rise / 2, (st.wz + prev.wz) / 2);
    step.rotation.y = yaw;
    g.add(step);
    prev = st;
  }

  // As duas laterais, seguindo a inclinação do lance.
  const pitch = -Math.atan2(head.wy - foot.wy, runTotal);
  for (const side of [-1, 1]) {
    const rail = box(0.18, 0.5, runTotal, mat.slab);
    const off = new THREE.Vector3(Math.cos(yaw) * side * (width / 2), 0, -Math.sin(yaw) * side * (width / 2));
    rail.position.set((foot.wx + head.wx) / 2 + off.x, (foot.wy + head.wy) / 2 + 0.3, (foot.wz + head.wz) / 2 + off.z);
    rail.rotation.set(pitch, yaw, 0, 'YXZ');
    rail.rotation.y = yaw;
    rail.rotation.x = pitch;
    g.add(rail);
  }

  // Patamar no topo: onde o robô desembarca antes de andar pelo corredor.
  const land = box(width + 0.4, 0.3, 1.6, mat.step);
  land.position.set(head.wx, head.wy - 0.15, head.wz);
  land.rotation.y = yaw;
  g.add(land);

  return g;
}

/** As quatro estações do térreo, cada uma com sua silhueta. */
function drawStations() {
  const g = new THREE.Group();
  for (const [kind, st] of Object.entries(STATIONS)) {
    const s = new THREE.Group();
    if (kind === 'terminal') {
      s.add(put(box(1.9, 0.16, 1.1, mat.station), 0, 0.76, 0));
      s.add(put(box(0.24, 0.76, 0.24, mat.dark), 0, 0.38, 0));
      s.add(put(box(1.5, 0.9, 0.1, mat.screen), 0, 1.36, -0.42));
      s.add(put(box(1.6, 1.02, 0.16, mat.station), 0, 1.36, -0.5));
    } else if (kind === 'library') {
      s.add(put(box(2.2, 2.0, 0.5, mat.station), 0, 1.0, -0.3));
      for (let i = 0; i < 3; i++) s.add(put(box(2.05, 0.08, 0.56, mat.dark), 0, 0.5 + i * 0.6, -0.3));
    } else if (kind === 'whiteboard') {
      s.add(put(box(2.4, 1.5, 0.12, mat.screen), 0, 1.4, -0.3));
      s.add(put(box(2.52, 1.62, 0.2, mat.station), 0, 1.4, -0.38));
    } else {
      s.add(put(box(1.5, 1.7, 1.0, mat.station), 0, 0.85, 0));
      for (let i = 0; i < 3; i++) s.add(put(box(1.1, 0.07, 0.07, mat.dark), 0, 0.45 + i * 0.5, 0.52));
    }
    s.position.set(st.wx, st.wy, st.wz);
    g.add(s);
    labelFor('station:' + kind, st.label, st.wx, st.wy + 0.2, st.wz + 1.2, 'station');
  }
  return g;
}

/** A porta do prédio: dois batentes e a soleira. */
function drawDoor() {
  const g = new THREE.Group();
  g.add(put(box(0.22, 2.4, 0.22, mat.station), DOOR.wx - 0.95, DOOR.wy + 1.2, DOOR.wz));
  g.add(put(box(0.22, 2.4, 0.22, mat.station), DOOR.wx + 0.95, DOOR.wy + 1.2, DOOR.wz));
  g.add(put(box(2.2, 0.12, 0.6, mat.step), DOOR.wx, DOOR.wy + 0.06, DOOR.wz));
  return g;
}

function drawBuilding(floors) {
  building.clear();
  clearLabels('station');

  building.add(drawPlatform(GROUND_FLOOR));
  building.add(drawStations());
  building.add(drawDoor());

  for (let f = 0; f < floors; f++) {
    building.add(drawPlatform(f));
    building.add(drawPartitions(f));
  }
  // Um lance por vão: do térreo ao 1º andar, e daí para cima.
  for (let f = GROUND_FLOOR; f < floors - 1; f++) building.add(drawStairs(f));
}

// ── móveis ────────────────────────────────────────────────────────────────

function mountProp(prop) {
  const g = new THREE.Group();
  if (prop.kind === 'shelf') {
    // estante: duas laterais, prateleiras e o vão escuro no fundo
    g.add(put(box(0.14, 1.7, 0.6, mat.furniture), -0.7, 0.85, 0));
    g.add(put(box(0.14, 1.7, 0.6, mat.furniture), 0.7, 0.85, 0));
    g.add(put(box(1.5, 0.12, 0.62, mat.furniture), 0, 1.7, 0));
    g.add(put(box(1.4, 1.6, 0.1, mat.dark), 0, 0.85, -0.26));
    for (let i = 0; i < 3; i++) g.add(put(box(1.36, 0.1, 0.58, mat.furniture), 0, 0.3 + i * 0.5, 0));
  } else {
    // mesa: tampo, dois pés, a tela virada para quem trabalha e a cadeira
    g.add(put(box(1.9, 0.12, 1.0, mat.furniture), 0, 0.74, 0));
    g.add(put(box(0.14, 0.74, 0.8, mat.furniture), -0.82, 0.37, 0));
    g.add(put(box(0.14, 0.74, 0.8, mat.furniture), 0.82, 0.37, 0));
    g.add(put(box(1.05, 0.6, 0.07, mat.screen), 0, 1.12, -0.3));
    g.add(put(box(1.15, 0.7, 0.12, mat.furniture), 0, 1.12, -0.36));
    // cadeira: assento e encosto, do lado de quem usa
    g.add(put(box(0.6, 0.08, 0.6, mat.furniture), 0, 0.46, 0.85));
    g.add(put(box(0.6, 0.55, 0.09, mat.furniture), 0, 0.72, 1.1));
    g.add(put(box(0.1, 0.46, 0.1, mat.dark), 0, 0.23, 0.85));
  }
  g.position.set(prop.wx, prop.wy, prop.wz);
  building.add(g);
  props.set(prop.key, { group: g, lit: 0, prop });
}

function hitProp(prop, subject) {
  const rec = props.get(prop.key);
  if (!rec) return;
  rec.lit = performance.now();
  rec.group.traverse((o) => { if (o.isMesh && o.material === mat.screen) o.material = mat.screenLit; });
  // O móvel é fixo e genérico (issue #14): o que passa por ele agora aparece
  // como rótulo temporário, e o histórico fica no registro.
  if (subject) labelFor('prop:' + prop.key, subject, prop.wx, prop.wy + 1.9, prop.wz, 'prop', 2600);
}

function moveProp(prop) {
  const rec = props.get(prop.key);
  if (rec) rec.group.position.set(prop.wx, prop.wy, prop.wz);
}

function removeProp(key) {
  const rec = props.get(key);
  if (!rec) return;
  building.remove(rec.group);
  props.delete(key);
  dropLabel('prop:' + key);
}

// ── o robô ────────────────────────────────────────────────────────────────

// A tela-rosto é uma textura de canvas desenhada na hora, com o matiz do agente:
// vetorial em espírito, sem sprite pré-renderizado por cor — que é o que a
// invariante do CLAUDE.md proíbe.
function faceTexture(hue, mood, isMain) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#060c14';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = mood === 'error' ? '#ff6b6b' : isMain ? '#ffffff' : `hsl(${hue} 92% 76%)`;
  x.strokeStyle = x.fillStyle;
  x.lineWidth = 5;
  x.lineCap = 'round';
  if (mood === 'error') {
    for (const cx of [21, 43]) {
      x.beginPath();
      x.moveTo(cx - 7, 22); x.lineTo(cx + 7, 36);
      x.moveTo(cx + 7, 22); x.lineTo(cx - 7, 36);
      x.stroke();
    }
  } else if (mood === 'work') {
    x.beginPath(); x.moveTo(14, 28); x.lineTo(28, 28); x.moveTo(36, 28); x.lineTo(50, 28); x.stroke();
    x.beginPath(); x.moveTo(26, 45); x.lineTo(38, 45); x.stroke();
  } else {
    for (const cx of [21, 43]) { x.beginPath(); x.arc(cx, 28, 6.5, 0, Math.PI * 2); x.fill(); }
    x.beginPath(); x.moveTo(26, 45); x.lineTo(38, 45); x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// O principal não tem matiz: tem o arco-íris. Em 3D isso é uma textura de
// gradiente na carcaça — o mesmo arco-íris que o elenco e o registro pintam.
function rainbowTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 8;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 128, 0);
  for (const [at, col] of [[0, '#e85d5d'], [0.2, '#e8a13d'], [0.4, '#e3d24a'],
                           [0.6, '#4fbc86'], [0.8, '#5b95d6'], [1, '#a97fd0']]) g.addColorStop(at, col);
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const RAINBOW = rainbowTexture();

function mountBot(agent, at) {
  const hue = hueOf(agent);
  const shell = agent.isMain
    ? new THREE.MeshLambertMaterial({ map: RAINBOW })
    : new THREE.MeshLambertMaterial({ color: hueColor(hue) });
  const dark = new THREE.MeshLambertMaterial({ color: 0x2b3746 });

  const g = new THREE.Group();
  // A esteira é o que toca o chão: escura, mas não tão escura quanto a laje —
  // com a mesma cor, o robô parecia afundado no piso.
  g.add(put(box(0.34, 0.32, 1.15, dark), -0.42, 0.16, 0));   // esteira
  g.add(put(box(0.34, 0.32, 1.15, dark), 0.42, 0.16, 0));    // esteira
  g.add(put(box(1.16, 1.0, 1.0, shell), 0, 0.82, 0));       // carcaça
  g.add(put(box(0.5, 0.09, 0.12, shell), 0, 1.37, 0));      // alça

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.82),
    new THREE.MeshBasicMaterial({ map: faceTexture(hue, 'idle', agent.isMain) }),
  );
  face.position.set(0, 0.86, 0.51);
  g.add(face);

  g.position.set(at.wx ?? agent.wx, at.wy ?? agent.wy, at.wz ?? agent.wz);
  building.add(g);

  const rec = { group: g, face, hue, isMain: agent.isMain, queue: [], mood: 'idle', bob: 0 };
  bots.set(agent.id, rec);
  plateFor(agent);
  return rec;
}

function moveBot(id, wx, wy, wz, face, kind, start) {
  const rec = bots.get(id);
  if (!rec) return;
  if (STILL) {
    rec.queue.length = 0;
    rec.group.position.set(wx, wy, wz);
    return;
  }
  // A fila NÃO é descartada quando chega trajeto novo. A cena calcula o caminho a
  // partir da posição lógica do robô — que já é o fim do trajeto anterior —, então
  // o novo caminho começa exatamente onde o antigo termina: concatenar é contínuo,
  // e cortar era o que fazia o robô abandonar a escada no meio e atravessar o ar.
  //
  // O atraso que isso poderia acumular numa rajada é resolvido no laço, andando
  // mais rápido quando a fila cresce (ver `tick`), não teleportando.
  rec.queue.push({ wx, wy, wz, kind, face });
}

function stateBot(agent) {
  const rec = bots.get(agent.id);
  if (!rec) return;
  const mood = agent.status === 'working' ? 'work' : agent.status === 'error' ? 'error' : 'idle';
  if (mood === rec.mood) return;
  rec.mood = mood;
  rec.face.material.map = faceTexture(rec.hue, mood, rec.isMain);
  rec.face.material.needsUpdate = true;
}

function leaveBot(id) {
  const rec = bots.get(id);
  if (!rec) return;
  building.remove(rec.group);
  bots.delete(id);
  dropLabel('plate:' + id);
  dropLabel('bubble:' + id);
}

// ── rótulos: DOM projetado sobre a cena ───────────────────────────────────
//
// Texto continua sendo DOM, não textura: é o que mantém a tipografia nítida em
// qualquer zoom. Cada rótulo guarda o ponto de mundo e é reposicionado por
// quadro, projetando com a câmera.

const labels = new Map();   // key -> {node, at, kind, until, follow}

function labelFor(key, text, wx, wy, wz, kind, ttl) {
  let rec = labels.get(key);
  if (!rec) {
    const node = document.createElement('div');
    node.className = 'tag3d ' + kind;
    $overlay.appendChild(node);
    rec = { node, kind };
    labels.set(key, rec);
  }
  rec.node.textContent = text;
  rec.at = new THREE.Vector3(wx, wy, wz);
  rec.until = ttl ? performance.now() + ttl : 0;
  return rec;
}

function plateFor(agent) {
  if (agent.room == null) return;
  const q = roomQuad(agent.room);
  const rec = labelFor(
    'plate:' + agent.id,
    agent.isMain ? 'principal' : agent.type,
    (q[0].wx + q[1].wx) / 2, q[0].wy + WALL_H - 0.3, q[0].wz,
    'plate',
  );
  rec.node.style.setProperty('--h', hueOf(agent));
  if (agent.isMain) rec.node.dataset.main = '';
  if (agent.away) rec.node.dataset.away = '';
  else delete rec.node.dataset.away;
}

function dropLabel(key) {
  const rec = labels.get(key);
  if (!rec) return;
  rec.node.remove();
  labels.delete(key);
}

function clearLabels(kind) {
  for (const [key, rec] of labels) {
    if (rec.kind === kind) { rec.node.remove(); labels.delete(key); }
  }
}

function sayBot(id, text, tone) {
  if (STILL || !text) return;   // balão é do agora; o passado fica no registro
  const rec = bots.get(id);
  if (!rec) return;
  const p = rec.group.position;
  const b = labelFor('bubble:' + id, text, p.x, p.y + 2.3, p.z, 'bubble', 5200 + Math.min(text.length * 26, 3200));
  b.node.dataset.tone = tone;
  b.follow = id;
}

// ── câmera e laço ─────────────────────────────────────────────────────────

// Enquadra o prédio inteiro: a vista empilhada, e a única que existe. A caixa vem
// do scene.mjs e cresce com os andares, incluindo o escalonamento diagonal — sem
// isso o prédio sai de quadro para o lado conforme sobe.
const bbox = new THREE.Box3();
const bmin = new THREE.Vector3();
const bmax = new THREE.Vector3();

function frame() {
  // A caixa vem do grafo desenhado, não de conta analítica: escada, mobília e
  // robô também ocupam espaço, e era por fora deles que o prédio saía de quadro.
  const model = buildingBounds(scene);
  // Sem atualizar as matrizes, a caixa mede posições de um quadro atrás — e o
  // prédio ficava meio andar fora de quadro logo depois de crescer.
  three.updateMatrixWorld(true);
  bbox.makeEmpty();
  bbox.expandByObject(building);
  if (bbox.isEmpty()) {
    bmin.set(model.min.x, model.min.y, model.min.z);
    bmax.set(model.max.x, model.max.y, model.max.z);
  } else {
    bmin.copy(bbox.min);
    bmax.copy(bbox.max);
  }
  const b = { min: bmin, max: bmax };
  const center = new THREE.Vector3().addVectors(bmin, bmax).multiplyScalar(0.5);

  camera.position.copy(center).addScaledVector(viewDir(), 200);
  camera.lookAt(center);
  camera.updateMatrixWorld();

  const r = $stage.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);

  // Enquadrar de olho não funciona em ortográfica inclinada: a largura na tela
  // depende do ângulo, não das medidas do prédio. Então projeto os oito cantos
  // da caixa no referencial da câmera e mido a extensão real.
  const inv = camera.matrixWorldInverse ?? new THREE.Matrix4().copy(camera.matrixWorld).invert();
  let w = 0;
  let h = 0;
  const p = new THREE.Vector3();
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) {
        p.set(x, y, z).applyMatrix4(inv);
        w = Math.max(w, Math.abs(p.x));
        h = Math.max(h, Math.abs(p.y));
      }
    }
  }
  const pad = 1.14;
  const aspect = Math.max(0.2, r.width / Math.max(1, r.height));

  // Os trilhos flutuam por cima do palco, então a largura do canvas não é a
  // largura livre: o prédio tem de caber (e se centrar) na faixa que sobra entre
  // elenco e registro, senão ele fica desenhado atrás dos painéis.
  const leftRail = el('roster').offsetWidth;
  const rightRail = el('feed').offsetWidth;
  const freeW = Math.max(120, r.width - leftRail - rightRail);
  const freeAspect = Math.max(0.2, freeW / Math.max(1, r.height));

  const half = (Math.max(h, w / freeAspect) * pad) / view.zoom;
  const unitsPerPx = (2 * half * aspect) / Math.max(1, r.width);
  const shift = ((leftRail - rightRail) / 2) * unitsPerPx;

  camera.top = half;
  camera.bottom = -half;
  camera.left = -half * aspect - shift;
  camera.right = half * aspect - shift;
  camera.updateProjectionMatrix();
}

/** Mantém o prédio desenhado do tamanho da sessão. */
function syncBuilding() {
  const floors = floorCount(scene);
  if (floors !== drawnFloors) {
    drawnFloors = floors;
    drawBuilding(floors);
    // Redesenhar o prédio limpa o grupo: robôs e móveis voltam para ele.
    for (const rec of bots.values()) building.add(rec.group);
    for (const rec of props.values()) building.add(rec.group);
  }
  frame();
}

const SPEED = 3.4;          // unidades de mundo por segundo — o passo do robô
const STAIR_SPEED = 2.0;    // degrau é mais devagar que piso plano

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  for (const rec of bots.values()) {
    const leg = rec.queue[0];
    if (leg) {
      const p = rec.group.position;
      p.y -= rec.bob;   // desfaz o balanço do quadro anterior antes de andar
      // Recuperação de atraso: quanto mais pernas pendentes, mais rápido o robô
      // anda — sem nunca sair do caminho. Numa rajada de ferramentas ele corre;
      // parado, anda no ritmo normal.
      const rush = Math.min(3.5, 1 + rec.queue.length / 6);
      const speed = (leg.kind === 'stair' ? STAIR_SPEED : SPEED) * rush;
      const step = speed * dt;
      const dx = leg.wx - p.x;
      const dy = leg.wy - p.y;
      const dz = leg.wz - p.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= step || dist < 0.001) {
        p.set(leg.wx, leg.wy, leg.wz);
        rec.queue.shift();
        rec.bob = 0;
      } else {
        const t = step / dist;
        p.set(p.x + dx * t, p.y + dy * t, p.z + dz * t);
        // Subindo a escada o robô balança no ritmo do degrau; no plano, não.
        rec.bob = leg.kind === 'stair' ? Math.abs(Math.sin(now / 110)) * 0.09 : 0;
      }
      p.y += rec.bob;
      // A carcaça se vira para onde anda, só o suficiente para se ler.
      rec.group.rotation.y += ((leg.face > 0 ? -0.34 : 0.34) - rec.group.rotation.y) * 0.12;
    }
  }

  // Móveis acesos esfriam sozinhos.
  for (const rec of props.values()) {
    if (rec.lit && now - rec.lit > 900) {
      rec.lit = 0;
      rec.group.traverse((o) => { if (o.isMesh && o.material === mat.screenLit) o.material = mat.screen; });
    }
  }

  if (params.has('probe')) probeAir(now);
  placeLabels(now);
  renderer.render(three, camera);
  requestAnimationFrame(tick);
}

// Sonda de "robô no ar": conta quadros em que um robô muda de altura fora de uma
// perna de escada. Serve para provar, com número, que ninguém sobe pelo ar.
const airState = new Map();
let airFrames = 0;
let airWorst = 0;

function probeAir() {
  for (const [id, rec] of bots) {
    const y = rec.group.position.y - rec.bob;
    const prev = airState.get(id);
    const kind = rec.queue[0]?.kind;
    if (prev != null && Math.abs(y - prev) > 0.004 && kind !== 'stair') {
      airFrames++;
      airWorst = Math.max(airWorst, Math.abs(y - prev));
    }
    airState.set(id, y);
  }
  document.documentElement.dataset.air = `${airFrames}|${airWorst.toFixed(3)}`;
}

const v = new THREE.Vector3();
function placeLabels(now) {
  const r = $stage.getBoundingClientRect();
  for (const [key, rec] of labels) {
    if (rec.until && now > rec.until) { dropLabel(key); continue; }
    if (rec.follow) {
      const bot = bots.get(rec.follow);
      if (!bot) { dropLabel(key); continue; }
      rec.at.set(bot.group.position.x, bot.group.position.y + 2.3, bot.group.position.z);
    }
    v.copy(rec.at).project(camera);
    rec.node.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * r.width}px, ${(-v.y * 0.5 + 0.5) * r.height}px)`;
  }
}

// ── órbita: arrastar gira, roda aproxima, duplo clique volta ──────────────
//
// Escrito à mão em vez de vendorizar o OrbitControls: são vinte linhas, e o
// controle oficial traz pan e damping que aqui só atrapalhariam — o prédio tem
// de continuar centrado sozinho.

let drag = null;

$canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  $canvas.setPointerCapture(e.pointerId);
  $canvas.style.cursor = 'grabbing';
});

$canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  orbited = true;
  view.azim -= dx * 0.006;
  // A elevação para antes do horizonte e antes do zênite: por baixo do prédio
  // não há nada para ver, e de cima em pico a planta perde a leitura.
  view.elev = Math.min(1.45, Math.max(0.16, view.elev - dy * 0.005));
  frame();
});

const endDrag = () => { drag = null; $canvas.style.cursor = 'grab'; };
$canvas.addEventListener('pointerup', endDrag);
$canvas.addEventListener('pointercancel', endDrag);

$canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  orbited = true;
  view.zoom = Math.min(4, Math.max(0.45, view.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  frame();
}, { passive: false });

$canvas.addEventListener('dblclick', () => {
  Object.assign(view, HOME_VIEW);
  orbited = false;
  frame();
});

$canvas.style.cursor = 'grab';
$canvas.title = 'arraste para girar · roda para aproximar · duplo clique volta ao enquadramento';

// ── execução dos comandos da cena ─────────────────────────────────────────

function run(cmds) {
  let touchedCast = false;

  for (const c of cmds) {
    switch (c.op) {
      case 'prop-add': mountProp(c.prop); break;
      case 'prop-hit': if (!c.instant) hitProp(c.prop, c.subject); break;
      case 'prop-move': moveProp(c.prop); break;
      case 'prop-remove': removeProp(c.key); break;
      case 'agent-enter': mountBot(c.agent, c); touchedCast = true; break;
      case 'agent-move': moveBot(c.id, c.wx, c.wy, c.wz, c.face, c.kind, c.start); break;
      case 'agent-state': stateBot(c.agent); touchedCast = true; break;
      case 'agent-leave': leaveBot(c.id); touchedCast = true; break;
      case 'say': if (!c.instant) sayBot(c.id, c.text, c.tone); break;
      case 'log': renderLog(c.event); break;
    }
  }

  if (touchedCast) { renderCast(); renderPlates(); }
  syncBuilding();
  $empty.hidden = scene.agents.size > 0;
}

function renderPlates() {
  clearLabels('plate');
  for (const a of scene.agents.values()) plateFor(a);
}

// ── trilhos (interface 2D) ────────────────────────────────────────────────

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
      ? `<b>${esc(VERB[a.tool] || a.tool)}</b> ${esc(a.subject || '')}`
      : `ocioso · ${a.toolCount} ${a.toolCount === 1 ? 'ação' : 'ações'}`;
    row.innerHTML =
      `<i class="chip"></i>` +
      `<div><div class="cast-name">${esc(a.isMain ? 'principal' : a.type)}</div>` +
      `<div class="cast-doing">${doing}</div></div>`;
    $castList.appendChild(row);
  }
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
}

function clock(at) {
  const d = new Date(at || Date.now());
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Trilhos recolhíveis: o registro e o elenco viram lombada, e a cena fica com o
// espaço. A escolha fica no localStorage.
function railSetup(name, btn) {
  const key = 'office.rail.' + name;
  const set = (off) => {
    $app.dataset[name] = off ? 'off' : 'on';
    btn.title = (off ? 'abrir' : 'recolher') + (name === 'feed' ? ' o registro' : ' o elenco');
    try { localStorage.setItem(key, off ? 'off' : 'on'); } catch {}
    frame();
  };
  let stored = null;
  try { stored = localStorage.getItem(key); } catch {}
  set(stored === 'off');
  btn.addEventListener('click', () => set($app.dataset[name] !== 'off'));
}
railSetup('roster', el('rosterToggle'));
railSetup('feed', el('feedToggle'));

// ── salas ─────────────────────────────────────────────────────────────────

function clearRoom() {
  for (const rec of bots.values()) building.remove(rec.group);
  bots.clear();
  for (const rec of props.values()) building.remove(rec.group);
  props.clear();
  clearLabels('plate');
  clearLabels('bubble');
  clearLabels('prop');
  $logList.replaceChildren();
  logged = 0;
  $logCount.textContent = '';
}

function enterRoom(id, room) {
  currentRoom = id;
  clearRoom();
  drawnFloors = 0;
  // Monta o prédio aplicando a lista de eventos da sessão desde o começo.
  run(rebuild(scene, room?.events));
  renderCast();
  renderPlates();
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

    // SessionEnd mata a sala: sai do seletor na hora. Se era a sala aberta, cai
    // para a próxima viva, ou para a tela vazia se não sobrou nenhuma.
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
new ResizeObserver(frame).observe($stage);
requestAnimationFrame(tick);

if (params.has('demo')) {
  // Sem SSE: a cena vem de um roteiro. Serve para ver o escritório sem o Claude
  // Code rodando — e é o único jeito de um navegador headless tirar print, já
  // que o stream SSE nunca deixa a página "carregar".
  currentRoom = 'demo';
  rooms.set('demo', { id: 'demo', label: 'demonstração', cwd: 'projeto-demo', lastSeen: Date.now() });
  refreshRooms();
  $statusText.textContent = 'demonstração';
  const { playDemo } = await import('./demo.mjs');
  const upto = Number(params.get('upto')) || Infinity;
  await playDemo((ev) => run(apply(scene, ev)), params.has('instant'), upto);
  // Sinal para o print headless: o roteiro acabou e a cena pode ser fotografada.
  requestAnimationFrame(() => { document.documentElement.dataset.ready = 'true'; });
} else {
  connect();
}
