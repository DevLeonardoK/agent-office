# Escritório dos Agentes

Visualiza a atividade do Claude Code como um escritório 3D: hooks → servidor →
navegador. Node puro, sem `npm install` — `three.js` e `motion.dev` estão
vendorizadas em `public/vendor/` como bundles fechados.

```
node selftest.mjs        # 217 verificações: scene.mjs, os hooks e a sintaxe do renderizador
node simulate.mjs        # encena uma sessão pelo POST /hook, como o Claude Code faz
node ensure-server.mjs   # sobe o servidor se estiver fora do ar (idempotente)
```

## A costura

`public/scene.mjs` decide **onde** cada boneco e cada móvel ficam e devolve uma
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
dois grupos de face nessa ordem; passar `[lateral, tampa]` pinta o topo da
plataforma com a cor da borda e o andar inteiro aparece apagado. Medido em Node
com `boundingBox` e `groups` — quando a dúvida é de geometria, meça, não olhe.

**Duas faixas por lance de escada.** O pé do lance é o mesmo ponto para todos, e
dois robôs subindo ao mesmo tempo se sobrepunham no degrau. `stairLaneOffset` dá
a faixa perpendicular, e o `a.flight` fica marcado até o próximo movimento do
robô — o trajeto é calculado de uma vez, mas percorrido em tempo, e é isso que
permite saber quem ainda está na escada.

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

O orçamento não é folga: com o ritmo lento e a subida degrau a degrau, um print
curto pega os robôs no meio do caminho e parece bug de posicionamento. No modo
demo, `document.documentElement.dataset.ready` vira `true` quando o roteiro
acaba — é o sinal de que a cena pode ser fotografada.

O `upto=21` para o roteiro com seis agentes vivos — é onde o 2º andar existe. O
print não clica, então a vista de andar cheio se pede pela URL: `&floor=1` abre
o 2º andar assim que ele nascer.

Antes de perseguir uma deformação vista em print, meça a geometria real com
`getBoundingClientRect` num `--dump-dom`.

## A vista

Uma só: o prédio inteiro, enquadrado a partir de `buildingBounds(scene)`. Havia
também uma vista de andar cheio; ela foi removida — duas leituras do mesmo
espaço confundiam mais do que ajudavam.

## Mobília fixa (issue #14)

A mobília é do **cômodo**, não do agente e não do evento: montada quando o
cômodo ganha ocupante (`furnishRoom`), desmontada quando esvazia
(`unfurnishRoom`), com chave `room<slot>|<kind>`. Usar uma ferramenta **acende**
o móvel que já está lá — nunca cria. Tipo sem móvel próprio cai na mesa.

O nome do arquivo (ou comando, ou busca) não vira móvel: vive no registro, no
`a.subject` que o elenco mostra, e no `title` do móvel. Antes, cada ferramenta
criava um móvel com o nome do arquivo, e o cômodo enchia de marcas do passado —
o oposto de *a planta mostra o agora*.

As quatro **estações** do térreo seguem por outro caminho (`ensureStation`):
singulares, criadas no primeiro uso, com rótulo na planta. A mobília do cômodo
não tem rótulo — escrever "mesa" cinco vezes por andar era só ruído.

## Mapear uma ferramenta nova para um móvel

Três lugares, nesta ordem:

1. `shape.mjs` → `propFor()`: qual `kind` a ferramenta produz. Se o `kind` não
   for estação nem estiver em `ROOM_FURNITURE`, ele cai na mesa.
2. `public/scene.mjs` → `STATIONS`, se o recurso for singular (existe um só no
   prédio e merece endereço fixo no térreo). Arquivos não entram aqui — eles
   viram móvel dentro do cômodo do agente que os tocou, com chave composta por
   agente e recurso.
3. `public/office.js` → `SYMBOL`, o desenho em símbolo de planta, e `VERB`, o
   verbo em português que aparece no registro.

## O mundo 3D

A cena é `three.js` (ADR-0003). O `scene.mjs` raciocina em **coordenadas de
mundo** — `wx` para o lado, `wy` para a altura, `wz` para a profundidade — e é
ele quem resolve toda a geometria; o renderizador recebe pontos prontos e não
calcula posição nenhuma. É isso que mantém o `selftest.mjs` capaz de exercitar o
posicionamento inteiro em Node.

- **Andares escalonados em diagonal** (`platformOrigin`): cada plataforma nasce
  deslocada da de baixo, para nenhuma tapar a outra.
- **Plataforma pentagonal** (`platformShape`): o retângulo com o canto do fundo
  chanfrado — é o chanfro que abre lugar para a escada.
- **Escada, não elevador** (`stairFoot`, `stairHead`, `stairSteps`): a viagem
  entre andares é uma sequência de degraus, um comando `agent-move` por degrau.
- **Texto é DOM**, numa camada sobre o canvas, reposicionado por quadro a partir
  do ponto de mundo. Textura de texto perde nitidez no zoom.
- **Enquadramento**: mede a caixa do grafo desenhado e mira a faixa livre entre
  os trilhos. Os painéis flutuam sobre o palco, então a largura do canvas não é
  a largura útil — foi assim que o prédio ficou desenhado atrás do registro.
- **Pé-direito baixo (1,9) e câmera alta.** Parede alta com câmera baixa projeta
  sobre o piso do próprio andar e o cômodo vira uma faixa preta.
- **A câmera orbita**: arrastar gira, roda aproxima, duplo clique volta ao
  enquadramento automático. Enquanto ninguém girou, o enquadramento se refaz a
  cada mudança do prédio; depois de girar, o ângulo é do usuário. Para print,
  `?view=azim,elev,zoom` fixa a órbita — o headless não arrasta o mouse.

**A paleta tem seis matizes e o número mora no `scene.mjs`** (`HUE_COUNT`). Era um
`% 5` casado por acidente com os cinco cômodos por andar; com o rosa (issue #17)
são seis, e um andar cheio pode repetir cor — preço aceito para o rosa existir e
não se confundir com o violeta.

**`?probe` conta robô no ar.** A sonda soma os quadros em que um robô muda de
altura fora de uma perna de escada e publica em `document.documentElement.dataset.air`
(`quadros|maior salto`). Serve para provar com número, e não com print, que
ninguém sobe pelo vazio — no roteiro do demo o valor tem de ser `0|0.000`.

**A porta pisa na plataforma do térreo.** Fora dela, quem saía do prédio caminhava
para o vazio e parecia flutuar numa escada imaginária ao lado do prédio. Há
asserção de que a porta está dentro da plataforma.

**Todo subagente entra pela porta do prédio.** Nasce no térreo e sobe a escada
até o cômodo dele — inclusive o filho convocado por outro agente. A issue #10
tinha feito o filho nascer ao lado do pai; num prédio de vários andares isso o
fazia simplesmente aparecer no andar de cima, sem trajeto. O `doorAgent` e a
`parentDoor` saíram junto.

**Mudar de andar é sempre pela escada.** Quem decide é o `moveTo`: se o destino
está em outro andar, ele roteia por `stairsTo`. Antes cada chamador escolhia, e o
`stop` esqueceu — o agente saía do prédio atravessando o vazio na diagonal, o que
se lia como robô perdido andando no ar. Há asserção no `selftest`: nenhuma perna
de caminhada muda de altura fora da escada.

## Trajeto e ritmo

Robô não teleporta e não corta caminho pelo ar. O `scene.mjs` devolve um
**trajeto** — uma perna por comando `agent-move` —, e o `office.js` encadeia as
pernas por promessa, com **velocidade constante** (`SPEED`, px/s): percurso
longo leva mais tempo, e duas caminhadas diferentes parecem o mesmo robô.

- Dentro do andar, o caminho é em L: sai do cômodo até o corredor da frente
  (`LANE`), corre pelo corredor e sobe para o destino.
- Entre andares, é o elevador: anda até a porta do poço, embarca, viaja com a
  cabine (`ride`, 1,4 s), desembarca e caminha até o alvo. A cabine parte meio
  segundo depois do embarque — cabine que sai antes do passageiro faz a cena
  parecer quebrada mesmo com as posições certas.

**Trajeto novo cancela o anterior.** A primeira perna vem marcada com `start`, e
o renderizador descarta a fila velha. Sem isso, uma sessão em rajada acumula
minutos de caminhada pendente e a planta passa a mostrar onde os agentes
estavam, não onde estão.

## Invariantes do desenho

*Desenho frio, gente quente.* O prédio inteiro é azul de prancheta
dessaturado; os agentes são a única coisa saturada da tela. Os agentes são
robôs de esteira com carcaça colorida — a carcaça *é* o matiz. Os subagents
recebem os **seis** matizes da paleta (âmbar, vermelho, verde, violeta, magenta e
rosa); o principal recebe um gradiente arco-íris,
e esse gradiente tem que aparecer igual no robô, no elenco e no registro. (A
invariante do creme foi revogada — veja `docs/adr/0002`.)

Anotação é mono, título é sans. Móvel é símbolo de planta, nunca emoji — o robô
é a única figura desenhada da tela, e é vetorial: matiz por variável CSS, nada
de sprite pré-renderizado por cor.

O robô segue as fotos de `media-agents/`: cubo de quinas arredondadas, tela
dominante com olhos redondos e boca de traço, alça no topo, parafusos, plaqueta
gravada e esteiras com roldanas. Ao mudar o desenho, olhe as fotos antes.

O vocabulário está em `CONTEXT.md`. Cômodo é do agente, estação é do prédio, e
"boneco" não existe mais — é robô.

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
