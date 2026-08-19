// Renderizador 3D do escritório: three.js (ADR-0003).
//
// Toda a geometria mora no scene.mjs, que devolve pontos de mundo (wx, wy, wz).
// Aqui só se decide como um ponto vira malha, cor e movimento. O laço de
// animação é o dono do movimento — em 3D não existe `transform` de CSS para a
// motion.dev compor, então ela saiu do renderizador.

import * as THREE from './vendor/three.js';
import { BUILDING, PROPS, NEON, AGENT_HUES, SHELL_L, css } from './palette.mjs';
import {
  createScene, apply, rebuild, buildingBounds, officeShape, walls, partitions,
  deskOf, roomQuad, seatOf, ROOM_COUNT, LOBBY, NECK, PLATE, world, FLOOR_Y,
  WALL_H, DOOR, HUE_COUNT, fixedProps, terrainRect, SCALE, PROP_K,
} from './scene.mjs';

const params = new URLSearchParams(location.search);

// Carimbo do desenho carregado. Suba isto quando o desenho mudar de forma — é o
// que distingue "não mudou" de "o navegador está com o arquivo velho".
const BUILD = '3d · pavimento único · 3 salas';

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
const $card = el('card');
el('build').textContent = BUILD;

// ── estado do cliente ─────────────────────────────────────────────────────

const scene = createScene();
const bots = new Map();     // agentId -> {group, face, queue, mood, hue}
const props = new Map();    // propKey -> {group, lit}
const rooms = new Map();
let currentRoom = null;
let roomActivity = 0;
let logged = 0;
let built = false;   // o escritório já foi montado nesta sessão?

// Os matizes dos subagentes vêm da paleta, que também garante a distância deles em
// relação às cores do prédio (ADR-0004). O principal não usa matiz: leva o
// arco-íris.
const HUES = AGENT_HUES;
const hueOf = (a) => (a.isMain ? 0 : HUES[a.hueIndex % HUES.length]);

/**
 * Como o agente se chama na tela. O `agent_type` sozinho não nomeia ninguém —
 * metade dos subagentes chega como `general-purpose`, e três "general-purpose" na
 * planta não dizem quem é quem. Quando a cena conseguiu um apelido da descrição da
 * tarefa, é ele que aparece; o tipo vira legenda.
 */
const nameOf = (a) => (a.isMain ? 'principal' : a.name || a.type);

// O nome de quem já saiu. O registro é memória e continua citando o agente depois
// que ele deixou o escritório; sem isto a mesma linha do log mudava de nome no meio
// da sessão, do apelido da tarefa de volta para o `agent_type` cru.
const nomes = new Map();
if (HUES.length !== HUE_COUNT) console.warn('paleta e HUE_COUNT divergem: o matiz vai repetir fora de ordem');
// O rosa precisa de mais luz para não ler como o vermelho do rosto de erro.
// Carcaça viva: com o prédio colorido (ADR-0004), a saturação do robô é parte do que
// o separa do fundo — o prédio é claro e menos saturado, ele é saturado e médio.
// A carcaça, no valor que o `selftest` afirma contra o fundo (ADR-0006). O
// `SRGBColorSpace` é obrigatório aqui pelo mesmo motivo que nos materiais do
// prédio: sem ele o matiz chega lavado e os seis agentes convergem para o mesmo
// cinza-azulado.
const hueColor = (h, l = SHELL_L) =>
  new THREE.Color().setHSL(h / 360, 0.88, h >= 300 ? l + 0.04 : l, THREE.SRGBColorSpace);

// ── a cena three ──────────────────────────────────────────────────────────

const three = new THREE.Scene();

// Ortográfica, não perspectiva: é a projeção que mantém a leitura de planta — a
// sala do fundo mede o mesmo que a da frente, e nada afunila com a distância.
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -300, 600);
// A órbita da câmera. O azimute começa na diagonal clássica de planta e a
// elevação, mais alta que a isométrica pura: com a câmera baixa, a parede do
// fundo cobre o piso das salas.
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
// Luz de dia: com o prédio claro (ADR-0004), a luz de antes — feita para o azul
// escuro — achatava tudo. Direcional mais suave, preenchimento mais forte.
// Ambiente branco forte lava a cor: com o escritório vibrante, o amarelo da
// parede saía bege no print. A direcional puxa o volume, o preenchimento fica
// só no suficiente para nenhuma face cair no preto.
// Luz de noite (ADR-0006). Numa cena escura a conta é outra: a direcional só
// desenha o volume das caixas, e **o brilho vem do material**, não da lâmpada —
// néon, tela e carcaça são `MeshBasicMaterial` ou levam `emissive`, então não
// dependem de luz nenhuma. Subir as luzes aqui para "clarear" só lava o azul e
// mata o contraste que faz o néon existir.
const sun = new THREE.DirectionalLight(0xcfe6ff, 1.05);
sun.position.set(9, 16, 7);
three.add(sun);
// Preenchimento frio de cima, e do chão um reflexo violeta — é a rua molhada
// devolvendo a luz da cidade.
three.add(new THREE.HemisphereLight(0x8fb6ff, 0x3a2a5e, 0.62));
three.add(new THREE.AmbientLight(0x9fb4d6, 0.38));

// Os materiais saem da paleta (ADR-0004): o escritório é colorido, e a cor é regra
// do projeto — mora em `palette.mjs`, não aqui.
/**
 * Cor da paleta virando cor de material. O `SRGBColorSpace` no fim **não é
 * detalhe**: sem ele o `three` lê o HSL como se já fosse linear, converte de novo
 * na saída e devolve a cor lavada — o piso areia de 62% de saturação chegava à
 * tela com 20%, e o escritório inteiro parecia creme por mais que a paleta
 * subisse. Medido lendo o pixel do print, não olhando.
 */
const hex = (c) => new THREE.Color().setHSL(c.h / 360, c.s, c.l, THREE.SRGBColorSpace);
const lam = (c, extra = {}) => new THREE.MeshLambertMaterial({ color: hex(c), ...extra });
/**
 * Material de móvel: leva um respiro de emissão do próprio matiz. Com o piso quase
 * preto, o Lambert puro devolvia vulto — a mesa e a estante existiam como massa
 * escura e a cor delas só aparecia na face de cima. A emissão baixa mantém o móvel
 * escuro (ele não pode competir com o robô) e devolve o matiz.
 */
const prop = (c) => new THREE.MeshLambertMaterial({
  color: hex(c),
  emissive: new THREE.Color().setHSL(c.h / 360, c.s, c.l * 0.55, THREE.SRGBColorSpace),
});
const basic = (c) => new THREE.MeshBasicMaterial({ color: hex(c) });
const neonLine = (c, opacity) =>
  new THREE.LineBasicMaterial({ color: hex(c), transparent: true, opacity });

const mat = {
  // O piso é uma textura de xadrez, no tamanho do ladrilho: dois tons alternados,
  // como no piso da referência. Pintar ladrilho por ladrilho custaria uma malha
  // por quadrado.
  floor: new THREE.MeshLambertMaterial({ side: THREE.DoubleSide }),
  slab: lam(BUILDING.slab),
  lobbyFloor: lam(BUILDING.floorB, { side: THREE.DoubleSide }),
  doorFrame: lam(BUILDING.wallTrim),
  // Néon é luz: material sem iluminação, para a fita não escurecer junto com a
  // parede em que ela está pregada.
  neon: basic(BUILDING.wallTrim),
  neonHot: basic(NEON.hot),
  neonCool: basic(NEON.cool),
  wall: lam(BUILDING.wall, { side: THREE.DoubleSide }),
  // Linhas de néon. A grade do chão é fraca de propósito: ela dá escala e textura
  // ao piso sem virar xadrez — foi a falta dela que deixou o chão sem detalhe
  // nenhum quando o escritório virou noite.
  line: neonLine(BUILDING.wallTrim, 0.22),
  lineHot: neonLine(NEON.hot, 0.22),
  edge: neonLine(BUILDING.wallTrim, 0.75),
  edgeHot: neonLine(NEON.hot, 0.75),
  // A aresta de cada volume: é ela que recorta o móvel do piso escuro.
  rim: neonLine(BUILDING.wallTrim, 0.45),
  divider: lam(BUILDING.divider),
  step: lam(BUILDING.stair),
  landing: lam(BUILDING.landing),
  rail: lam(BUILDING.rail),
  terrain: lam(BUILDING.terrain),
  sidewalk: lam(BUILDING.sidewalk),
  furniture: prop(PROPS.desk),
  shelf: prop(PROPS.shelf),
  station: prop(PROPS.terminal),
  library: prop(PROPS.library),
  whiteboard: prop(PROPS.whiteboard),
  cabinet: prop(PROPS.cabinet),
  screen: basic(PROPS.screen),
  screenLit: basic(PROPS.screenLit),
  dark: lam(hsl2(28, 0.30, 0.30)),
};

function hsl2(h, s, l) { return { h, s, l }; }

// Nenhuma superfície de chão fica em cor chapada: piso, calçada e terreno têm
// desenho próprio. Chapado, o chão lia como "falta de piso" — o olho não achava
// escala nem onde uma superfície terminava e a outra começava.
function patternTex(size, draw, rx, ry) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  return t;
}

// O piso é **liso**: uma cor só, sem xadrez e sem malha de ladrilho. O xadrez
// dava textura ao chão e cobrava caro por ela — com móveis espalhados e robôs
// coloridos em cima, o piso quadriculado virava um segundo padrão disputando a
// atenção, e a planta ficava agitada. O que separa um espaço do outro passou a
// ser a cor: salas e corredor num tom, o saguão no outro.
mat.floor.color.copy(hex(BUILDING.floorA));

/** A calçada: lajotas grandes, com a junta acesa de leve pelo néon de cima. */
const sidewalkTex = (rx, ry) => patternTex(64, (x, n) => {
  x.fillStyle = css(BUILDING.sidewalk);
  x.fillRect(0, 0, n, n);
  x.strokeStyle = 'rgba(120,200,255,0.22)';
  x.lineWidth = 2;
  x.strokeRect(0, 0, n, n);
  x.beginPath(); x.moveTo(0, n / 2); x.lineTo(n, n / 2); x.stroke();
}, rx, ry);

/**
 * O terreno: a **rua molhada** (ADR-0006). Eram tufos de grama, de quando o
 * escritório era de dia; à noite a grama lia como um tapete preto em volta do
 * prédio. Agora são poças com o reflexo do néon — manchas frias em posição fixa,
 * porque sorteadas mudariam a cada carga e o print deixaria de comparar.
 */
const terrainTex = (rx, ry) => patternTex(64, (x, n) => {
  x.fillStyle = css(BUILDING.terrain);
  x.fillRect(0, 0, n, n);
  const pocas = [[4, 10, 22, 5], [28, 38, 18, 4], [42, 6, 15, 4], [14, 50, 24, 6], [50, 26, 12, 4]];
  for (const [px0, pz, w, h] of pocas) {
    // O reflexo esmaece na largura, como poça: retângulo chapado lia como fita.
    const g = x.createLinearGradient(px0, 0, px0 + w, 0);
    const cor = (px0 + pz) % 3 === 0 ? '255,79,216' : '53,230,255';
    g.addColorStop(0, `rgba(${cor},0)`);
    g.addColorStop(0.5, `rgba(${cor},0.30)`);
    g.addColorStop(1, `rgba(${cor},0)`);
    x.fillStyle = g;
    x.fillRect(px0, pz, w, h);
  }
}, rx, ry);

// O escritório inteiro vive num grupo só: redesenhar é limpar e montar de novo, o
// que é barato (algumas centenas de malhas) e monta tudo de uma vez.
const building = new THREE.Group();
three.add(building);

// O terreno vive **fora** do grupo que a câmera mede. Ele é maior que o
// escritório de propósito, e enquadrar por ele fazia o escritório aparecer
// pequeno no meio de um mar de calçada — o enquadramento obedecia à grama.
const ground = new THREE.Group();
three.add(ground);

// ── desenho do prédio ─────────────────────────────────────────────────────

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

/** O terreno em que o prédio se apoia, com a calçada em volta do térreo. */
function drawTerrain() {
  const t = terrainRect();
  const g = new THREE.Group();
  const w = t.x1 - t.x0;
  const d = t.z1 - t.z0;
  // A textura nasce com o terreno: a repetição vem da medida do mundo, para a
  // lajota ter o mesmo tamanho em qualquer prédio.
  // Cor branca com a textura por cima: a textura **já** carrega a cor da paleta, e
  // deixar a do material multiplicando de novo elevava o tom ao quadrado. Com o
  // terreno a 11% de luz isso dava preto puro, e a rua sumia — o chão de fora
  // parecia um buraco recortado em volta do escritório.
  const chao = mat.terrain.clone();
  chao.color.set(0xffffff);
  chao.map = terrainTex(w / 9, d / 9);
  g.add(put(box(w, 0.5, d, chao), (t.x0 + t.x1) / 2, t.y - 0.25, (t.z0 + t.z1) / 2));
  // Calçada: uma laje clara sob a pegada do prédio, um fio acima do terreno.
  const calc = mat.sidewalk.clone();
  calc.color.set(0xffffff);
  calc.map = sidewalkTex((w - 2.4) / 3, (d - 2.4) / 3);
  g.add(put(box(w - 2.4, 0.12, d - 2.4, calc), (t.x0 + t.x1) / 2, t.y + 0.06, (t.z0 + t.z1) / 2));
  // Uma faixa de calçada mais clara em volta da pegada do térreo, para o prédio
  // assentar em algo em vez de nascer do nada.
  g.add(outline([
    { wx: t.x0 + 1.6, wz: t.z0 + 1.6 }, { wx: t.x1 - 1.6, wz: t.z0 + 1.6 },
    { wx: t.x1 - 1.6, wz: t.z1 - 1.6 }, { wx: t.x0 + 1.6, wz: t.z1 - 1.6 },
    { wx: t.x0 + 1.6, wz: t.z0 + 1.6 },
  ], mat.line, t.y + 0.01));
  return g;
}

/**
 * O pavimento: a laje em T, o piso liso, o piso próprio do saguão e o arremate
 * da borda. Um só — não há andares.
 */
function drawSlab() {
  const shape = officeShape();
  const g = new THREE.Group();

  // A laje é o contorno extrudado para baixo: é a espessura dela que se lê como
  // "piso construído" quando a cena é olhada de lado.
  const s = new THREE.Shape(shape.map((pt) => new THREE.Vector2(pt.wx, pt.wz)));
  // A extrusão traz dois grupos de face, nesta ordem: as tampas e as laterais.
  // Invertê-los pinta o topo com a cor da borda e o piso inteiro aparece apagado.
  const slabGeo = new THREE.ExtrudeGeometry(s, { depth: 0.45, bevelEnabled: false });
  slabGeo.rotateX(Math.PI / 2);
  g.add(put(new THREE.Mesh(slabGeo, [mat.floor, mat.slab]), 0, FLOOR_Y, 0));

  // O saguão tem piso próprio: é a cor que diz "aqui é a entrada", sem rótulo e
  // sem desenho no chão. Um fio acima da laje, para não brigar por z-fighting.
  const piso = new THREE.Mesh(new THREE.PlaneGeometry(LOBBY.w, LOBBY.d), mat.lobbyFloor);
  piso.rotation.x = -Math.PI / 2;
  piso.position.set(LOBBY.lx + LOBBY.w / 2, FLOOR_Y + 0.012, LOBBY.lz + LOBBY.d / 2);
  g.add(piso);

  g.add(outline([...shape, shape[0]], mat.edge, FLOOR_Y + 0.05));
  // O saguão ganha o próprio contorno, no magenta dele.
  g.add(outline([
    world(LOBBY.lx, LOBBY.lz), world(LOBBY.lx + LOBBY.w, LOBBY.lz),
    world(LOBBY.lx + LOBBY.w, LOBBY.lz + LOBBY.d), world(LOBBY.lx, LOBBY.lz + LOBBY.d),
    world(LOBBY.lx, LOBBY.lz),
  ], mat.edgeHot, FLOOR_Y + 0.05));

  g.add(drawGrid());
  return g;
}

/**
 * A grade do piso: fios de néon fracos a cada dois ladrilhos, recortados ao
 * contorno. Não é o xadrez de volta — o piso continua liso, de uma cor só. É luz
 * desenhada sobre ele, e é o que dá escala e profundidade a um chão que, sem nada,
 * lê como um buraco preto.
 */
// O passo da grade acompanha a escala da planta: fixo em 2, o escritório a 1,7×
// ganhava metade a mais de fios e a grade virava trama.
const GRID_STEP = 2 * SCALE;

function drawGrid() {
  const g = new THREE.Group();
  const y = FLOOR_Y + 0.03;
  // Cada fio é cortado nos trechos em que a planta existe naquela coordenada: um
  // fio atravessando o vazio ao lado da galeria denunciava na hora que a grade era
  // decoração colada, e não piso.
  const spans = (fixo, aoLongoDeX) => {
    const out = [];
    const t = 0.02;
    const passo = 0.25;
    let ini = null;
    for (let v = 0; v <= (aoLongoDeX ? PLATE.x : PLATE.z) + passo; v += passo) {
      const p = aoLongoDeX ? { wx: v, wz: fixo } : { wx: fixo, wz: v };
      const dentro = insideShape(p);
      if (dentro && ini === null) ini = v;
      if (!dentro && ini !== null) { out.push([ini + t, v - passo - t]); ini = null; }
    }
    if (ini !== null) out.push([ini + t, (aoLongoDeX ? PLATE.x : PLATE.z) - t]);
    return out;
  };

  for (let x = GRID_STEP; x < PLATE.x; x += GRID_STEP) {
    for (const [a, b] of spans(x, false)) {
      if (b - a < 0.3) continue;
      g.add(outline([world(x, a), world(x, b)], a >= LOBBY.lz ? mat.lineHot : mat.line, y));
    }
  }
  for (let z = GRID_STEP; z < PLATE.z; z += GRID_STEP) {
    for (const [a, b] of spans(z, true)) {
      if (b - a < 0.3) continue;
      g.add(outline([world(a, z), world(b, z)], z >= LOBBY.lz ? mat.lineHot : mat.line, y));
    }
  }
  return g;
}

/** Um ponto está dentro do contorno do pavimento? */
function insideShape(p) {
  const poly = officeShape();
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.wz > p.wz) !== (b.wz > p.wz) &&
        p.wx < ((b.wx - a.wx) * (p.wz - a.wz)) / (b.wz - a.wz) + a.wx) hit = !hit;
  }
  return hit;
}

/** Um segmento de parede (ou divisória) com espessura, deitado entre dois pontos. */
function drawWallSeg(seg, thickness, material) {
  const dx = seg.b.wx - seg.a.wx;
  const dz = seg.b.wz - seg.a.wz;
  const len = Math.hypot(dx, dz);
  const m = box(thickness, seg.h, len + thickness, material);
  // A base fica em y = 0 e a altura sobe daí: é o que deixa o chamador empilhar
  // uma fita fina no topo ou no rodapé com um `translateY` legível.
  m.position.set((seg.a.wx + seg.b.wx) / 2, FLOOR_Y + seg.h / 2, (seg.a.wz + seg.b.wz) / 2);
  m.rotation.y = Math.atan2(dx, dz);
  return m;
}

/**
 * As paredes externas, cada uma com **duas fitas de néon**: uma na quina de cima e
 * outra rente ao chão. É delas que o Sumida vive — a parede em si é quase preta, e
 * quem desenha a planta é a luz correndo pela quina dela. Sem o rodapé aceso, o
 * encontro da parede com o piso escuro some e a sala perde o contorno.
 */
const FITA = 0.07;   // espessura da fita: fina, senão vira parede clara

function drawWalls() {
  const g = new THREE.Group();
  for (const [i, seg] of walls().entries()) {
    g.add(drawWallSeg(seg, 0.22, mat.wall));
    // Ciano no geral, magenta na galeria e no saguão: a passagem para a entrada
    // muda de cor, e é assim que ela se anuncia antes de o robô chegar lá.
    const quente = seg.a.wz > NECK.lz + 1e-9 || seg.b.wz > NECK.lz + 1e-9;
    const luz = quente ? mat.neonHot : mat.neon;
    g.add(drawWallSeg({ ...seg, h: FITA }, 0.26, luz).translateY(seg.h - FITA / 2));
    g.add(drawWallSeg({ ...seg, h: FITA }, 0.26, luz).translateY(0.06));
  }
  return g;
}

/**
 * As divisórias entre as três salas. Mais baixas que a parede externa de
 * propósito: na altura da parede elas tapavam a sala do fundo, e a planta perdia
 * justamente o que ela existe para mostrar.
 */
function drawPartitions() {
  const g = new THREE.Group();
  for (const seg of partitions()) g.add(drawWallSeg({ ...seg, h: 0.95 }, 0.14, mat.divider));
  return g;
}

/**
 * A mobília: montada uma vez com o prédio, e nunca desmontada. Ela é da planta,
 * não do ocupante — sala sem gente continua sendo uma sala mobiliada.
 */
function drawFurniture() {
  const g = new THREE.Group();
  for (const prop of fixedProps()) {
    const v = propVolume(prop.kind, PROP_K * (prop.station ? 1.15 : 1));
    v.position.set(prop.wx, prop.wy, prop.wz);
    v.rotation.y = prop.rot || 0;
    g.add(v);
    props.set(prop.key, { group: v, lit: 0, prop });
    // Só a estação leva rótulo. Escrever "mesa" seis vezes na planta era ruído: o
    // volume já diz o que é, e o que passa por ele aparece no rótulo temporário.
    if (prop.station) labelFor('station:' + prop.key, prop.label, prop.wx, prop.wy + 0.2, prop.wz + 1.4, 'station');
  }
  return g;
}

/**
 * O nome de cada espaço, escrito no chão dele. Com três salas iguais lado a lado,
 * sem nome elas viram uma fita só e ninguém sabe dizer onde um agente está — o
 * rótulo é o endereço.
 */
function drawSpaceLabels() {
  for (let i = 0; i < ROOM_COUNT; i++) {
    const q = roomQuad(i);
    labelFor('space:sala' + i, `SALA ${i + 1}`,
      (q[0].wx + q[1].wx) / 2, FLOOR_Y + 0.02, q[2].wz - 0.6, 'space');
  }
  // O nome do saguão fica recuado da borda: na frente, ele caía atrás da porta e
  // a palavra sumia dentro do batente.
  labelFor('space:saguao', 'SAGUÃO',
    LOBBY.lx + LOBBY.w / 2, FLOOR_Y + 0.02, LOBBY.lz + LOBBY.d - 2.6, 'space');
}

function drawBuilding() {
  building.clear();
  clearLabels('station');
  clearLabels('space');
  props.clear();

  ground.clear();
  ground.add(drawTerrain());
  building.add(drawSlab());
  building.add(drawWalls());
  building.add(drawPartitions());
  building.add(drawFurniture());
  drawSpaceLabels();

  if (params.has('probe')) {
    const b = buildingBounds();
    document.documentElement.dataset.plats =
      `pavimento único y=${FLOOR_Y} verts=${officeShape().length} salas=${ROOM_COUNT} móveis=${fixedProps().length}` +
      ` caixa=${b.min.x},${b.min.z}..${b.max.x},${b.max.z}`;
  }
}

// ── volumes de móvel (issue #12) ──────────────────────────────────────────
//
// Um construtor só para os sete tipos, usado pela estação do térreo e pelo móvel
// do cômodo. Antes eram dois desenhos separados: a estação tinha silhueta e o
// móvel do cômodo caía sempre em mesa ou estante, então o mesmo `kind` aparecia
// de duas formas no mesmo prédio. Todo volume nasce **assentado no ladrilho** —
// nada com y negativo — e a ordem de profundidade fica com o z-buffer do three.
const PROP_MAT = {
  desk: () => mat.furniture,
  shelf: () => mat.shelf,
  terminal: () => mat.station,
  library: () => mat.library,
  whiteboard: () => mat.whiteboard,
  cabinet: () => mat.cabinet,
  // A porta não usa o azul da estação: azul já quer dizer terminal na cena.
  door: () => mat.doorFrame,
};

function propVolume(kind, k = 1) {
  const g = new THREE.Group();
  const corpo = (PROP_MAT[kind] || PROP_MAT.desk)();
  /**
   * Uma caixa do móvel, com a **aresta de cima acesa**. É o recorte que faz o
   * volume existir: num piso quase preto, a face superior do móvel e o chão têm
   * quase o mesmo valor, e sem o fio de luz o móvel some no piso — vira mancha, não
   * objeto. O fio fica só no topo; em todas as arestas, a sala vira arame.
   */
  const b = (w, h, d, m, x, y, z) => {
    g.add(put(box(w * k, h * k, d * k, m), x * k, y * k, z * k));
    const hw = (w * k) / 2, hd = (d * k) / 2;
    const top = (y + h / 2) * k;
    const pts = [
      { wx: (x * k) - hw, wy: top, wz: (z * k) - hd },
      { wx: (x * k) + hw, wy: top, wz: (z * k) - hd },
      { wx: (x * k) + hw, wy: top, wz: (z * k) + hd },
      { wx: (x * k) - hw, wy: top, wz: (z * k) + hd },
    ];
    g.add(outline([...pts, pts[0]], mat.rim));
  };

  switch (kind) {
    case 'terminal':
      // bancada com pé central, monitor de costas para a parede
      b(1.9, 0.16, 1.1, corpo, 0, 0.76, 0);
      b(0.24, 0.76, 0.24, mat.dark, 0, 0.38, 0);
      b(1.6, 1.02, 0.16, corpo, 0, 1.36, -0.5);
      b(1.5, 0.9, 0.1, mat.screen, 0, 1.36, -0.42);
      break;

    case 'library':
      // caixa alta encostada na parede, com as três prateleiras à vista
      b(2.2, 2.0, 0.5, corpo, 0, 1.0, -0.3);
      for (let i = 0; i < 3; i++) b(2.05, 0.08, 0.56, mat.dark, 0, 0.5 + i * 0.6, -0.3);
      break;

    case 'whiteboard':
      // painel fino sobre dois pés: é o pé que o tira do chão e dá o volume
      b(2.52, 1.32, 0.2, corpo, 0, 1.5, -0.38);
      b(2.4, 1.2, 0.12, mat.screen, 0, 1.5, -0.3);
      b(0.12, 0.84, 0.12, mat.dark, -1.0, 0.42, -0.34);
      b(0.12, 0.84, 0.12, mat.dark, 1.0, 0.42, -0.34);
      break;

    case 'cabinet':
      // arquivo: bloco com três gavetas e puxador saliente
      b(1.5, 1.7, 1.0, corpo, 0, 0.85, 0);
      for (let i = 0; i < 3; i++) {
        b(1.36, 0.46, 0.06, mat.dark, 0, 0.45 + i * 0.52, 0.5);
        b(0.5, 0.08, 0.1, mat.dark, 0, 0.45 + i * 0.52, 0.54);
      }
      break;

    case 'shelf':
      // estante: duas laterais, prateleiras e o vão escuro no fundo
      b(0.14, 1.7, 0.6, corpo, -0.7, 0.85, 0);
      b(0.14, 1.7, 0.6, corpo, 0.7, 0.85, 0);
      b(1.5, 0.12, 0.62, corpo, 0, 1.7, 0);
      b(1.4, 1.6, 0.1, mat.dark, 0, 0.85, -0.26);
      for (let i = 0; i < 3; i++) b(1.36, 0.1, 0.58, corpo, 0, 0.3 + i * 0.5, 0);
      break;

    case 'door':
      // porta: dois batentes, verga e soleira — o vão é o que se lê
      b(0.22, 2.4, 0.22, corpo, -0.95, 1.2, 0);
      b(0.22, 2.4, 0.22, corpo, 0.95, 1.2, 0);
      b(2.12, 0.22, 0.22, corpo, 0, 2.29, 0);
      b(2.2, 0.12, 0.6, mat.step, 0, 0.06, 0);
      break;

    default:
      // mesa: tampo, dois pés, a tela virada para quem trabalha e a cadeira
      b(1.9, 0.12, 1.0, corpo, 0, 0.74, 0);
      b(0.14, 0.74, 0.8, corpo, -0.82, 0.37, 0);
      b(0.14, 0.74, 0.8, corpo, 0.82, 0.37, 0);
      b(1.15, 0.7, 0.12, corpo, 0, 1.12, -0.36);
      b(1.05, 0.6, 0.07, mat.screen, 0, 1.12, -0.3);
      b(0.6, 0.08, 0.6, corpo, 0, 0.46, 0.85);
      b(0.6, 0.55, 0.09, corpo, 0, 0.72, 1.1);
      b(0.1, 0.46, 0.1, mat.dark, 0, 0.23, 0.85);
      break;
  }
  return g;
}

// ── móveis ────────────────────────────────────────────────────────────────

function hitProp(prop, subject) {
  const rec = props.get(prop.key);
  if (!rec) return;
  rec.lit = performance.now();
  rec.group.traverse((o) => { if (o.isMesh && o.material === mat.screen) o.material = mat.screenLit; });
  // O móvel é fixo e genérico (issue #14): o que passa por ele agora aparece
  // como rótulo temporário, e o histórico fica no registro.
  // Acima do volume, não sobre ele: a 1,9 o rótulo do que passa caía em cima do
  // rótulo fixo da estação, e as duas palavras se liam como uma só.
  if (subject) labelFor('prop:' + prop.key, subject, prop.wx, prop.wy + 2.9, prop.wz, 'prop', 2600);
}

// ── o robô ────────────────────────────────────────────────────────────────

// A tela-rosto é uma textura de canvas desenhada na hora, com o matiz do agente:
// vetorial em espírito, sem sprite pré-renderizado por cor — que é o que a
// invariante do CLAUDE.md proíbe.
function faceTexture(hue, mood, isMain) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  // O visor é quase preto e o traço é luz: no Sumida o rosto é a parte mais
  // brilhante do robô, e é por ele que se acha um agente do outro lado da sala.
  x.fillStyle = '#03070d';
  x.fillRect(0, 0, 64, 64);
  x.fillStyle = mood === 'error' ? '#ff5470' : isMain ? '#ffffff' : `hsl(${hue} 100% 78%)`;
  x.shadowColor = x.fillStyle;
  x.shadowBlur = 9;
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

/** O disco de luz que todo robô projeta no chão. Um só, tingido por material. */
const HALO = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

function mountBot(agent, at) {
  const hue = hueOf(agent);

  // A carcaça **emite**. Num piso escuro, um Lambert puro devolvia uma caixa cinza
  // com um respingo de cor no topo, e os seis matizes viravam o mesmo cinza: o que
  // separa um agente do outro é a cor, e cor que depende de lâmpada não sobrevive à
  // noite. O `emissive` põe o matiz no material, e a direcional só modela o volume.
  const shell = agent.isMain
    ? new THREE.MeshLambertMaterial({ map: RAINBOW, emissive: 0x2a2a3a })
    : new THREE.MeshLambertMaterial({
        color: hueColor(hue),
        emissive: new THREE.Color().setHSL(hue / 360, 0.90, 0.30, THREE.SRGBColorSpace),
      });
  // A fita da carcaça e o facho sob as esteiras são luz pura: não escurecem com a
  // cena e é o que faz o robô parecer aceso, e não iluminado.
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(hue / 360, 1, 0.74, THREE.SRGBColorSpace) });
  const dark = new THREE.MeshLambertMaterial({ color: 0x141d2b });

  const g = new THREE.Group();

  // A esteira é o que toca o chão. Cada uma é um objeto próprio porque o passo as
  // move, quadro a quadro (issue #16).
  const treads = [
    put(box(0.34, 0.32, 1.15, dark), -0.42, 0.16, 0),
    put(box(0.34, 0.32, 1.15, dark), 0.42, 0.16, 0),
  ];
  for (const t of treads) {
    // Facho rente ao chão: é o reflexo no piso molhado, e é ele que cola o robô no
    // piso. Sem isso, com o chão escuro, o robô parecia pairar um dedo acima dele.
    t.add(put(box(0.30, 0.04, 1.0, glow), 0, -0.14, 0));
    g.add(t);
  }

  // O halo no chão, em volta do robô: um disco de gradiente somado ao que já está
  // pintado. É o que o robô devolve para o piso molhado — e é o que o faz ser a
  // coisa mais luminosa da cena mesmo visto de longe, quando a carcaça tem poucos
  // pixels.
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    new THREE.MeshBasicMaterial({
      map: HALO,
      color: new THREE.Color().setHSL(hue / 360, 1, 0.6, THREE.SRGBColorSpace),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.02;
  halo.renderOrder = -1;
  g.add(halo);

  // Carcaça, fita, alça e rosto num grupo só: é ele que se inclina ao andar.
  const body = new THREE.Group();
  body.add(put(box(1.16, 1.0, 1.0, shell), 0, 0.82, 0));
  // A fita corre em volta do peito, um pouco maior que a carcaça para não brigar
  // por z-fighting com ela.
  body.add(put(box(1.20, 0.07, 1.04, glow), 0, 0.46, 0));
  body.add(put(box(0.5, 0.09, 0.12, shell), 0, 1.37, 0));
  // Antena com a luz de topo: a silhueta ganha um ponto alto, e é o que se enxerga
  // quando o robô está atrás de um móvel.
  body.add(put(box(0.06, 0.30, 0.06, dark), 0.34, 1.55, 0));
  body.add(put(box(0.13, 0.13, 0.13, glow), 0.34, 1.74, 0));

  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(0.82, 0.82),
    new THREE.MeshBasicMaterial({ map: faceTexture(hue, 'idle', agent.isMain) }),
  );
  face.position.set(0, 0.86, 0.51);
  body.add(face);
  g.add(body);

  g.position.set(at.wx ?? agent.wx, at.wy ?? agent.wy, at.wz ?? agent.wz);
  // O grupo carrega a identidade: o raycast acerta uma malha qualquer da carcaça e
  // sobe até aqui para saber de quem ela é.
  g.userData.botId = agent.id;
  building.add(g);

  const rec = {
    id: agent.id, group: g, body, treads, face, hue, isMain: agent.isMain,
    queue: [], mood: 'idle', bob: 0, leaving: false, frame: -1,
  };
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
  if (params.has('probe')) {
    kindTally[kind || 'sem'] = (kindTally[kind || 'sem'] || 0) + 1;
    document.documentElement.dataset.kinds = JSON.stringify(kindTally);
  }
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

/**
 * O robô que terminou o serviço não some do lugar onde estava: ele desce a escada,
 * atravessa o térreo e só desaparece na porta. A cena já emite o trajeto até a
 * porta antes do `agent-leave`; aqui o `leave` fica **pendente** até a fila de
 * pernas esvaziar — sem isso o robô era removido no mesmo quadro e sumia do nada,
 * de dentro do próprio cômodo.
 */
function leaveBot(id) {
  const rec = bots.get(id);
  if (!rec) return;
  dropLabel('plate:' + id);
  if (rec.queue.length && !STILL) {
    rec.leaving = true;
    return;
  }
  removeBot(id, rec);
}

function removeBot(id, rec) {
  if (cardId === id) closeCard();
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

/**
 * A plaqueta do agente, sobre a **mesa dele** — não sobre a sala. Com dois postos
 * por sala, duas plaquetas no meio do mesmo cômodo se sobrepunham e nenhuma das
 * duas se lia; sobre a mesa, cada uma tem endereço próprio.
 */
function plateFor(agent) {
  if (agent.slot == null) return;
  const d = deskOf(agent.slot);
  const rec = labelFor(
    'plate:' + agent.id,
    nameOf(agent),
    d.wx, d.wy + WALL_H - 0.3, d.wz,
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

// No máximo três balões ao mesmo tempo (issue #13). Numa sessão com subagentes
// todos falam quase juntos, e a tela virava um mural: o quarto balão empurra o mais
// antigo, cujo texto já está no registro de qualquer forma.
const MAX_BUBBLES = 3;

// A última fala de cada agente. A carta de personagem a mostra; o registro guarda
// todas, mas a carta é um retrato do agora e só precisa da mais recente.
const lastSay = new Map();

function sayBot(id, text, tone) {
  if (text) lastSay.set(id, text);
  if (STILL || !text) return;   // balão é do agora; o passado fica no registro
  const rec = bots.get(id);
  if (!rec) return;

  const abertos = [...labels.entries()].filter(([, l]) => l.kind === 'bubble' && l.follow !== id);
  while (abertos.length >= MAX_BUBBLES) dropLabel(abertos.shift()[0]);

  // A fala inteira vive no registro; no balão entra o começo dela, cortado em
  // palavra inteira. É o que mantém o balão com três linhas no máximo.
  const curto = text.length > 96 ? text.slice(0, text.lastIndexOf(' ', 96)) + '…' : text;

  const p = rec.group.position;
  const b = labelFor('bubble:' + id, curto, p.x, p.y + 2.3, p.z, 'bubble', 5200 + Math.min(text.length * 26, 3200));
  b.node.dataset.tone = tone;
  b.node.style.setProperty('--h', rec.hue);
  if (rec.isMain) b.node.dataset.main = '';
  b.follow = id;
}

// ── câmera e laço ─────────────────────────────────────────────────────────

// Enquadra o escritório inteiro: a única vista que existe. A caixa é constante — a
// planta não muda de tamanho durante a sessão.
const bbox = new THREE.Box3();
const bmin = new THREE.Vector3();
const bmax = new THREE.Vector3();

function frame() {
  // A caixa vem do grafo desenhado, não de conta analítica: mobília e robô também
  // ocupam espaço, e era por fora deles que o escritório saía de quadro.
  const model = buildingBounds();
  // Sem atualizar as matrizes, a caixa mede posições de um quadro atrás.
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

/**
 * Garante o escritório desenhado. Ele é constante — três salas e um saguão, sempre
 * os mesmos —, então isto roda uma vez por sessão e não a cada agente que entra.
 * Antes o prédio era redesenhado sempre que o número de andares mudava, e cada
 * redesenho custava um piscar da cena inteira.
 */
function syncBuilding() {
  if (!built) {
    built = true;
    drawBuilding();
    // Redesenhar o prédio limpa o grupo: os robôs voltam para ele.
    for (const rec of bots.values()) building.add(rec.group);
  }
  frame();
}

// O passo do robô, em unidades de mundo por segundo. Sobe com a planta: mantido em
// 3,4, a mesma travessia num escritório 1,7× maior levava 1,7× mais tempo, e a cena
// passava a mostrar onde os agentes estavam, não onde estão.
const SPEED = 3.4 * SCALE;

let last = performance.now();
function step(now) {
  // O passo de tempo tem piso, não só teto: no tempo virtual do headless os timers
  // disparam repetidas vezes no mesmo instante, o `dt` saía zero e o robô andava
  // zero por quadro — a cena ficava parada para sempre, com a fila cheia.
  const dt = Math.min(0.05, Math.max(0.008, (now - last) / 1000));
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
      const speed = SPEED * rush;
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
        rec.bob = 0;
      }
      p.y += rec.bob;
      // A carcaça se vira para onde anda, só o suficiente para se ler.
      rec.group.rotation.y += ((leg.face > 0 ? -0.34 : 0.34) - rec.group.rotation.y) * 0.12;
      // Andar no plano também tem quadro: as esteiras alternam, e é o que separa
      // o robô em movimento do robô parado sem depender de animação cíclica de CSS.
      pose(rec, Math.floor(now / STEP_FRAME) % 2);
      if (params.has('probe')) {
        tickTally[leg.kind || 'sem'] = (tickTally[leg.kind || 'sem'] || 0) + 1;
        document.documentElement.dataset.tick = JSON.stringify(tickTally);
      }
    } else if (rec.leaving) {
      // Chegou à porta: agora sim sai de cena.
      removeBot(rec.id, rec);
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
}

function tick(now) {
  step(now);
  requestAnimationFrame(tick);
}

/**
 * Roda a simulação até todo mundo chegar, com passo de tempo sintético.
 *
 * Existe pelo print: no headless com tempo virtual o `requestAnimationFrame` quase
 * não dispara — os timers do roteiro avançam, mas a cena fica no primeiro quadro, e
 * todo print ao vivo saía com os robôs no meio do caminho. Um `setInterval` de
 * socorro resolveria e criou outro problema: o navegador nunca ficava ocioso e o
 * orçamento de tempo virtual não terminava. Assim é determinístico — N quadros, e
 * para quando as filas esvaziam.
 */
function settle(frames = 2400) {
  let t = performance.now();
  for (let i = 0; i < frames; i++) {
    t += 16;
    step(t);
    let andando = false;
    for (const rec of bots.values()) if (rec.queue.length) { andando = true; break; }
    if (!andando) break;
  }
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
    // Sem andares, nenhum robô tem motivo para mudar de altura: qualquer variação
    // aqui é bug. A sonda ficou mais severa do que era, e de graça.
    if (prev != null && Math.abs(y - prev) > 0.001) {
      airFrames++;
      airWorst = Math.max(airWorst, Math.abs(y - prev));
    }
    airState.set(id, y);
  }
  document.documentElement.dataset.air = `${airFrames}|${airWorst.toFixed(3)}`;
}

const kindTally = {};
const tickTally = {};
const STEP_FRAME = 150;   // duração de um quadro da subida, em ms

/**
 * A pose do robô, quadro a quadro (issue #16). `-1` é a pose parada; 0 e 1 são os
 * dois quadros da subida, que alternam qual esteira vai à frente e inclinam a
 * carcaça para cima.
 *
 * São **quadros vetoriais**: mexem em malhas que já existem, então o matiz continua
 * vindo do material — nada de sprite pré-renderizado por cor, que a invariante do
 * CLAUDE.md proíbe. E não é animação cíclica de CSS: quem manda é o laço, então
 * qualquer quadro é uma pose íntegra e o print headless nunca pega o robô torto.
 */
const poseCount = [0, 0];

function pose(rec, frame) {
  if (frame === rec.frame) return;
  rec.frame = frame;
  if (frame >= 0 && params.has('probe')) {
    poseCount[frame]++;
    document.documentElement.dataset.pose = `quadro0=${poseCount[0]} quadro1=${poseCount[1]}`;
  }

  if (frame < 0) {
    rec.body.rotation.x = 0;
    rec.body.position.set(0, 0, 0);
    rec.treads[0].position.set(-0.42, 0.16, 0);
    rec.treads[1].position.set(0.42, 0.16, 0);
    return;
  }

  const a = frame === 0 ? 1 : -1;
  rec.body.rotation.x = -0.14;                    // inclina para a subida
  rec.body.position.set(0, 0.04, -0.05);
  rec.treads[0].position.set(-0.42, 0.16 + (a > 0 ? 0.12 : 0), a * 0.16);
  rec.treads[1].position.set(0.42, 0.16 + (a > 0 ? 0 : 0.12), -a * 0.16);
}

const v = new THREE.Vector3();

function placeLabels(now) {
  const r = $stage.getBoundingClientRect();
  const bubbles = [];

  for (const [key, rec] of labels) {
    if (rec.until && now > rec.until) { dropLabel(key); continue; }
    if (rec.follow) {
      const bot = bots.get(rec.follow);
      if (!bot) { dropLabel(key); continue; }
      rec.at.set(bot.group.position.x, bot.group.position.y + 2.3, bot.group.position.z);
    }
    v.copy(rec.at).project(camera);
    const sx = (v.x * 0.5 + 0.5) * r.width;
    const sy = (-v.y * 0.5 + 0.5) * r.height;

    if (rec.kind === 'bubble') {
      bubbles.push({ rec, sx, sy });
      continue;   // balão tem tratamento próprio: precisa caber e não cobrir outro
    }
    rec.node.style.transform = `translate(-50%, -100%) translate(${sx}px, ${sy}px)`;
  }

  placeBubbles(bubbles, r);

  // A carta não se move, mas o dono dela pode ir embora: quando o agente sai do
  // elenco, a ficha fecha junto.
  if (cardId) {
    const a = scene.agents.get(cardId);
    if (!a) closeCard();
  }
}

/**
 * Coloca os balões sem que um cubra o outro e sem sair do quadro (issue #13).
 *
 * O desempate é por posição real na tela, não por ordem de chegada: cada balão
 * começa acima do robô que fala e, se colidir com um já colocado, sobe até sair de
 * cima dele. Depois, todo balão é preso às bordas do palco — antes um balão de quem
 * estava na beirada saía metade para fora.
 */
function placeBubbles(list, r) {
  const M = 10;                 // margem do palco
  const GAP = 12;               // folga entre balões: colados, liam como um bloco só
  const postos = [];

  for (const { rec, sx, sy } of list) {
    const w = rec.node.offsetWidth || 220;
    const h = rec.node.offsetHeight || 44;
    let x = sx - w / 2;
    let y = sy - h - 14;        // acima da cabeça do robô

    // Sai de cima de quem já está posto, subindo — e se não houver espaço acima,
    // desce para baixo do robô, que é melhor que cobrir a fala do vizinho.
    for (let i = 0; i < postos.length + 1; i++) {
      const bate = postos.find((p) => x < p.x + p.w + GAP && x + w + GAP > p.x && y < p.y + p.h + GAP && y + h + GAP > p.y);
      if (!bate) break;
      y = bate.y - h - GAP;
      if (y < M) { y = sy + 18; break; }
    }

    x = Math.max(M, Math.min(x, r.width - w - M));
    y = Math.max(M, Math.min(y, r.height - h - M));

    rec.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    postos.push({ x, y, w, h });
  }

  if (params.has('probe')) probeBubbles(postos, r);
}

// Sonda dos balões: conta pares sobrepostos e balões fora do quadro. Prova com
// número que a regra da issue #13 vale, em vez de olhar print.
let bubbleWorst = 0;
let bubbleOut = 0;
function probeBubbles(postos, r) {
  let over = 0;
  for (let i = 0; i < postos.length; i++) {
    for (let j = i + 1; j < postos.length; j++) {
      const a = postos[i], b = postos[j];
      if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) over++;
    }
    const p = postos[i];
    if (p.x < 0 || p.y < 0 || p.x + p.w > r.width || p.y + p.h > r.height) bubbleOut++;
  }
  bubbleWorst = Math.max(bubbleWorst, over);
  document.documentElement.dataset.bubbles = `abertos=${postos.length} robos=${bots.size} sobrepostos=${bubbleWorst} fora=${bubbleOut}`;
}

// ── carta de personagem ───────────────────────────────────────────────────
//
// Clicar num robô abre a ficha dele. A planta mostra **onde** cada agente está; a
// carta mostra **quem** ele é e o que está fazendo agora — as duas coisas que não
// cabem numa plaqueta de três palavras.

const raycaster = new THREE.Raycaster();
const ponteiro = new THREE.Vector2();

/** Qual robô está sob o ponteiro, se houver algum. */
function pickBot(e) {
  const r = $canvas.getBoundingClientRect();
  ponteiro.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ponteiro.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(ponteiro, camera);

  // Só os grupos de robô entram no teste: o prédio inteiro tem centenas de malhas,
  // e o alvo aqui é sempre um robô.
  const alvos = [...bots.values()].map((b) => b.group);
  const hits = raycaster.intersectObjects(alvos, true);
  if (!hits.length) return null;
  // Da malha atingida, subir até o grupo que é o robô.
  let o = hits[0].object;
  while (o && !o.userData.botId) o = o.parent;
  return o?.userData.botId || null;
}

/**
 * O retrato do robô na carta: o mesmo desenho da planta, visto de frente e em 2D.
 * Vetorial, com o matiz vindo do agente — nada de sprite pré-renderizado por cor,
 * que é o que a invariante do projeto proíbe.
 */
function botPortrait(canvas, agent) {
  const hue = hueOf(agent);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const W = 96, H = 96;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const x = canvas.getContext('2d');
  x.scale(dpr, dpr);

  const corpo = agent.isMain ? null : `hsl(${hue} 88% 60%)`;
  const luz = agent.isMain ? '#ffffff' : `hsl(${hue} 100% 74%)`;

  // Carcaça. O principal não tem matiz: leva o arco-íris, o mesmo do elenco.
  let fill = corpo;
  if (agent.isMain) {
    const g = x.createLinearGradient(20, 0, 76, 0);
    for (const [at, c] of [[0, '#e85d5d'], [0.2, '#e8a13d'], [0.4, '#e3d24a'],
                           [0.6, '#4fbc86'], [0.8, '#5b95d6'], [1, '#a97fd0']]) g.addColorStop(at, c);
    fill = g;
  }

  x.save();
  x.shadowColor = agent.isMain ? 'rgba(255,255,255,.5)' : `hsl(${hue} 100% 60% / .55)`;
  x.shadowBlur = 14;

  // esteiras
  x.fillStyle = '#141d2b';
  x.fillRect(16, 66, 14, 18);
  x.fillRect(66, 66, 14, 18);
  // carcaça de quinas arredondadas
  x.fillStyle = fill;
  x.beginPath();
  x.roundRect(20, 20, 56, 50, 10);
  x.fill();
  x.restore();

  // alça e antena
  x.strokeStyle = fill;
  x.lineWidth = 4;
  x.beginPath(); x.moveTo(38, 20); x.lineTo(58, 20); x.stroke();
  x.strokeStyle = '#141d2b';
  x.beginPath(); x.moveTo(70, 20); x.lineTo(70, 10); x.stroke();
  x.fillStyle = luz;
  x.beginPath(); x.arc(70, 8, 4, 0, Math.PI * 2); x.fill();

  // fita acesa no peito
  x.fillStyle = luz;
  x.fillRect(20, 62, 56, 4);
  // facho sob as esteiras
  x.globalAlpha = 0.5;
  x.fillRect(14, 84, 68, 3);
  x.globalAlpha = 1;

  // visor
  x.fillStyle = '#03070d';
  x.beginPath(); x.roundRect(28, 30, 40, 26, 5); x.fill();
  const mood = agent.status === 'error' ? 'error' : agent.status === 'working' ? 'work' : 'idle';
  x.fillStyle = mood === 'error' ? '#ff5470' : luz;
  x.strokeStyle = x.fillStyle;
  x.lineWidth = 3;
  x.lineCap = 'round';
  if (mood === 'error') {
    for (const cx of [38, 58]) {
      x.beginPath();
      x.moveTo(cx - 4, 38); x.lineTo(cx + 4, 46);
      x.moveTo(cx + 4, 38); x.lineTo(cx - 4, 46);
      x.stroke();
    }
  } else if (mood === 'work') {
    x.beginPath(); x.moveTo(33, 41); x.lineTo(43, 41); x.moveTo(53, 41); x.lineTo(63, 41); x.stroke();
  } else {
    for (const cx of [38, 58]) { x.beginPath(); x.arc(cx, 41, 4, 0, Math.PI * 2); x.fill(); }
  }
  x.beginPath(); x.moveTo(42, 51); x.lineTo(54, 51); x.stroke();
}

const ESTADO = { idle: 'ocioso', working: 'trabalhando', walking: 'a caminho', error: 'com erro', leaving: 'saindo' };

/** Há quanto tempo, em palavras curtas. */
function desde(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

let cardId = null;

function closeCard() {
  cardId = null;
  $card.hidden = true;
}

function openCard(id) {
  const agent = scene.agents.get(id);
  if (!agent) return closeCard();
  cardId = id;
  $card.hidden = false;
  $card.style.setProperty('--h', hueOf(agent));
  $card.dataset.main = agent.isMain ? '' : undefined;
  if (!agent.isMain) delete $card.dataset.main;

  const s = seatOf(agent.slot);
  const fazendo = agent.tool
    ? `${VERB[agent.tool] || agent.tool}${agent.subject ? ' ' + agent.subject : ''}`
    : ESTADO[agent.status] || agent.status;

  $card.innerHTML =
    '<button class="card-x" aria-label="Fechar">×</button>' +
    '<div class="card-top"><canvas class="card-face" width="96" height="96"></canvas>' +
    `<div><div class="card-name">${esc(nameOf(agent))}</div>` +
    `<div class="card-role">${esc(agent.isMain ? 'agente principal' : agent.type)}</div>` +
    `<div class="card-state" data-s="${esc(agent.status)}">${esc(ESTADO[agent.status] || agent.status)}</div></div></div>` +
    '<dl class="card-rows">' +
    `<div><dt>fazendo</dt><dd>${esc(fazendo)}</dd></div>` +
    `<div><dt>onde</dt><dd>${agent.away ? 'saguão' : `sala ${s.room + 1}, posto ${s.seat + 1}`}</dd></div>` +
    `<div><dt>ferramentas</dt><dd>${agent.toolCount}</dd></div>` +
    `<div><dt>no escritório há</dt><dd>${desde(agent.since)}</dd></div>` +
    '</dl>' +
    (lastSay.has(id) ? `<p class="card-say">${esc(lastSay.get(id))}</p>` : '');

  botPortrait($card.querySelector('.card-face'), agent);
  $card.querySelector('.card-x').addEventListener('click', closeCard);
}

// A carta é **fixa no canto do palco**. Ela seguia o robô, e o robô anda: a ficha
// escorregava enquanto se lia, e uma volta de câmera a jogava para o outro lado da
// tela. Quem é o dono já está dito pela cor da borda e pelo retrato — não é a
// posição dela que precisa dizer isso.

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });

// ── órbita: arrastar gira, roda aproxima, duplo clique volta ──────────────
//
// Escrito à mão em vez de vendorizar o OrbitControls: são vinte linhas, e o
// controle oficial traz pan e damping que aqui só atrapalhariam — o prédio tem
// de continuar centrado sozinho.

let drag = null;

let pressAt = null;

$canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  // Onde o dedo desceu: se ele subir quase no mesmo lugar, foi clique; se andou,
  // foi órbita. Sem essa distinção, girar a câmera abria a carta ao soltar.
  pressAt = { x: e.clientX, y: e.clientY };
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

$canvas.addEventListener('pointerup', (e) => {
  const parado = pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) < 5;
  pressAt = null;
  endDrag();
  if (!parado) return;
  const id = pickBot(e);
  if (id) openCard(id);
  else closeCard();
});
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
      // Não há prop-add nem prop-remove: a mobília é do prédio, montada com ele.
      case 'prop-hit': if (!c.instant) hitProp(c.prop, c.subject); break;
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
      `<div><div class="cast-name">${esc(nameOf(a))}</div>` +
      `<div class="cast-doing">${doing}</div></div>`;
    row.tabIndex = 0;
    row.addEventListener('click', () => openCard(a.id));
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(a.id); } });
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

  // O registro chama o agente pelo mesmo nome que a planta: buscar na cena, e não
  // usar o `agentType` cru do evento, é o que mantém os dois em acordo.
  const who = ev.kind === 'prompt' ? 'você'
    : ev.agentId === 'main' ? 'principal'
    : (() => {
      const vivo = scene.agents.get(ev.agentId);
      if (vivo) { nomes.set(ev.agentId, nameOf(vivo)); return nameOf(vivo); }
      return nomes.get(ev.agentId) || ev.agentType;
    })();
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
  nomes.clear();
  lastSay.clear();
  $logList.replaceChildren();
  logged = 0;
  $logCount.textContent = '';
}

function enterRoom(id, room) {
  currentRoom = id;
  clearRoom();
  built = false;
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
  // Deixa todo mundo chegar antes de declarar a cena pronta para o print.
  settle();
  // `?stress` faz todo mundo falar de uma vez: é o caso que a issue #13 descreve e
  // que o roteiro do demo, com as falas espaçadas, nunca produz.
  if (params.has('stress')) {
    const texto = 'Fala longa de teste para medir se o balão cabe na tela, se corta em três linhas e se cobre o balão do vizinho quando todos falam ao mesmo tempo.';
    for (const id of bots.keys()) sayBot(id, texto, 'result');
  }

  // `?card=<id|n>` abre a ficha de um agente no arranque. O print headless não
  // clica, e a carta é justamente o que só existe depois de um clique.
  if (params.has('card')) {
    const alvo = params.get('card');
    const ids = [...scene.agents.keys()];
    openCard(ids.includes(alvo) ? alvo : ids[Number(alvo) || 0] || ids[0]);
  }

  // Sinal para o print headless: o roteiro acabou e a cena pode ser fotografada.
  requestAnimationFrame(() => { document.documentElement.dataset.ready = 'true'; });
} else {
  connect();
}
