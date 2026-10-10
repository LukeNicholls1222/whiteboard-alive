# OpenCV.js 調査メモ（2026-10-10）

**要点3行**
1. 公式ビルド `https://docs.opencv.org/4.13.0/opencv.js`（10.96MB、wasm を base64 で内蔵した1ファイル、gzip後 約3.5MB）を `public/opencv.js` に置いて `<script>` で読むのが一番確実。npm 版（@techstark/opencv-js）は最新が 5.0.0 系で、Vite でのバンドルが重くなるので使わない。
2. **`await cv` は使わない（無限ループで固まる）。** 4.13.0 の公式ビルドの `cv` は Promise ではなく「`then` を持つ Module オブジェクト」で、`await` すると自分自身を返し続けて固まる（Node で実測）。`onRuntimeInitialized` を自前の Promise で包み、`cv.Mat` の有無で完了を判定する。
3. 必要な関数（adaptiveThreshold / morphologyEx / findContours / approxPolyDP / convexHull / distanceTransform / connectedComponentsWithStats / approxPolyN / inpaint）はすべて入っている。**ximgproc の thinning（細線化）は入っていない**（contrib モジュールは公式ビルド対象外）。

---

## 1. 読み込み方法の比較

| 方法 | 版 | サイズ | 評価 |
|---|---|---|---|
| `docs.opencv.org/4.13.0/opencv.js` を落として `public/opencv.js` に置く | 4.13.0（2025-12-31 リリース） | 10,964,323 B / gzip 3,542,519 B | **推奨**。1ファイル完結（wasm 内蔵）、版が固定、GitHub Pages から gzip 配信される |
| `docs.opencv.org/4.x/opencv.js` を直接参照 | 4.x → 4.13.0 へ 301 リダイレクト | 同上 | 版が勝手に変わる。外部 CDN 依存。避ける |
| `docs.opencv.org/5.x/opencv.js` | 5.x | 16,210,809 B | 大きい。5.0 は API 差分もあり今回は不要 |
| `@techstark/opencv-js`（npm） | latest = 5.0.0-release.1 | 5.x 相当 | webpack 用に fs/path/crypto の polyfill 設定が要る旨の README 記載。Vite の依存事前バンドルで 10MB 超を処理させることになり遅い・壊れやすい |

確認した事実:
- `https://docs.opencv.org/4.12.0/opencv.js`、`4.14.0`、`5.0.0` は 404（版番号ディレクトリが無いものがある）。`4.13.0`、`4.9.0`(10.26MB)、`4.8.0`(9.99MB) は 200。
- GitHub Pages は `.js` を `content-encoding: gzip`、`cache-control: max-age=600` で返す（pages.github.com で確認）。つまり転送は約3.5MB。
- docs.opencv.org 自体は brotli 配信。

置き方（ダウンロードは1回だけ。リポジトリにコミットしてよい。11MB なので GitHub の 100MB 制限には余裕）:

```bash
curl -L https://docs.opencv.org/4.13.0/opencv.js -o public/opencv.js
```

`index.html` で非同期に読む（Vite は public/ をそのままコピーする。`base` が `/whiteboard-alive/` の場合は `import.meta.env.BASE_URL` を付ける）:

```ts
// src/cv.ts
declare const cv: any; // 型は any で割り切る（@types は古い/不完全）

let ready: Promise<void> | null = null;

export function loadOpenCV(): Promise<void> {
  if (ready) return ready;
  ready = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = import.meta.env.BASE_URL + 'opencv.js';
    s.async = true;
    s.onerror = () => reject(new Error('opencv.js load failed'));
    s.onload = () => {
      const g = (window as any).cv;
      // 既に初期化済み（cv.Mat がある）ならすぐ resolve
      if (g && g.Mat) return resolve();
      // ★ resolve(g) としない。g は thenable なので Promise が無限に追いかける
      g.onRuntimeInitialized = () => resolve();
    };
    document.head.appendChild(s);
  });
  return ready;
}
```

- アプリ起動直後に `loadOpenCV()` を呼んでおき、ユーザーが撮影している間に初期化を終わらせる（「輪郭を検出」段階で待たせない）。
- `cv` を値として受け渡さない。使う側はグローバル `cv` を直接使う。

## 2. 初期化完了の待ち方（4.x で cv が Promise になる件）

4.13.0 公式ビルドの末尾（実ファイルから抜粋）:

```js
Module["then"]=function(func){if(calledRun){func(Module)}else{var old=Module["onRuntimeInitialized"];Module["onRuntimeInitialized"]=function(){if(old)old();func(Module)}}return Module};
...
  return cv(Module);   // ← Promise ではなく Module オブジェクトを返す
```

- `typeof cv === 'object'`、`cv instanceof Promise === false`、`typeof cv.then === 'function'`（Node で確認）。
- `then` が `Module` 自身（thenable）を渡すので、`await cv` / `Promise.resolve(cv).then(...)` は「thenable を解決 → また thenable」の無限マイクロタスクになりタブが固まる。Node で `onRuntimeInitialized` 後に `await cv` すると 8秒経っても戻らず、タイマーも発火しなかった（＝メインスレッドが止まる）。
- 「4.x で cv が Promise になる」という話は、新しい Emscripten の MODULARIZE ビルド（一部の npm 版や自前ビルド）の話。公式 4.13.0 の配布物には当てはまらない。どちらにも対応したいなら:

```ts
const g = (window as any).cv;
if (g instanceof Promise) { (window as any).cv = await g; }       // 本物の Promise 版
else if (!g.Mat) { await new Promise<void>(r => (g.onRuntimeInitialized = () => r())); }
```

（@techstark の README のサンプルもこの形: Promise なら await、そうでなければ `Mat` を見て `onRuntimeInitialized` を待つ）

## 3. 初期化時間の目安

- 実測（M 系 Mac・Node 24）: require から `onRuntimeInitialized` まで **136ms**。
- スマホの公式な数値は見つからなかった（**未確認**）。wasm が base64 内蔵なので「JS 11MB のパース → base64 デコード 8MB → wasm コンパイル」が全部メインスレッド寄りで走る。経験則として最近の iPhone/Android で 1〜3秒、古い Android で 5秒超もありうる。本番 URL で `performance.now()` を測ってログに出すこと。
- 転送は gzip 3.5MB。会場 Wi-Fi が遅いと数秒〜十数秒かかりうる → 起動直後に読み込み開始、進捗表示に「画像処理エンジン準備中」を出す。

## 4. 処理パイプライン（JS での書き方）

下のコードは Node で 4.13.0 を使って実際に動かした形を元にしている（円＋線の画像で contours 1、approxPolyDP 9点、hull 31点、distanceTransform は CV_32F で返ることを確認）。

```ts
declare const cv: any;

export type Contour = { id: number; points: [number, number][]; area: number; hull: [number, number][]; strokeWidth: number };

export function extractContours(canvas: HTMLCanvasElement): Contour[] {
  const mats: any[] = [];                  // delete 漏れ対策: 作ったら全部ここに積む
  const track = <T>(m: T): T => (mats.push(m), m);
  try {
    const src  = track(cv.imread(canvas)); // RGBA (CV_8UC4)
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

    // 影・ムラに強い二値化。blockSize は奇数。画像の短辺の 1/20 前後が目安
    const bin = track(new cv.Mat());
    cv.adaptiveThreshold(gray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 31, 10);

    // 途切れた線をつなぐ（CLOSE = 膨張→収縮）。ゴマ塩ノイズは OPEN で消す
    const k = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
    cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, k, new cv.Point(-1, -1), 2);

    // 線の太さ推定用（距離変換の最大値×2 ≒ 線幅）
    const dist = track(new cv.Mat());
    cv.distanceTransform(bin, dist, cv.DIST_L2, 3);     // 出力は CV_32F

    const contours = track(new cv.MatVector());
    const hier = track(new cv.Mat());
    cv.findContours(bin, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const out: Contour[] = [];
    const minArea = (bin.rows * bin.cols) * 0.0005;      // 小さい輪郭を捨てる
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);                          // get() で取った Mat も delete が要る
      try {
        const area = cv.contourArea(c);
        if (area < minArea) continue;
        const approx = new cv.Mat();
        const hull = new cv.Mat();
        try {
          cv.approxPolyDP(c, approx, 0.01 * cv.arcLength(c, true), true); // Douglas-Peucker
          cv.convexHull(c, hull, false, true);                            // returnPoints=true
          // 輪郭内の線幅: マスクを作って dist の最大値
          const mask = cv.Mat.zeros(bin.rows, bin.cols, cv.CV_8UC1);
          const one = new cv.MatVector(); one.push_back(c);
          cv.drawContours(mask, one, 0, new cv.Scalar(255), -1);
          const mm = cv.minMaxLoc(dist, mask);
          mask.delete(); one.delete();
          out.push({
            id: out.length,
            points: toPts(approx),
            hull: toPts(hull),
            area,
            strokeWidth: mm.maxVal * 2,
          });
        } finally { approx.delete(); hull.delete(); }
      } finally { c.delete(); }
    }
    return out;
  } finally {
    for (const m of mats) m.delete();
  }
}

function toPts(m: any): [number, number][] {
  const d = m.data32S;                      // findContours 系の点は CV_32SC2
  const r: [number, number][] = [];
  for (let i = 0; i < d.length; i += 2) r.push([d[i], d[i + 1]]);
  return r;
}
```

パラメータの目安:
- 入力はまず長辺 1024〜1280px に縮小（`cv.resize`）。スマホ写真 4000px のままだと adaptiveThreshold が重く、メモリも食う。
- `RETR_EXTERNAL` は外側だけ。振り子の丸の中を塗っていない場合は外枠1本になるので扱いやすい。四角の中に別の図があるケースが出たら `RETR_CCOMP` に切り替えて hierarchy を見る。
- 線（ひも・ばね）は細長い輪郭になる。`cv.minAreaRect` の縦横比、`area / arcLength` が小さいことで「線」と判定できる。
- 途切れ対策の追加手段: `cv.connectedComponentsWithStats` で小さいブロブを捨てる、端点同士が近いものを `cv.line` で描き足してから再度 findContours。

## 5. Mat の delete 漏れ対策

- OpenCV.js の Mat は wasm ヒープ上にあり GC されない。`new cv.Mat()`、`cv.imread`、`cv.matFromImageData`、`MatVector`、`contours.get(i)` の戻り値、`cv.getStructuringElement` の戻り値は全部 `delete()` が要る。`cv.Size` / `cv.Point` / `cv.Scalar` は普通の JS 値なので不要。
- 上のように「配列に積んで finally で全部 delete」が一番簡単で漏れない。
- 4.13.0 は `cv.Mat.prototype[Symbol.dispose] = delete` を定義している（実ファイルで確認）。TS 5.2+ の `using m = new cv.Mat()` が使えるが、Safari の対応状況が読めないので TS の `target` を ES2022 にして変換させるか、素直に try/finally を使う。
- 漏れの検査: 処理の前後で `cv.HEAPU8.length` やタスクマネージャのメモリを見る。数回撮り直してメモリが増え続けるなら漏れ。

## 6. デフォルトビルドに入っているもの

公式の `platforms/js/opencv_js.config.py`（4.13.0）と、配布ファイル内の wasm の関数名・実行時の `typeof cv.xxx` で確認:

| 関数 | 有無 |
|---|---|
| adaptiveThreshold, morphologyEx, getStructuringElement, findContours, approxPolyDP, approxPolyN, convexHull, convexityDefects, distanceTransform, connectedComponentsWithStats, contourArea, arcLength, minAreaRect, fitLine, HoughLinesP, HoughCircles, minEnclosingCircle, pointPolygonTest, drawContours, fillPoly | ある |
| `cv.inpaint`（photo モジュール） | **ある** |
| `cv.ximgproc_thinning` / `cv.thinning`（ximgproc, contrib） | **ない**（`undefined`） |
| `fastNlMeansDenoising` | ない |

細線化（ひもを1本の中心線にしたい場合）が必要なら、Zhang-Suen を TypeScript で書く（二値画像に対して数十行。1024px で数十ms）か、`distanceTransform` の尾根を使う。contrib 込みで自前ビルドは時間の無駄なのでやらない。

## 出典

- OpenCV.js 使い方チュートリアル: https://docs.opencv.org/4.x/d0/d84/tutorial_js_usage.html （WebFetch は 403。内容は配布ファイルで直接確認）
- 配布ファイル: https://docs.opencv.org/4.13.0/opencv.js 、https://docs.opencv.org/5.x/opencv.js （curl でサイズ・中身を確認）
- ビルド対象関数の一覧: https://github.com/opencv/opencv/blob/4.13.0/platforms/js/opencv_js.config.py
- リリース一覧: https://github.com/opencv/opencv/releases （4.14.0: 2026-07-19、5.0.0: 2026-06-06、4.13.0: 2025-12-31）
- @techstark/opencv-js: https://github.com/TechStark/opencv-js 、https://www.npmjs.com/package/@techstark/opencv-js
- 輪郭チュートリアル（JS）: https://docs.opencv.org/4.x/d5/daa/tutorial_js_contours_begin.html
- wasm キャッシュ・圧縮の一般論（ベンダー記事、参考程度）: https://docs.scanbot.io/faq/common_web_integration_issues/
