# Escritório dos Agentes

Visualiza a atividade do Claude Code como uma planta baixa: hooks → servidor →
navegador. Node puro, sem `npm install` — `motion.dev` está vendorizada em
`public/vendor/motion.js` como bundle fechado.

```
node selftest.mjs        # 29 verificações sobre scene.mjs + sintaxe do renderizador
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

**Print headless exige o modo demo.** A página ao vivo mantém o SSE aberto e
nunca termina de carregar, então o headless trava. E as animações CSS cíclicas
congelam no primeiro frame, o que faz os bonecos saírem deformados no print —
parece bug de layout e não é:

```
chrome --headless=new --screenshot=shot.png --window-size=1500,860 \
  --virtual-time-budget=2500 "http://127.0.0.1:4517/?demo&instant&upto=17"
```

Antes de perseguir uma deformação vista em print, meça a geometria real com
`getBoundingClientRect` num `--dump-dom`.

## Mapear uma ferramenta nova para um móvel

Três lugares, nesta ordem:

1. `shape.mjs` → `propFor()`: qual `kind` a ferramenta produz.
2. `public/scene.mjs` → `STATIONS`, se o recurso for singular (existe um só no
   prédio e merece endereço fixo). Arquivos não entram aqui — eles ocupam a
   grade `DESKS` conforme aparecem.
3. `public/office.js` → `SYMBOL`, o desenho em símbolo de planta, e `VERB`, o
   verbo em português que aparece no registro.

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

O vocabulário está em `CONTEXT.md`. Cômodo é do agente, estação é do prédio, e
"boneco" não existe mais — é robô.

## Hooks

Vivem no `~/.claude/settings.json` global; o backup de antes está em
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
