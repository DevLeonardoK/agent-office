# Escritório em 3D com three.js

O escritório passa a ser uma cena 3D desenhada com `three.js`, no lugar do
desenho em SVG e DOM animado pela `motion.dev`. As plataformas dos andares se
escalonam em diagonal, cada uma com a planta pentagonal — o retângulo com o
canto do fundo chanfrado —, e uma escada liga um andar ao seguinte.

Escolhemos 3D de verdade em vez de continuar melhorando a projeção oblíqua
porque a projeção não resolvia o que se queria ver: quem está atrás de quem, o
robô subindo entre dois andares, o prédio ganhando altura. Cada tentativa de
sugerir volume em 2D acrescentava um caso especial de ordem de desenho, e o
resultado seguia lido como adesivo colado no piso.

## O que não muda

A costura. O `scene.mjs` continua decidindo **onde** cada coisa fica e devolvendo
comandos; o renderizador continua decidindo **como** um comando vira imagem. O
que mudou é a unidade: a cena raciocina em **coordenadas de mundo** — `wx` para o
lado, `wy` para a altura, `wz` para a profundidade — em vez de pixels de tela.

Isso preserva a única rede de proteção que o projeto tem: o `selftest.mjs`
exercita todo o posicionamento em Node, sem navegador, e as 183 verificações
falam de mundo (o cômodo contém o ponto, o degrau sobe em relação ao anterior, o
andar de cima está deslocado na diagonal). Se a geometria tivesse migrado para
dentro do `three`, não haveria como afirmar nada sem um navegador.

## Consequências

- **A `motion.dev` sai do renderizador.** Em 3D não existe `transform` de CSS
  para ela compor, então o laço de animação do `three` é o dono do movimento. A
  armadilha "a motion é dona do transform" deixa de valer para a cena; ela segue
  disponível para a interface 2D dos trilhos, se voltar a ser útil.
- **O `three` é vendorizado**, em `public/vendor/three.js` (r169, 1,3 MB), como
  módulo ES já empacotado. Sem `npm install`, sem CDN em tempo de execução e sem
  passo de build — a mesma regra que trouxe a `motion.dev` para dentro do repo.
- **Texto continua sendo DOM.** Plaquetas, balões e rótulos de estação vivem numa
  camada sobre o canvas e são reposicionados por quadro, projetando o ponto de
  mundo com a câmera. Textura de texto perderia nitidez no zoom e sujaria a
  tipografia, que é metade do desenho deste projeto.
- **A câmera é ortográfica.** É a projeção que mantém a leitura de planta: um
  cômodo do 3º andar mede o mesmo que um do 1º, e nada afunila com a distância.
  O enquadramento mede a caixa do grafo desenhado e mira a faixa livre entre os
  trilhos — os painéis flutuam sobre o palco, então a largura do canvas não é a
  largura útil.
- **O elevador é substituído pela escada.** O poço, a cabine e o comando `cabin`
  saem; a viagem entre andares passa a ser uma sequência de degraus, com um
  comando por degrau, para o renderizador poder animar a subida. O vocabulário do
  `CONTEXT.md` acompanha: poço e cabine saem, escada e degrau entram.
- **Sem sombra projetada.** Custa um passe de render por quadro e suja o desenho
  minimalista; o volume vem da luz direcional e do preenchimento hemisférico.
- **O pé-direito é baixo (1,9).** Parede alta, com a câmera inclinada, projeta
  sobre o piso do próprio andar e o cômodo vira uma faixa preta.

## O que fica em aberto

O acabamento. As plataformas superiores ainda ficam mais escuras do que deveriam
em certos ângulos, o balanço do robô na escada é rudimentar (issue #16 pede
quadros próprios para a subida) e os móveis são volumes simples. Nada disso
bloqueia o modelo — são passes de desenho sobre uma cena que já está de pé.
