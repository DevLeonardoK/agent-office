# Escritório dos Agentes

Visualiza a atividade do Claude Code como um escritório 3D: hooks → servidor →
navegador. Node puro, sem `npm install` — `three.js` e `motion.dev` estão
vendorizadas em `public/vendor/` como bundles fechados.

```
node selftest.mjs        # 299 verificações: scene.mjs, os hooks e a sintaxe do renderizador
node simulate.mjs        # encena uma sessão pelo POST /hook, como o Claude Code faz
node ensure-server.mjs   # sobe o servidor se estiver fora do ar (idempotente)
```

## A costura

`public/scene.mjs` decide **onde** cada robô e cada móvel ficam e devolve uma
lista de comandos; `public/office.js` só decide **como** cada comando vira
pixel. Manter `scene.mjs` sem uma linha de DOM é o que permite ao `selftest`
exercitar todo o posicionamento em Node — mudança de posicionamento entra em
`scene.mjs` e ganha asserção no `selftest.mjs`.

## Armadilhas

Quatro coisas quebraram este projeto de formas silenciosas. Todas voltam.

**A motion.dev saiu do renderizador.** Com a cena em 3D não existe `transform`
de CSS para ela compor: o laço do `three` é o dono do movimento (ADR-0003). Ela
segue vendorizada, para a interface 2D.

**O servidor responde 204 com corpo vazio em `POST /hook`.** Qualquer outra
coisa vira aviso de erro no transcript do usuário, a cada ferramenta usada.

**`MIME` em `server.mjs` precisa de `.mjs`.** Sem isso o navegador recebe
`application/octet-stream` e recusa o módulo — a página fica em branco, sem erro
visível na aba de rede.

**A extrusão entrega tampas primeiro, laterais depois.** `ExtrudeGeometry` gera
dois grupos de face nessa ordem; passar `[lateral, tampa]` pinta o topo da laje com
a cor da borda e o piso inteiro aparece apagado. Medido em Node com `boundingBox` e
`groups` — quando a dúvida é de geometria, meça, não olhe.

**Nada visível pode depender de uma animação começar.** Animações WAAPI de
opacidade ficam pendentes numa rajada de eventos, e o que deveria surgir fica
invisível: robôs sumiam da planta com o elenco cheio, e o registro aparecia em
branco com o contador em 18. Quem entra na cena nasce com `opacity` no estilo;
a animação faz só o pop de escala.

**Print headless exige o modo demo.** A página ao vivo mantém o SSE aberto e
nunca termina de carregar, então o headless trava. E as animações CSS cíclicas
congelam no primeiro frame, o que faz os bonecos saírem deformados no print —
parece bug de layout e não é:

```
chrome --headless=new --screenshot=shot.png --window-size=1500,860 \
  --virtual-time-budget=12000 "http://127.0.0.1:4517/?demo&instant&upto=21"

# a cena 3D precisa de GPU; no headless, use o renderizador de software:
#   --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

**O `requestAnimationFrame` quase não dispara no headless com tempo virtual.** Os
timers do roteiro avançam, a cena fica parada no primeiro quadro, e todo print ao
vivo saía com os robôs no meio do caminho — o que parece bug de posicionamento e
não é. Por isso o modo demo chama `settle()` no fim: roda a simulação com passo
sintético de 16 ms até as filas esvaziarem, e só então `dataset.ready` vira `true`.

Um `setInterval` de socorro parecia resolver e criou outro problema: o navegador
nunca ficava ocioso e o orçamento de tempo virtual não terminava — o print
travava. E o passo de tempo precisa de **piso**, não só teto: no tempo virtual os
timers disparam repetidas vezes no mesmo instante, o `dt` saía zero, e o robô
andava zero por quadro para sempre, com a fila cheia.

O `upto=21` para o roteiro com quatro agentes no escritório e um deles no saguão —
é o quadro mais cheio do roteiro, e o que vale fotografar. Sem `upto`, o roteiro
termina com o principal sozinho.

Antes de perseguir uma deformação vista em print, meça a geometria real com
`getBoundingClientRect` num `--dump-dom`.

## A vista

Uma só: o escritório inteiro, enquadrado a partir de `buildingBounds()` — que
agora é constante, porque a planta não muda de tamanho durante a sessão. Havia
também uma vista de andar cheio; ela foi removida junto com os andares.

## Mobília: ela é do escritório

A mobília é **da planta**, não do agente e não do evento (ADR-0005). `fixedProps()`
no `scene.mjs` é função pura — mesma planta, mesma lista — e o renderizador a monta
uma vez junto com as paredes. Não existe comando de montar nem de desmontar móvel.
Usar uma ferramenta **acende** o móvel que já está lá; tipo sem móvel próprio cai na
mesa do agente.

Antes ela era montada com o ocupante e desmontada quando a sala esvaziava. O efeito
era um escritório que se esvaziava de móveis a cada saída — e sala sem móvel não lê
como sala vazia, lê como sala não construída.

Cada sala tem cinco volumes, **espalhados de propósito** (`ROOM_LAYOUT`): duas mesas
(uma por posto), estante na parede da direita, arquivo na da esquerda e quadro na do
fundo. Enfileirados, os volumes liam como um balcão só e a sala parecia um corredor.
Há asserção de que nenhum par se encosta e de que eles ocupam profundidades e
larguras diferentes.

**Cada móvel tem uma pegada, e o robô a contorna.** `PROP_FOOT` no `scene.mjs` é a
planta baixa de cada volume — largura, fundo e o deslocamento do centro (a mesa tem
cadeira na frente). `obstacles()` a devolve como caixa com a folga do corpo do robô,
e `route()` cruza cada perna com cada caixa: a que bate ganha um contorno de dois
pontos pelo lado mais perto, validado contra `freeRects()` antes de entrar. O
`selftest` percorre todos os pares de lugares de parada e exige **zero** travessias.

**`PROP_FOOT` espelha o `propVolume()` do renderizador.** Mudou o volume desenhado,
atualize a pegada — senão o robô contorna um móvel de um tamanho e o olho vê outro.

Onde alguém fica em pé (`seatHome`, `standAt`) sai da **pegada**, não de um número
solto: era 1,5 fixo à frente da mesa, e com a mesa de 2,3 de fundo o robô parava
dentro da própria cadeira.

O nome do arquivo (ou comando, ou busca) não vira móvel: vive no registro, no
`a.subject` que o elenco mostra, e no rótulo temporário acima do volume.

As duas **estações** (`STATIONS`) são singulares no escritório inteiro e por isso
moram no saguão, com rótulo na planta. Quadro e arquivo morto deixaram de ser
estação: são de quem trabalha ali, e obrigar o robô a atravessar o escritório para
riscar um quadro era caminhada à toa.

## Mapear uma ferramenta nova para um móvel

Três lugares, nesta ordem:

1. `shape.mjs` → `propFor()`: qual `kind` a ferramenta produz. Se o `kind` não for
   estação nem estiver no `ROOM_LAYOUT`, ele cai na mesa.
2. `public/scene.mjs` → `STATIONS`, se o recurso for singular (existe um só no
   escritório e merece endereço fixo no saguão); ou `ROOM_LAYOUT`, se ele for de
   cada sala — e aí escolha uma parede livre, não uma vaga na fila.
3. `public/office.js` → `propVolume()`, o volume 3D; e `VERB`, o verbo em português
   que aparece no registro.

## O mundo 3D

A cena é `three.js` (ADR-0003). O `scene.mjs` raciocina em **coordenadas de mundo** —
`wx` para o lado, `wy` para a altura, `wz` para a profundidade — e é ele quem resolve
toda a geometria; o renderizador recebe pontos prontos e não calcula posição nenhuma.
É isso que mantém o `selftest.mjs` capaz de exercitar o posicionamento inteiro em Node.

**Um pavimento só** (ADR-0005). Não há andares, escada, poço, patamar nem
escalonamento diagonal — `wy` é constante, e some junto a classe inteira de bug em
que o robô parecia andar no ar. Se você veio de um commit antigo procurando
`stairSteps` ou `levelY`: eles não existem mais.

- **A planta é um T estrangulado** (`officeShape`, 12 pontos): três salas no fundo, o
  corredor cruzando à frente delas, uma **galeria** estreita descendo do meio e o
  saguão quadrado no fim dela. O saguão colado na fita das salas se lia como um
  recorte da mesma sala; separado e ligado por passagem, ele vira outro espaço. Há
  asserção do afastamento, de a galeria ser estreita, de estar centrada com o saguão e
  de as duas bocas dela ficarem abertas.
- **Todo trajeto entre os dois lados passa por dentro da galeria.** O `walkPath` tem o
  eixo dela como ponto obrigatório: o L simples de antes cortava a diagonal por cima
  da parede da galeria, e o robô entrava no saguão pelo lado de fora. O `selftest`
  mede no meio da galeria — toda perna que cruza aquela profundidade tem de estar
  entre as duas paredes. Robô não para na galeria, ele a atravessa; medir por ponto de
  parada não enxergava a travessia.
- **Nenhuma perna atravessa parede.** Cada perna é cruzada com cada segmento de
  `walls()`. Virou obrigatório quando o saguão se afastou.
- **A porta pisa na planta.** Fora dela, quem saía do escritório caminhava para o
  vazio. Há asserção de que a porta está dentro do contorno e dentro do saguão.
- **A boca do saguão e a frente dele ficam abertas.** `walls()` desenha só o fundo,
  as laterais e os trechos de frente **fora** do saguão; parede atravessada na boca
  trancava o escritório e ninguém entrava. Há asserção para as duas aberturas.
- **As divisórias param na boca do corredor** e são mais baixas que a parede: na
  altura da parede, a divisória tapava a sala do fundo, e a planta perdia justamente
  o que ela existe para mostrar.
- **A planta está em `SCALE` = 1,7** — e só a planta. Móvel cresce 1,3 (`PROP_K`), robô
  não cresce nada: multiplicar tudo na mesma proporção devolve o escritório de antes
  com outro número na câmera. É a folga que sobra dessa diferença que paga o contorno
  de mobília. O passo do robô (`SPEED`) e o passo da grade acompanham a escala, senão a
  mesma travessia leva 1,7× mais tempo e a grade vira trama.
- **O atalho reto do `walkPath` só vale dentro do mesmo espaço** (`freeRects`). Dois
  pontos com a mesma profundidade em salas vizinhas davam uma perna reta que varava a
  divisória — e a mesa que estivesse no meio do caminho.
- **O terreno** (`terrainRect`) é o chão em que o escritório se apoia, com folga fina
  e calçada marcada. Sem ele o piso flutuava no vazio; com folga larga, o escritório
  parecia perdido no lote e o olho ia para a grama.
- **O terreno fica fora do grupo que a câmera mede.** Ele é maior que o escritório de
  propósito, e enquadrar por ele fazia o escritório aparecer pequeno no meio de um mar
  de calçada — o enquadramento obedecia à grama.
- **Quem termina o serviço sai andando.** O `agent-leave` fica pendente até a fila de
  pernas do robô esvaziar: ele cruza o corredor, atravessa o saguão e só desaparece na
  porta. Removê-lo no mesmo quadro fazia o robô sumir de dentro da própria sala.
- **Texto é DOM**, numa camada sobre o canvas, reposicionado por quadro a partir do
  ponto de mundo. Textura de texto perde nitidez no zoom.
- **Enquadramento**: mede a caixa do grafo desenhado e mira a faixa livre entre os
  trilhos. Os painéis flutuam sobre o palco, então a largura do canvas não é a largura
  útil — foi assim que o escritório ficou desenhado atrás do registro.
- **Pé-direito baixo (1,9) e câmera alta.** Parede alta com câmera baixa projeta sobre
  o piso e a sala vira uma faixa preta.
- **A câmera orbita**: arrastar gira, roda aproxima, duplo clique volta ao
  enquadramento automático. Para print, `?view=azim,elev,zoom` fixa a órbita — o
  headless não arrasta o mouse.

**Seis postos, seis matizes.** Dois postos por sala, três salas (`SEAT_COUNT`), e a
paleta tem exatamente seis matizes (`HUE_COUNT`) — o escritório cheio não repete cor.
O sétimo agente divide posto com um passo de lado, em vez de inaugurar um espaço que
ninguém pediu.

**O piso é liso, e a cor é que separa os espaços.** Salas e corredor num azul escuro,
o saguão em violeta. O xadrez saiu: com móveis espalhados e robôs acesos em cima, o
piso quadriculado virava um segundo padrão disputando a atenção. Calçada e terreno
continuam com textura (`patternTex`) — eles são fundo, não palco.

**Direção Sumida** (ADR-0006): o escritório é noite. Toda superfície grande fica
abaixo de 30% de luz e **quem emite é quem se lê** — a regra de valor do ADR-0004
inverteu de sinal. Néon é luz, não tinta: a fita da quina e do rodapé, a tela acesa e
a fita da carcaça são `MeshBasicMaterial`, não dependem de lâmpada e não escurecem
junto com a parede em que estão pregadas. **Subir as luzes da cena para "clarear" só
lava o azul e mata o contraste que faz o néon existir** — se a cena parecer apagada, o
que falta é emissão, não lâmpada.

**Cor de material precisa de `SRGBColorSpace`.** `setHSL(h, s, l)` sem o quarto
argumento faz o `three` ler o valor como se já fosse linear, converter de novo na
saída e devolver a cor lavada: o piso de 62% de saturação chegava à tela com 20%, e o
escritório parecia creme por mais que a paleta subisse. Isso não aparecia nas texturas
de canvas, que passam por `css()` e já são sRGB — daí a calçada sair correta e o piso
não. Medido lendo o pixel do print, não olhando.

**Textura de chão e cor de material se multiplicam.** `patternTex` pinta a cor da
paleta dentro do canvas; se o material também levar essa cor, o tom sai ao quadrado.
Com o terreno a 11% de luz isso deu **preto puro**, e a rua sumiu — o chão de fora
parecia um buraco recortado em volta do escritório. Material com `map` de textura
colorida vai de `color: 0xffffff`.

**Meça o pixel do print, não julgue de olho.** Foi assim que a diferença entre dois
ajustes de luz, invisível a olho nu, apareceu como 17% de luminosidade — e foi assim
que o problema do espaço de cor apareceu como 62% de saturação virando 20%. Há um
leitor de PNG de trinta linhas no histórico do projeto; refazê-lo custa menos que
uma discussão sobre se a cor "parece" certa.

**A subida da escada por quadros virou o passo do robô** (issue #16): as duas poses
alternam a cada 150 ms movendo as esteiras. Quem manda é o laço, não uma animação
cíclica de CSS — qualquer quadro é pose íntegra, e o print nunca pega o robô torto.

**O agente é nomeado pela tarefa, não pelo tipo.** Metade dos subagentes chega como
`general-purpose`, e três "general-purpose" na planta não dizem quem é quem. O `Task`
traz a descrição; o `apelido()` a reduz a duas palavras de conteúdo ("mapear todos os
handlers de auth" → *mapear handlers*), e o `SubagentStart` que vem logo atrás a
recebe como nome. A convocação fica pendente em `scene.chamado` e **tem um dono só**.
O `agent_type` não some: vira a legenda da carta.

O registro guarda o nome de quem já saiu (`nomes`, no `office.js`) — sem isso a mesma
linha do log mudava de nome no meio da sessão, do apelido de volta para o tipo cru.

**Clicar num robô abre a carta de personagem.** A planta mostra **onde** cada agente
está; a carta mostra **quem** ele é e o que faz agora — retrato vetorial no matiz
dele, tipo, estado, ferramenta atual, posto, contagem e última fala. O clique só conta
se o ponteiro não andou mais de 5 px: sem essa distinção, girar a câmera abria a carta
ao soltar. O raycast testa só os grupos de robô, e o grupo carrega `userData.botId`.
Para print, `?card=<id|n>` abre a ficha no arranque — o headless não clica.

**A carta é fixa no canto do palco**, não presa ao robô. Ela seguia o dono, e o dono
anda: a ficha escorregava enquanto se lia, e uma volta de câmera a jogava para o outro
lado da tela. Quem é o dono já está dito pela cor da borda e pelo retrato. O recuo é
`var(--rail-l)`, não 14 px cru: **o palco corre por baixo dos painéis**, e a ficha
nascia debaixo do elenco.

**Os seis matizes giram pela paleta** (`allocHue`). Era `agents.size % HUE_COUNT`, com
três defeitos calados: o principal contava no tamanho e o **índice 0 nunca saía**; o
matiz de quem saía voltava para o começo da fila; e por isso o sexto — o **rosa** —
só existiria numa sessão com cinco subagentes vivos ao mesmo tempo. Girando, os seis
aparecem ao longo da sessão e dois vivos nunca repetem cor.

**Balões: no máximo três, e nenhum cobre o outro** (issue #13). O teto está em
`MAX_BUBBLES`; o quarto empurra o mais antigo, cujo texto já está no registro. A
colocação é em pixel, no `placeBubbles`. A fala é cortada em palavra inteira no JS — o
`-webkit-line-clamp` punha as reticências na terceira linha e ainda pintava a quarta.

**`?probe` conta robô no ar.** A sonda soma os quadros em que um robô muda de altura e
publica em `document.documentElement.dataset.air` (`quadros|maior salto`). Sem andares
qualquer variação é bug, então o valor tem de ser `0|0.000` — a sonda ficou mais severa
do que era, e de graça. Ela também publica `dataset.plats` e `dataset.bubbles`.

## Trajeto e ritmo

Robô não teleporta e não corta caminho pelo ar. O `scene.mjs` devolve um
**trajeto** — uma perna por comando `agent-move` —, e o `office.js` encadeia as
pernas por promessa, com **velocidade constante** (`SPEED`, px/s): percurso
longo leva mais tempo, e duas caminhadas diferentes parecem o mesmo robô.

- O caminho é sempre em L: sai do lugar até o corredor (`LANE`), corre pelo
  corredor e entra no destino. Vale para ir de sala a sala, da sala ao saguão e do
  saguão à porta — não há mais caso especial, porque não há mais andar.
- **Nenhuma perna atravessa uma divisória.** O `selftest` cruza cada perna com cada
  divisória e conta as travessias: o atalho na diagonal se lia como robô passando
  por dentro da parede.

**Trajeto novo cancela o anterior.** A primeira perna vem marcada com `start`, e
o renderizador descarta a fila velha. Sem isso, uma sessão em rajada acumula
minutos de caminhada pendente e a planta passa a mostrar onde os agentes
estavam, não onde estão.

## Invariantes do desenho

*O escritório é colorido; o agente se acha por valor, matiz e silhueta* (ADR-0004 —
revoga o "desenho frio, gente quente" original). O escritório é claro e saturado; a
carcaça do robô é saturada e de valor médio, os seis matizes de agente ficam a 24°
um do outro e a 20° de qualquer cor de fundo, e o robô é a única forma alta e
arredondada num mundo de caixas.

A paleta mora em `public/palette.mjs`, sem DOM e sem `three`, e o `selftest.mjs`
afirma essas distâncias: pintar uma parede da cor de um robô reprova o teste. A
interface 2D fica sóbria de propósito — moldura escura, cena colorida. Os agentes são
robôs de esteira com carcaça colorida — a carcaça *é* o matiz. Os subagents
recebem os **seis** matizes da paleta (`AGENT_HUES`, movida pelo ADR-0006 para fora da
faixa azul que virou fundo); o principal recebe um gradiente arco-íris,
e esse gradiente tem que aparecer igual no robô, no elenco e no registro. (A
invariante do creme foi revogada — veja `docs/adr/0002`.)

Anotação é mono, título é sans. Móvel é volume, nunca emoji — o robô é a única
figura desenhada da tela, e é vetorial: matiz por variável CSS, nada de sprite
pré-renderizado por cor.

O robô segue as fotos de `media-agents/`: cubo de quinas arredondadas, tela
dominante com olhos redondos e boca de traço, alça no topo, parafusos, plaqueta
gravada e esteiras com roldanas. Ao mudar o desenho, olhe as fotos antes.

O vocabulário está em `CONTEXT.md`. **Posto** é do agente, **sala** e **móvel** são
do escritório, **estação** é do saguão; "cômodo", "andar" e "boneco" não existem
mais.

## Hooks

Vivem no `~/.claude/settings.json` global; `node install-hooks.mjs` os escreve
lá (idempotente) e guarda o arquivo anterior em
`settings.json.antes-do-escritorio`. São do tipo `http` (~3,5 ms) porque o tipo
`command` custa ~219 ms de arranque do Node em **toda** ferramenta usada. A
exceção é o `SessionStart`, que roda um `command` para subir o servidor.

Os campos que sustentam a cena são `agent_id` e `agent_type` — eles vêm junto
em todo evento de ferramenta executado dentro de um subagent, e é isso que
permite saber qual boneco mexeu em qual móvel.

## Agent skills

### Issue tracker

Issues ficam no GitHub Issues de `DevLeonardoK/agent-office`, via `gh` CLI. Veja `docs/agents/issue-tracker.md`.

### Triage labels

Os cinco rótulos canônicos, sem renomeação. Veja `docs/agents/triage-labels.md`.

### Domain docs

Contexto único — `CONTEXT.md` e `docs/adr/` na raiz. Veja `docs/agents/domain.md`.
