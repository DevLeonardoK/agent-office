# Escritório dos Agentes

Visualização ao vivo do que o Claude Code está fazendo, desenhada como uma
**planta baixa**. Cada agente é um boneco que entra pela porta, caminha até o
móvel certo, trabalha nele e fala por balões.

    escritorio.cmd          →  abre em http://127.0.0.1:4517
    /?demo                  →  cena encenada, sem precisar do Claude Code rodando

## A direção visual

*Desenho frio, gente quente.* O prédio é traçado como desenho técnico — linha
dupla na parede externa, marcas de canto, cota de largura, e móveis como
símbolos de planta de verdade (a mesa com o arco da cadeira, a porta com o arco
de abertura). Tudo em azul de prancheta dessaturado.

Os agentes são a única coisa saturada e quente da tela. Toda a ousadia é gasta
neles; o resto fica quieto de propósito, para o olho ir direto em quem está se
mexendo. O agente principal não usa matiz nenhuma — é creme, de outro material,
e por isso se distingue sem precisar de legenda.

A tipografia é mono em toda anotação, porque essa é a voz do desenho técnico,
contra a sans do sistema só nos títulos. O contraste mono/sans *é* o par
tipográfico.

## Como ler a cena

| No escritório | O que é de verdade |
| --- | --- |
| Boneco creme | o agente principal da sessão |
| Bonecos coloridos | subagents — a matiz vem do tipo (`Explore`, `Plan`, …) |
| Entrar pela porta | `SubagentStart` |
| Sair pela porta | `SubagentStop`, com o resultado no balão |
| Mesa com cadeira | `Read` / `Edit` / `Write` — uma mesa por arquivo |
| TERMINAL | `Bash` / `PowerShell` |
| ARQUIVO | `Grep` / `Glob` |
| BIBLIOTECA | `WebFetch` / `WebSearch` |
| MANUAIS | `Skill` |
| QUADRO | `TodoWrite` / `Workflow` |
| Móvel aceso | alguém acabou de usar |

Recursos que existem em um exemplar só (terminal, arquivo, biblioteca) têm
endereço fixo na planta. Arquivos são muitos e imprevisíveis, então ocupam a
grade de MESAS conforme aparecem.

Dois agentes lendo o **mesmo** arquivo dividem a mesma mesa, um de cada lado —
é assim que se enxerga trabalho sobreposto.

O trilho da esquerda é o resumo (quem está no prédio, fazendo o quê, com o
estado codificado na *forma* do quadradinho, não só na cor). O da direita é o
detalhe: qual regex, qual URL, qual comando.

## Várias sessões

Cada sessão do Claude Code é uma **sala**, escolhida no seletor do topo. Com
*seguir a ativa* marcado, a tela pula sozinha para a sessão que se mexeu — mas
só se a sala atual estiver parada há mais de 20s, senão duas janelas
simultâneas ficariam arrancando a tela uma da outra. Escolher no seletor
desliga o piloto automático.

## Arquitetura

    Claude Code ──hooks http──▶ server.mjs ──SSE──▶ navegador (DOM + SVG)

| Arquivo | Papel |
| --- | --- |
| `shape.mjs` | traduz o payload cru do hook no evento da cena — é aqui que se mapeia uma ferramenta nova para um móvel novo |
| `server.mjs` | recebe `POST /hook`, guarda o estado de cada sala, transmite em `GET /events`. `GET /state` devolve tudo em JSON |
| `public/scene.mjs` | o estado da cena: onde cada boneco e cada móvel ficam. **Sem uma linha de DOM**, para ser testável em Node |
| `public/office.js` | o renderizador: só decide como cada comando da cena vira pixel |
| `public/demo.mjs` | o roteiro encenado |
| `ensure-server.mjs` | sobe o servidor se estiver fora do ar |

A separação `scene` / `office` é o que permite o `selftest.mjs` exercitar toda
a lógica de posicionamento sem navegador.

### Animação

`motion.dev`, vendorizado em `public/vendor/motion.js` — um bundle fechado, sem
import externo, então o escritório funciona offline e sem `npm install`.

O caminhar usa spring de verdade: quando um agente recebe um destino novo no
meio do trajeto, a motion preserva a velocidade e não dá solavanco. As
passadas, a digitação e a respiração são keyframes CSS, porque são cíclicas e
não precisam de física.

> **Atenção ao mexer:** a motion compõe o `transform` a partir de `x`/`y`/
> `scale`. Escrever `style.transform` na mão funciona até a primeira animação
> e depois é sobrescrito — posição tem que passar pela motion também.

`prefers-reduced-motion` desliga tudo.

### Por que hooks `http` e não `command`

Um hook `command` gasta ~219 ms por chamada só para iniciar o Node, e isso
entraria em **toda** ferramenta que o Claude Code usa. O hook `http` faz o
Claude Code postar o JSON direto no servidor: **3,5 ms**, sem subprocesso.

O `SessionStart` é a única exceção — ali um `command` sobe o servidor, porque
roda uma vez por sessão e o custo não importa.

## Ligado a quê

Os hooks estão em `~/.claude/settings.json`, no bloco `"hooks"`. O backup de
antes está em `~/.claude/settings.json.antes-do-escritorio`.

Para desligar, apague o bloco `"hooks"` (ou só os pares que não quiser). Se o
servidor estiver fora do ar, os hooks `http` falham como erro **não-bloqueante**:
nada trava, mas o transcript mostra aviso — por isso o `SessionStart` sobe o
servidor sozinho.

## Testes

    node selftest.mjs     # 29 verificações sobre scene.mjs + sintaxe do renderizador
    node simulate.mjs     # encena uma sessão pelo servidor, como se fosse o Claude Code

O `selftest` cobre os casos que quebram na prática: dois agentes no mesmo
móvel, mais arquivos do que mesas, agente saindo no meio da fala, troca de
sala, evento de tipo desconhecido.

### Tirar print

Navegador headless trava na página ao vivo, porque o stream SSE nunca deixa a
página "terminar de carregar". Use o modo demo:

    chrome --headless=new --screenshot=shot.png --window-size=1500,860 \
      --virtual-time-budget=2500 "http://127.0.0.1:4517/?demo&instant&upto=17"

`instant` aplica o roteiro de uma vez e zera as durações; `upto=N` para em N
eventos; `virtual-time-budget` é necessário para as animações CSS cíclicas
saírem do primeiro frame — sem ele os bonecos aparecem deformados no print.
