# Coding Standards

Este projeto é Node puro, sem etapa de build e sem dependências em tempo de
execução — a `motion.dev` está vendorizada em `public/vendor/motion.js` como
bundle fechado. Uma mudança que exija `npm install` para o escritório rodar é
motivo de rejeição.

Verificação: `npm test` (que é `node selftest.mjs`).

## Armadilhas — rejeitar se violadas

Quatro coisas quebraram este projeto de formas silenciosas, e todas voltam.
Nenhuma delas aparece como erro visível; por isso são critério de review e não
de teste.

- **A biblioteca de animação é dona do `transform`.** Ela compõe o transform a
  partir de `x`/`y`/`scale`, sem escrever no atributo `style`. Um
  `node.style.transform` escrito à mão funciona até a primeira animação e depois
  some. Posição passa por `animate(node, {x, y}, ...)`, sempre.
- **`POST /hook` responde 204 com corpo vazio.** Qualquer outra coisa vira aviso
  de erro no transcript do usuário, a cada ferramenta usada.
- **O mapa de MIME em `server.mjs` precisa de `.mjs`.** Sem isso o navegador
  recebe `application/octet-stream` e recusa o módulo — a página fica em branco,
  sem erro visível na aba de rede.
- **Animação CSS cíclica congela no primeiro frame do print headless**, o que
  faz as figuras saírem deformadas. Animação tem começo e fim.

## Arquitetura

- **`public/scene.mjs` decide onde; `public/office.js` decide como.** A cena
  devolve uma lista de comandos e não contém uma linha de DOM — é isso que
  permite ao `selftest.mjs` exercitar todo o posicionamento em Node. Uma
  referência a `document` ou `window` em `scene.mjs` é rejeição imediata.
- **A cena é função pura dos eventos** (`docs/adr/0001`). O servidor não mantém
  cena própria. Um atalho que altere a cena sem passar por um evento quebra a
  propriedade inteira e é rejeição.
- **Mudança de posicionamento entra em `scene.mjs` e ganha asserção no
  `selftest.mjs`.** Sem asserção nova, não está pronto.
- **Asserções são invariantes, não coordenadas.** Com relayout contínuo nenhuma
  posição é estável: afirmar `x === 340` é um teste que vai quebrar sozinho.
  Afirmar "nenhum robô se sobrepõe a outro" é o que se espera.

## Vocabulário

`CONTEXT.md` é o glossário e vale para código, commits e interface: **prédio,
andar, cômodo, estação, móvel, robô, registro, sessão**. Cômodo é do agente,
estação é do prédio. "Boneco" não existe mais — é robô. Sinônimos listados em
`_Avoid_` no glossário não devem aparecer em nome de variável, função ou
rótulo de tela.

Os comentários e a documentação deste repositório são em português. Manter.

## Decisões deliberadas — não "consertar"

Estas parecem bugs e não são. Uma correção não solicitada delas é rejeição.

- **Nenhuma posição na tela é estável**, por causa do relayout contínuo somado à
  demolição de andar vazio. Não introduzir estabilização de posição.
- **O log `.jsonl` em disco não tem leitor.** É gravado deliberadamente para não
  fechar a porta de um replay futuro. Não adicionar leitura no boot nem
  interface de replay — replay está fora de escopo.
- **O agente principal é arco-íris**, e não creme. A antiga invariante de cor foi
  revogada em `docs/adr/0002`.
- **Dois agentes tocando o mesmo arquivo produzem dois móveis**, um em cada
  cômodo. Não é duplicação a ser deduplicada.

## Estilo

- Comentário explica *por que*, não *o que*. O padrão do repositório é comentar
  a decisão e a armadilha que a motivou, não parafrasear a linha seguinte.
- Sem código comentado e sem `TODO` no que for commitado.
- Anotação é mono, título é sans. Móvel é símbolo de planta, nunca emoji.

## Testes

- `selftest.mjs` é o modelo: asserções nomeadas, contagem de falhas, sem
  framework, executável com `node selftest.mjs`. Não introduzir um runner de
  testes.
- Testar comportamento externo da costura — dado um evento, quais comandos e
  qual geometria. Não testar estrutura interna da cena nem ordem de montagem.
- O nome da asserção descreve o comportamento esperado em português, como as
  existentes ("o agente encosta no móvel", "mesma mesa, um móvel só").
