# Escritório dos Agentes

Visualiza a atividade do Claude Code como uma planta baixa: hooks → servidor →
navegador. Node puro, sem `npm install` — `motion.dev` está vendorizada em
`public/vendor/motion.js` como bundle fechado.

```
node selftest.mjs        # 153 verificações: scene.mjs, os hooks e a sintaxe do renderizador
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

**A motion.dev é dona do `transform`.** Ela compõe o transform a partir de
`x`/`y`/`scale` via WAAPI, sem escrever no atributo `style`. Um
`node.style.transform` escrito na mão funciona até a primeira animação e depois
some. Posição passa por `animate(node, {x, y}, {duration: 0})`.

**O servidor responde 204 com corpo vazio em `POST /hook`.** Qualquer outra
coisa vira aviso de erro no transcript do usuário, a cada ferramenta usada.

**`MIME` em `server.mjs` precisa de `.mjs`.** Sem isso o navegador recebe
`application/octet-stream` e recusa o módulo — a página fica em branco, sem erro
visível na aba de rede.

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
```

O orçamento de 12 s não é folga: com o ritmo lento e a viagem em três pernas, um
print de 3 s pega os robôs no meio do caminho e parece bug de posicionamento.

O `upto=21` para o roteiro com seis agentes vivos — é onde o 2º andar existe. O
print não clica, então a vista de andar cheio se pede pela URL: `&floor=1` abre
o 2º andar assim que ele nascer.

Antes de perseguir uma deformação vista em print, meça a geometria real com
`getBoundingClientRect` num `--dump-dom`.

## A vista

Uma só: o prédio empilhado, enquadrado por `buildingRect(scene)`. Havia também
uma vista de andar cheio; ela foi removida — no prédio isométrico, duas
leituras do mesmo espaço confundiam mais do que ajudavam.

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

## O mundo isométrico

A referência é `media-agents/escriotorio1.png`: plataformas em losango
empilhadas, piso ladrilhado, duas paredes por andar. O `scene.mjs` raciocina em
**coordenadas de mundo** — `(wx, wy)` em ladrilhos sobre a plataforma, mais o
andar — e projeta com `iso()`. Todo comando sai já em pixel, então o
renderizador continua sem geometria própria.

Consequências que já morderam:

- **Cômodo é losango, não retângulo.** `roomRect` existe só para enquadramento;
  quem testa contenção usa `roomQuad` com ponto-dentro-de-polígono.
- **Deslocar não é mudar de cômodo.** Na realocação, os móveis recebem vaga
  nova via `propSlot`; somar um `dy` — o que funcionava na elevação — põe o
  móvel no vizinho.
- **Ordem de desenho é profundidade.** O `z-index` do robô sai do y de tela;
  sem isso, quem está no fundo aparece por cima da parede da frente.

O **poço do elevador** fica atrás das plataformas (`SHAFT.wy` negativo) e é
desenhado antes delas; a cabine, depois de tudo, para ser vista. A viagem até
uma estação sai em três pernas (`leg: board | ride | off`), encadeadas por
promessa no renderizador: sem o encadeamento a motion troca o destino no meio e
o robô corta caminho pelo ar.

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
recebem os cinco matizes da paleta; o principal recebe um gradiente arco-íris,
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
