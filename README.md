# The NEURONS boardgame

*[English](#english) | [日本語](#日本語)*

A two-player card game of growing neural circuits, playable in the browser against a CPU opponent. The whole game is a single self-contained HTML file (about 37 KB) with no dependencies, no build step, and no server requirements.

Originally designed as a physical card game with hand-drawn index cards, then digitized.

---

## English

### Play

Open `index.html` in any modern browser, or visit the GitHub Pages site for this repository. The interface switches between Japanese and English with the button in the header (it defaults to your browser language).

### The game

White (you) and Black (CPU) take turns placing cards to grow a shared network of neurons. Each card carries a line segment with a circle (a neuron) of the owner's color, or a lone circle with no line. Lines enter and leave cards at their corners, so neighboring cards connect automatically.

When lines close into a polygon, the circuit fires. Count the circles on the circuit's perimeter, plus any circle-only cards enclosed inside it. The player whose color has the majority scores the total count of circles. On a tie the circuit fizzles: nobody scores, and that exact polygon can never score again.

- Hand of 5 cards. Place one, draw one, from your own deck.
- Cards go on empty cells that touch a placed card by an edge or a corner (an edge-only variant is available in the mode selector).
- The board is 13×13 cells; a dashed frame marks the boundary when play approaches it.
- Each deck (24 cards per color): diagonal ×8, V-line ×8, cross ×4, circle only ×4.
- Cards may be rotated freely before placing.
- Lines that already scored can be reused as edges of a new, different polygon.
- One placement can complete several circuits at once, including by splitting a large polygon into smaller ones.
- When both players have placed all cards, the higher total score wins.

### Controls

Tap a card in your hand to select it, tap it again (or the Rotate button, or the R key) to rotate, then tap a highlighted cell to place. On desktop, hovering a cell previews the placement.

### Under the hood

- Circuit detection is planar face enumeration on the graph formed by all placed lines (half-edge traversal with angular sorting), so simultaneous and nested circuit completions are handled correctly.
- The CPU evaluates every legal placement of every hand card, using a union-find pre-filter so exact circuit scoring runs only where a circuit can actually close. Its top candidates are then scored two-sided: the opponent's best reply is subtracted, and the CPU's own follow-up threats (including unstoppable double threats) are added.
- Everything lives in one HTML file: no frameworks, no external assets.

### Hosting on GitHub Pages

[Neurons Board Game](https://eijwat.github.io/neurons_boardgame/)

---

## 日本語

### 遊ぶ

`index.html` をブラウザで開くか、このリポジトリのGitHub Pagesサイトにアクセスしてください。ヘッダーのボタンで日本語と英語を切り替えられます(初期言語はブラウザ設定に従います)。

### ゲームについて

白(あなた)と黒(CPU)が交互にカードを置き、1つのニューロンネットワークを育てていきます。カードには持ち主の色の丸(ニューロン)が乗った線、または線のない丸だけが描かれています。線はカードの角で出入りするため、隣に置くだけで自然につながります。

線が閉じて多角形ができたら、サーキットの発火です。多角形の辺上にある丸と、内側に囲われた「丸のみカード」を色ごとに数え、多い色のプレイヤーが丸の総数を得点します。同数の場合は不成立となり、誰も得点せず、その多角形は二度と得点できません。

- 手札は5枚。1枚置いたら自分の山札から1枚引く。
- カードは、すでに置かれたカードと辺または角で接する空きマスに置く(モード選択で「辺のみ」の変則ルールも選べる)。
- 盤面は13×13マス。端に近づくと境界の点線が表示される。
- 山札は各色24枚: ななめ線×8、V字線×8、十字線×4、丸のみ×4。
- 置く前の回転は自由。
- 一度得点した線も、別の多角形の辺として再利用できる。
- 1枚の配置で複数のサーキットが同時に完成することもある(大きな多角形を分割した場合など)。
- 両者が全カードを置き切ったら終了。合計点の多い方が勝ち。

### 操作

手札のカードをタップで選択、もう一度タップ(または回転ボタン、Rキー)で回転、光っているマスをタップで配置します。PCではマスにカーソルを乗せると配置プレビューが表示されます。

### 実装メモ

- 回路検出は、置かれた全ての線が作るグラフに対する平面グラフの面列挙(角度ソートによる半辺トレース)で行っています。同時完成や入れ子のサーキットも正しく処理されます。
- CPUは手札全カードの全配置候補を評価します。Union-Findによる事前判定で回路が閉じ得る手だけを厳密計算し、上位候補については相手の最善応手を差し引き、自分の次手の脅し(防ぎきれない二重の脅しを含む)を加点する両面評価を行います。
- フレームワークも外部アセットも使わない、単一HTMLファイル構成です。

### GitHub Pagesでの公開

[Neurons Board Game](https://eijwat.github.io/neurons_boardgame/)


---

Game design: Eiji Watanabe / Implementation: Claude Fable5 (Anthropic) / All Rights Reserved 2026-
