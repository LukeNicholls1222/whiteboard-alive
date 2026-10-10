# Matter.js 調査メモ（2026-10-10）

**要点3行**
1. 入っているのは matter-js **0.20.0**（npm の最新。2024-06 以降リリースなし）と @types/matter-js 0.20.2、poly-decomp 0.3.0。0.20 の `Runner` は**最初から固定ステップ**（`delta: 1000/60`）。`Engine.update` に 16.67ms より大きい delta を渡すと警告が出る。自前ループなら「固定 1000/60 を必要回数まわす」。
2. 振り子・ばねは `Constraint`（`pointA` に世界座標の支点、`bodyB` におもり）で作れる。**滑車は Constraint だけでは動かない**（各ロープが体ごとに独立に補正され、質量差が効かない。Node で実測して止まったまま）。解析解の張力 `T = 2·m1·m2·g/(m1+m2)` を力として与え、`beforeSolve` でロープ長の合計を一定に保つ方式が動いた。
3. 手描き画像は **自前 Canvas 描画**で貼る。`render.sprite` は、凹形状で複合ボディ（parts が2つ以上）になると親の sprite が描かれない／オフセットの合わせが面倒。`body.position` と `body.angle` を毎フレーム読んで `ctx.translate/rotate/drawImage` するのが確実。

---

## 1. 読み込み（Vite + TypeScript）

```ts
import Matter from 'matter-js';          // UMD/CommonJS だが Vite の依存事前バンドルで default import できる
import decomp from 'poly-decomp';         // CommonJS（main: ./src/index.js）

const { Engine, Bodies, Body, Composite, Constraint, Events, Common, Vertices } = Matter;
Common.setDecomp(decomp);                 // fromVertices の凹形状分解を有効化。起動時に1回
```

poly-decomp には型が無いので `src/types/poly-decomp.d.ts` に1行:

```ts
declare module 'poly-decomp';
```

- `Common.setDecomp` が無いと、凹形状は**黙って凸包に置き換わる**（警告1回のみ）。`Bodies.fromVertices` のソースで確認。
- @types/matter-js 0.20.2 には `Common.setDecomp` と `Events.on(engine, 'beforeSolve', ...)` の型がある。

## 2. 振り子・ばね・滑車

Constraint の既定値（`src/constraint/Constraint.js` を読んで確認）:
- `length` を省略すると、作成時の2点間距離が長さになる。
- `stiffness = options.stiffness || (length > 0 ? 1 : 0.7)` → **`stiffness: 0` は指定できない（1 になる）**。ゆるくしたいなら 0.001 などの小さい正の値。
- `damping` 既定 0。`stiffness >= 1` か `length === 0` のときは「剛体（rigid）」扱いで位置を直接補正。1 未満はばねとして timeScale² で効く。
- 描画タイプ: length 0 かつ stiffness>0.1 → `pin`、stiffness<0.9 → `spring`、それ以外 → `line`。

固定定数（CLAUDE.md の方針「図の種類ごとに定数で固定」用の初期値）:

| 図 | stiffness | damping | 備考 |
|---|---|---|---|
| 振り子のひも | 1 | 0 | `frictionAir: 0` にしないと減衰して止まる |
| ばね | 0.002〜0.01 | 0.01〜0.05 | 小さいほど周期が長い。おもりの質量と合わせて調整 |
| 滑車のロープ | 1 | 0 | 下記の特殊処理 |
| ピン（回転軸） | 1、length 0 | 0 | |

### 振り子

```ts
const pivot = { x: px, y: py };                 // OpenCV で取った「点」の座標
const bob = Bodies.circle(bx, by, r, { frictionAir: 0, friction: 0, restitution: 0 });
const rope = Constraint.create({
  pointA: pivot,          // bodyA を省略 → pointA は世界座標の固定点
  bodyB: bob,             // pointB 省略 → おもりの重心
  stiffness: 1,
  damping: 0,
  // length 省略 → 描いた長さそのまま
});
Composite.add(engine.world, [bob, rope]);
// 描いた位置が真下なら揺れないので、初期角を少しずらすか初速を与える（「何も動かない」を作らない）
Body.setVelocity(bob, { x: 3, y: 0 });
```

### ばね

```ts
const anchor = { x: ax, y: ay };                // 天井側の端点
const mass = Bodies.rectangle(mx, my, w, h, { frictionAir: 0 });
const spring = Constraint.create({
  pointA: anchor, bodyB: mass,
  length: naturalLen,      // 描いた長さより短めにすると最初から伸びて振動を始める
  stiffness: 0.005,
  damping: 0.02,
});
```

横置き（床の上でばね＋箱）なら、箱を床に置き `bodyA` を壁（static body）にする。

### 滑車（アトウッドの機械）— 実測で動いた方式

Constraint だけで「ロープ長の合計が一定」を作ろうとすると動かない（Node で試して、質量 2:1 でも 1 秒間まったく動かなかった）。理由: 各ロープは別々の Constraint で、それぞれ自分のおもりを元の長さへ完全に引き戻すため、質量比が効かない。

動いた方式（Node で 質量2:1、1秒で重い方が 140px 下降・軽い方が 140px 上昇、ロープ長合計は 400.0 のまま）:

```ts
const pA = { x: cx - r, y: cy }, pB = { x: cx + r, y: cy };   // 滑車の左右の接点
const a = Bodies.rectangle(...), b = Bodies.rectangle(...);
const total = dist(pA, a.position) + dist(pB, b.position);    // ロープの全長（描いた長さ）
const cA = Constraint.create({ pointA: pA, bodyB: a, stiffness: 1 });
const cB = Constraint.create({ pointA: pB, bodyB: b, stiffness: 1 });
Composite.add(engine.world, [a, b, cA, cB]);

// 1) 張力を力で与える（解析解）。Matter の重力加速度 = gravity.y * gravity.scale
Events.on(engine, 'beforeUpdate', () => {
  const g = engine.gravity.y * engine.gravity.scale;
  const T = 2 * a.mass * b.mass * g / (a.mass + b.mass);
  Body.applyForce(a, a.position, { x: 0, y: -T });
  Body.applyForce(b, b.position, { x: 0, y: -T });
});
// 2) 積分の後・拘束の前に、合計長を保ったまま左右の長さを配り直す（ズレ補正だけ）
Events.on(engine, 'beforeSolve', () => {
  const d = dist(pA, a.position) - dist(pB, b.position);
  cA.length = (total + d) / 2;
  cB.length = (total - d) / 2;
});
```

- `beforeSolve` は 0.20 で追加されたイベント（CHANGELOG「added engine beforeSolve event」）。`beforeUpdate` で長さを配ると、積分前の長さに引き戻されて動かない。
- 片方が滑車に当たる／床に着いたら止める処理（長さの下限）を入れる。Constraint は押す方向にも効く（ロープではなく棒）ので、たるみは表現できない。
- 1秒の移動量は理論値 167px に対し 140px（Verlet の立ち上がり分）。見た目には問題ない。
- 保険: これが不安定なら、2物体を `isStatic` にして a = g(m1−m2)/(m1+m2) で位置を自前計算して `Body.setPosition` する（物理エンジンを使わない「確実に動く」版）。

## 3. Bodies.fromVertices と poly-decomp

```ts
// OpenCV の approxPolyDP / convexHull の点（[x,y][]）を {x,y}[] に
const verts = pts.map(([x, y]) => ({ x, y }));
const body = Bodies.fromVertices(cx, cy, [verts], { friction: 0.3 },
  /*flagInternal*/ false, /*removeCollinear*/ 0.01, /*minimumArea*/ 10, /*removeDuplicatePoints*/ 0.01);
```

ソースを読んで分かった注意点:
- 渡した頂点は**重心まわりに並べ直され、`body.position` は重心になる**。描いた位置に置くには、元の頂点の重心（`Vertices.centre(verts)`）を x, y に渡す。ズレが出たら `body.bounds` と元の bounds の差で補正。
- 凸なら1パーツ、凹なら poly-decomp の `quickDecomp` で分割され**複合ボディ**（`body.parts[0]` が親、`parts[1..]` が子）になる。L 字で 2 パーツになることを確認。
- 自己交差・極端に細い形・尖った点は分解に失敗しやすい（公式 doc コメントにも記載）。手描きの輪郭は**凸包（convexHull）を基本**にする方が安定。斜面の三角・箱は凸包で十分。凹形状が要るのは大砲くらい。
- 分解結果のパーツに隙間ができることがある（doc コメント）。

## 4. 手描き画像を剛体に貼る

### 推奨: 自前 Canvas 描画

```ts
// 前処理: 元写真から各輪郭のバウンディングボックスを切り抜き、背景を透明にした canvas を作る
//   （OpenCV のマスク → ImageData のアルファに入れる）
type Sprite = { img: HTMLCanvasElement; offX: number; offY: number }; // 重心から切り抜き左上までのずれ
const sprites = new Map<number, Sprite>();          // key = body.id

function draw(ctx: CanvasRenderingContext2D) {
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(staticBackground, 0, 0);            // 動かない線（地面・斜面・天井）は元画像のまま
  for (const body of Composite.allBodies(engine.world)) {
    const s = sprites.get(body.id);
    if (!s) continue;
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    ctx.drawImage(s.img, s.offX, s.offY);
    ctx.restore();
  }
  // ひも・ばねは Constraint の両端を毎フレーム結んで描く（元のひもの絵は「伸び縮み」できないため）
}
```

- offX/offY は「作成時の body.position（重心）から見た、切り抜き左上の位置」= `bbox.x - body.position.x`。作成時に一度だけ計算する。
- 複合ボディでも親の `position/angle` で1枚描くだけで済む。
- ひもは線分、ばねはジグザグを両端から生成して描くと伸縮が自然。

### render.sprite を使う場合の注意（使わない理由）

- `Render.bodies` は `parts.length > 1` のとき親（parts[0]）を飛ばして子パーツだけ描く → 凹形状で分解された物体は親の sprite が出ない。
- `sprite.texture` は画像の URL（dataURL 可）。`xOffset/yOffset` は 0〜1 の比率で、fromVertices の重心ずれに合わせる計算が必要。
- `Matter.Render` 自体がデバッグ用途寄りで、スライダーやグラフと同じ Canvas に重ねにくい。

## 5. 固定ステップと安定性（0.19 → 0.20 の違い）

0.20.0 の `Runner.create` 既定値（ソースで確認）:

```js
delta: 1000 / 60,           // 1回の Engine.update の固定ステップ
frameDeltaSmoothing: true,  // 画面のフレーム間隔を平滑化
frameDeltaSnapping: true,   // 1Hz 単位に丸める
maxUpdates: null,           // 1フレームで回す最大回数（自動）
maxFrameTime: 1000 / 30,    // 1フレームで物理に使う時間の上限
enabled: true
```

- 0.20 の Runner は「画面のフレーム時間をためて、固定 delta を必要回数まわす」方式（CHANGELOG「added new Matter.Runner with default fixed timestep」）。120Hz の iPhone でも 60Hz の Android でも同じ速さで動く。0.19 までは `isFixed` オプションで切り替えていたが、0.20 で例から削除。
- 0.19 で「delta 依存をなくす」改修（`body.deltaTime` 追加、拘束の stiffness の delta 補正）が入った。0.18 以前の記事のパラメータは効き方が違うことがある。
- `Engine.update(engine, delta)` に `1000/60` より大きい値を渡すと警告（`Engine._deltaMax = 1000/60`）。タブ復帰時の大きな dt をそのまま渡さない。

自前ループ（Render も Runner も使わず、グラフ・スライダーと同じ requestAnimationFrame で回す）推奨形:

```ts
const STEP = 1000 / 60;
let acc = 0, last = performance.now();
function frame(now: number) {
  acc += Math.min(now - last, 100);   // タブ復帰時の巨大 dt を捨てる
  last = now;
  let n = 0;
  while (acc >= STEP && n < 5) { Engine.update(engine, STEP); acc -= STEP; n++; }
  if (n === 5) acc = 0;               // 追いつけないときは諦める（スパイラル防止）
  draw(ctx);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

安定性の小技:
- 速い物体（投射）が地面をすり抜けるなら、地面を厚く（50px 以上）するか、`Engine.update` を 1/120 で2回まわす（サブステップ。0.20 の Example.substep が同じ考え）。
- 拘束がビヨンビヨンするなら `engine.constraintIterations`（既定 2）を 4〜6 に。`positionIterations` 既定 6、`velocityIterations` 既定 4。
- 振り子が減衰するのは `frictionAir`（既定 0.01）。0 にする。
- 斜面の摩擦: `friction`（動摩擦、既定 0.1）と `frictionStatic`（既定 0.5）を物体と斜面の両方に設定。実際は2物体の値の組み合わせで決まる。
- `enableSleeping` は使わない（止まった物体が二度と動かなくなり「何も動かない」になる）。
- 重力: `engine.gravity.y = 1`、`engine.gravity.scale = 0.001`（既定）。月モードは `gravity.y = 1/6`。物理単位との換算（px/m）は定数で決めておく。

## 出典

- matter-js リポジトリ: https://github.com/liabru/matter-js
- CHANGELOG（0.19 / 0.20 の変更点）: https://github.com/liabru/matter-js/blob/master/CHANGELOG.md
- ソース（node_modules/matter-js/src 0.20.0 を直接読んだ）: `core/Runner.js`、`core/Engine.js`、`constraint/Constraint.js`、`factory/Bodies.js`（fromVertices）、`core/Common.js`（setDecomp）、`render/Render.js`（sprite 描画）
- API ドキュメント: https://brm.io/matter-js/docs/classes/Constraint.html 、https://brm.io/matter-js/docs/classes/Bodies.html#method_fromVertices 、https://brm.io/matter-js/docs/classes/Runner.html
- npm: https://www.npmjs.com/package/matter-js （latest 0.20.0, 2024-06-23）、https://www.npmjs.com/package/poly-decomp （0.3.0）
- poly-decomp: https://github.com/schteppe/poly-decomp.js
- 滑車の検証は scratchpad の Node スクリプトで実施（リポジトリには入れていない）
