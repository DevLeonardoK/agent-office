// A paleta do escritório, sem uma linha de DOM nem de three.
//
// Vive num módulo próprio porque a cor deixou de ser detalhe de desenho: com o
// escritório colorido (ADR-0004), é a paleta que garante que o olho ainda ache os
// agentes. O `selftest.mjs` afirma as distâncias de matiz que sustentam essa
// leitura — se alguém pintar uma parede da cor de um robô, o teste reprova.

/** Matiz, saturação e luz em HSL, no formato que o three e o CSS entendem. */
export const hsl = (h, s, l) => ({ h, s, l });

// ── o prédio ──────────────────────────────────────────────────────────────
//
// Amarelo nas paredes, piso claro em xadrez, laje creme: é a leitura de
// escritório iluminado, no espírito da referência. Nada aqui é saturado ao ponto
// de competir com a carcaça de um robô — o prédio é claro, os robôs são vivos.

export const BUILDING = {
  wall: hsl(44, 0.62, 0.62),          // parede amarela
  wallTrim: hsl(40, 0.45, 0.42),      // arremate do topo, mais escuro
  // Piso e laje quase sem matiz: assim eles não disputam faixa da roda de cores com
  // os agentes, e a leitura ali fica por conta do valor.
  floorA: hsl(38, 0.10, 0.86),        // ladrilho creme
  floorB: hsl(186, 0.28, 0.72),       // ladrilho alternado, azulado
  slab: hsl(36, 0.10, 0.52),          // espessura da laje
  divider: hsl(0, 0, 0.92),           // divisória entre cômodos, quase branca
  stair: hsl(28, 0.34, 0.58),         // degrau
  landing: hsl(28, 0.28, 0.48),       // patamar
  rail: hsl(196, 0.42, 0.55),         // guarda-corpo
  terrain: hsl(120, 0.22, 0.38),      // o terreno, verde de exterior
  sidewalk: hsl(40, 0.16, 0.74),      // calçada
};

// ── os móveis ─────────────────────────────────────────────────────────────
//
// Cada tipo tem cor própria: com mobília fixa (issue #14) são poucos volumes por
// cômodo, e a cor passa a ser o que distingue mesa de estante de longe.

export const PROPS = {
  desk: hsl(24, 0.44, 0.38),          // madeira: escura o bastante para não ler como salmão
  shelf: hsl(8, 0.55, 0.48),          // estante vermelha
  terminal: hsl(210, 0.30, 0.38),     // terminal, cinza-azulado
  library: hsl(150, 0.42, 0.40),      // biblioteca verde
  whiteboard: hsl(0, 0, 0.90),        // quadro branco
  cabinet: hsl(50, 0.66, 0.52),       // arquivo morto, amarelo-mostarda
  screen: hsl(196, 0.55, 0.30),       // vidro apagado
  screenLit: hsl(186, 0.72, 0.58),    // vidro aceso
};

// ── os agentes ────────────────────────────────────────────────────────────
//
// Seis matizes (issue #17), escolhidos para se separarem entre si **e** das cores do
// prédio (ADR-0004). As faixas proibidas são as do fundo: amarelo da parede (44),
// azulado do ladrilho (186) e verde do terreno (120), cada uma com 20° de margem.
// Foi isso que tirou o laranja e o âmbar da paleta — eles caíam na faixa da parede.
// O principal não usa matiz: leva o arco-íris.

export const AGENT_HUES = [8, 84, 152, 214, 268, 334];

/** O vermelho do rosto de erro. Não pode se confundir com matiz de agente. */
export const ERROR_HUE = 0;

/** A menor distância entre dois matizes, na roda de 360°. */
export function hueGap(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
}

/**
 * As cores do prédio que ficam **atrás** de um robô e por isso disputam leitura
 * com a carcaça dele. Vidro e arremates não entram: são detalhes pequenos.
 */
export const BACKDROP = [BUILDING.wall, BUILDING.floorA, BUILDING.floorB, BUILDING.slab, BUILDING.terrain];

/** Formata para CSS. Serve à interface 2D, que lê a mesma paleta. */
export const css = (c) => `hsl(${c.h} ${Math.round(c.s * 100)}% ${Math.round(c.l * 100)}%)`;
