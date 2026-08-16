// Renderizador do escritório: DOM + SVG, animado com motion.dev.
//
// Toda a lógica de posicionamento mora em scene.mjs. Aqui só se decide como
// cada comando da cena vira pixel e movimento.

import { animate, stagger } from './vendor/motion.js';
import { createScene, apply, hydrate, PLAN, DOOR, STATIONS } from './scene.mjs';

const params = new URLSearchParams(location.search);

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

function drawBlueprint() {
  const ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, parent = $blueprint) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    parent.appendChild(n);
    return n;
  };

  // Gradiente arco-íris do agente principal. Vive aqui, no SVG da planta, mas a
  // carcaça do robô o referencia por id de qualquer outro SVG do documento — é
  // o mesmo matiz que o elenco e o registro pintam por CSS, para o principal se
  // ler igual nos três lugares.
  const defs = add('defs', {});
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.setAttribute('id', 'agentRainbow');
  grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
  grad.setAttribute('x2', '1'); grad.setAttribute('y2', '1');
  const stops = [['0', 'hsl(0 80% 62%)'], ['.2', 'hsl(32 85% 60%)'], ['.4', 'hsl(52 85% 58%)'],
                 ['.6', 'hsl(145 60% 52%)'], ['.8', 'hsl(210 70% 58%)'], ['1', 'hsl(280 60% 64%)']];
  for (const [off, col] of stops) {
    const stop = document.createElementNS(ns, 'stop');
    stop.setAttribute('offset', off);
    stop.setAttribute('stop-color', col);
    grad.appendChild(stop);
  }
  defs.appendChild(grad);

  const M = 26;                       // margem do desenho
  const W = PLAN.w - M * 2;
  const H = PLAN.h - M * 2;

  // parede externa: linha dupla, como em planta de verdade
  add('rect', { x: M, y: M, width: W, height: H, fill: 'none', stroke: 'var(--draft)', 'stroke-width': 2, opacity: .55 });
  add('rect', { x: M + 5, y: M + 5, width: W - 10, height: H - 10, fill: 'none', stroke: 'var(--draft)', 'stroke-width': .6, opacity: .3 });

  // marcas de canto (registro de prancheta)
  for (const [cx, cy, sx, sy] of [[M, M, 1, 1], [PLAN.w - M, M, -1, 1], [M, PLAN.h - M, 1, -1], [PLAN.w - M, PLAN.h - M, -1, -1]]) {
    add('path', {
      d: `M${cx} ${cy + sy * 20}L${cx} ${cy}L${cx + sx * 20} ${cy}`,
      fill: 'none', stroke: 'var(--draft)', 'stroke-width': 1.6, opacity: .75,
    });
  }

  // porta, com o arco de abertura — o símbolo que todo mundo reconhece
  const d = DOOR;
  add('rect', { x: M - 3, y: d.y - 46, width: 11, height: 92, fill: 'var(--ink)' });
  add('path', { d: `M${M + 8} ${d.y - 44}L${M + 8} ${d.y - 44 + 78}`, stroke: 'var(--draft)', 'stroke-width': 2 });
  add('path', {
    d: `M${M + 8} ${d.y + 34}A78 78 0 0 0 ${M + 86} ${d.y - 44}`,
    fill: 'none', stroke: 'var(--draft)', 'stroke-width': .9, 'stroke-dasharray': '3 4', opacity: .6,
  });

  // divisórias internas: apenas sugeridas, para não competir com os agentes
  const hint = (x1, y1, x2, y2) =>
    add('path', { d: `M${x1} ${y1}L${x2} ${y2}`, stroke: 'var(--draft)', 'stroke-width': 1, opacity: .18 });
  hint(268, 26, 268, 250);
  hint(268, 390, 268, 594);
  hint(788, 26, 788, 250);
  hint(788, 390, 788, 594);
  hint(268, 528, 788, 528);

  // nomes das salas
  const roomLabel = (x, y, text) => {
    const t = add('text', {
      x, y, fill: 'var(--draft)', opacity: .5,
      'font-family': 'var(--mono)', 'font-size': 10, 'letter-spacing': 3.4,
      'text-anchor': 'middle',
    });
    t.textContent = text;
  };
  // Nas estações da metade de baixo o agente encosta por cima, então o nome da
  // sala desce para o outro lado do móvel em vez de ficar embaixo do boneco.
  for (const s of Object.values(STATIONS)) {
    roomLabel(s.x, s.y > PLAN.h / 2 ? s.y + 76 : s.y - 52, s.label);
  }
  roomLabel(532, 92, 'MESAS');
  roomLabel(532, 556, 'CORREDOR');

  // cota de largura, embaixo
  const cy = PLAN.h - 12;
  add('path', { d: `M${M} ${cy}L${PLAN.w - M} ${cy}`, stroke: 'var(--draft)', 'stroke-width': .6, opacity: .35 });
  for (const x of [M, PLAN.w - M]) {
    add('path', { d: `M${x} ${cy - 4}L${x} ${cy + 4}`, stroke: 'var(--draft)', 'stroke-width': 1, opacity: .5 });
  }
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

function mountProp(prop) {
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
  animate(node, { opacity: [0, 1], scale: [0.82, 1] }, POP);
  return node;
}

function hitProp(prop) {
  const n = propNodes.get(prop.key);
  if (!n) return;
  n.root.classList.add('hit');
  clearTimeout(n.timer);
  n.timer = setTimeout(() => n.root.classList.remove('hit'), 2600);
}

// ── o robô ──────────────────────────────────────────────────────────────

// Robô de esteira: carcaça arredondada (a carcaça é o matiz), tela-rosto com os
// três estados, e esteiras que são desenho — nunca animação, senão congelam
// deformadas no primeiro frame do print headless. A plaqueta com o `agent_type`
// fica fora do grupo `flip`, em HTML, para o texto nunca sair espelhado.
const ROBOT = `
<svg width="40" height="52" viewBox="0 0 40 52">
  <ellipse class="drop" cx="20" cy="49" rx="14" ry="3.4"/>
  <g class="flip">
    <path class="antenna" d="M20 8V3"/>
    <circle class="beacon" cx="20" cy="2" r="1.8"/>
    <g class="treads">
      <rect class="tread" x="2.5" y="38" width="14" height="11" rx="5.5"/>
      <rect class="tread" x="23.5" y="38" width="14" height="11" rx="5.5"/>
      <path class="tread-notch" d="M5 40v7M8 40v7M11 40v7M14 40v7M26 40v7M29 40v7M32 40v7M35 40v7"/>
    </g>
    <rect class="chassis" x="5" y="8" width="30" height="32" rx="8"/>
    <path class="chassis-shade" d="M35 16v16a8 8 0 0 1-8 8h-4V8h4a8 8 0 0 1 8 8Z"/>
    <rect class="screen" x="9" y="12" width="22" height="13" rx="4"/>
    <g class="face">
      <g class="m m-idle"><circle class="eye" cx="16" cy="18.5" r="2.1"/><circle class="eye" cx="24" cy="18.5" r="2.1"/></g>
      <g class="m m-work"><path class="eye-line" d="M13.6 18.5h4.8M21.6 18.5h4.8"/></g>
      <g class="m m-error"><path class="eye-x" d="M14 16.5l4 4M18 16.5l-4 4M22 16.5l4 4M26 16.5l-4 4"/></g>
    </g>
  </g>
</svg>`;

function mountAgent(agent, instant) {
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

  const rec = { root: node, tool: node.querySelector('.agent-tool'), bubbleTimer: 0, walkTimer: 0 };
  nodes.set(agent.id, rec);

  animate(node, { x: agent.x, y: agent.y }, { duration: 0 });
  if (!instant) animate(node, { opacity: [0, 1], scale: [0.6, 1] }, POP);
  return rec;
}

function walkAgent(id, x, y, face) {
  const rec = nodes.get(id);
  if (!rec) return;
  rec.root.dataset.face = String(face);
  rec.root.classList.add('walking');

  // O spring da motion preserva velocidade quando interrompido, então mudar de
  // destino no meio do caminho não dá solavanco.
  const anim = animate(rec.root, { x, y }, WALK);
  clearTimeout(rec.walkTimer);
  anim.finished.then(() => rec.root.classList.remove('walking')).catch(() => {});
}

function stateAgent(agent) {
  const rec = nodes.get(agent.id);
  if (!rec) return;
  rec.root.classList.toggle('working', agent.status === 'working');
  rec.root.dataset.mood = moodOf(agent);
  rec.tool.textContent = agent.tool || '';
}

function leaveAgent(id) {
  const rec = nodes.get(id);
  if (!rec) return;
  nodes.delete(id);
  rec.root.classList.remove('working');
  animate(rec.root, { opacity: 0, scale: 0.72 }, { duration: REDUCED ? 0 : 0.5, delay: REDUCED ? 0 : 1.6 })
    .finished.then(() => rec.root.remove())
    .catch(() => rec.root.remove());
}

function sayAgent(id, text, tone) {
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
      case 'prop-add': mountProp(c.prop); break;
      case 'prop-hit': hitProp(c.prop); break;
      case 'agent-enter':
        mountAgent(c.agent, c.instant);
        touchedCast = true;
        break;
      case 'agent-move': walkAgent(c.id, c.x, c.y, c.face); break;
      case 'agent-state': stateAgent(c.agent); touchedCast = true; break;
      case 'agent-leave': leaveAgent(c.id); touchedCast = true; break;
      case 'say': sayAgent(c.id, c.text, c.tone); break;
      case 'log': renderLog(c.event); break;
    }
  }

  if (touchedCast) renderCast();
  $empty.hidden = scene.agents.size > 0;
}

// ── salas ─────────────────────────────────────────────────────────────────

function clearRoom() {
  for (const rec of nodes.values()) rec.root.remove();
  nodes.clear();
  for (const n of propNodes.values()) n.root.remove();
  propNodes.clear();
  $logList.replaceChildren();
  logged = 0;
  $logCount.textContent = '';
}

function enterRoom(id, room) {
  currentRoom = id;
  clearRoom();
  run(hydrate(scene, room));
  if (!REDUCED && propNodes.size) {
    animate([...propNodes.values()].map((n) => n.root), { opacity: [0, 1], scale: [0.86, 1] }, { ...POP, delay: stagger(0.035) });
  }
  renderCast();
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
  if (pending && !room?.history.some((h) => h.seq === pending.seq)) run(apply(scene, pending));
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
    o.textContent = `${r.closed ? '·' : '●'} ${r.cwd || r.label} · ${r.id.slice(0, 8)}`;
    $rooms.appendChild(o);
  }
  if (currentRoom) $rooms.value = currentRoom;
}

$rooms.addEventListener('change', () => {
  $follow.checked = false;   // escolha manual manda mais que o piloto automático
  switchRoom($rooms.value);
});

// ── encaixe do desenho na tela ────────────────────────────────────────────

function fit() {
  const r = $stage.getBoundingClientRect();
  const scale = Math.min(r.width / PLAN.w, r.height / PLAN.h, 1.35);
  $plan.style.transform = `scale(${scale})`;
}

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

drawBlueprint();
new ResizeObserver(fit).observe($stage);
fit();

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
