# Gemini をブラウザから REST で呼ぶ調査メモ（2026-10-10）

**要点3行**
1. モデルは **`gemini-3.8-flash`**（Stable。公式の models ページで新規プロジェクトに推奨）。`gemini-2.5-flash` は「以前から使っていたユーザーのみ利用可」になっており、新しいキーでは使えない可能性が高い。予備は `gemini-3.6-flash`（Stable）。
2. 思考は `generationConfig.thinkingConfig.thinkingLevel` で絞る。3.8 Flash は **LOW / MEDIUM（既定）/ HIGH のみで、MINIMAL はエラー**。完全オフはできない。`thinkingBudget` と同時指定は不可、2.5 系に `thinkingLevel` を送るとエラー。→ 3.8 Flash なら `"LOW"`。
3. ブラウザ直叩きは動く: CORS プリフライトに `access-control-allow-origin` がオリジンそのままで返り、`x-goog-api-key` ヘッダーも許可されている（curl で確認）。HTTP リファラー制限は「**ブラウザは別オリジンへはオリジンだけを Referer に付ける**」ので、`https://<ユーザー名>.github.io/*` で登録する（`/whiteboard-alive/` のようなパス指定は通らない）。

---

## 1. モデル ID（2026-10 時点、ai.google.dev/gemini-api/docs/models より）

| ID | 状態 | 思考の段階 |
|---|---|---|
| `gemini-3.8-flash` | Stable / New（推奨） | low, medium(既定), high。minimal 不可 |
| `gemini-3.6-flash` | Stable | minimal, low, medium(既定), high |
| `gemini-3.5-flash-lite` | Stable（推奨の軽量版） | minimal(既定), low, medium, high |
| `gemini-3.1-flash-lite` | Stable | — |
| `gemini-3-flash-preview` | Preview | — |
| `gemini-3.5-flash` | 廃止。3.6 Flash に転送される | — |
| `gemini-2.5-flash` | 非推奨ではないが「過去ユーザーのみ」 | thinkingLevel 不可（thinkingBudget のみ） |
| `gemini-2.0-flash` | 終了 | — |

- 使う前に、自分のキーで使えるか一覧を取って確認するのが確実:
  `GET https://generativelanguage.googleapis.com/v1beta/models` （ヘッダー `x-goog-api-key`）
- 実装では model ID を定数1か所にまとめ、失敗（404/400）なら `gemini-3.6-flash` で再試行する。

## 2. fetch の書き方（SDK なし・generateContent）

フィールド名は v1beta のディスカバリ文書（`generativelanguage.googleapis.com/$discovery/rest?version=v1beta`）で確認した。REST の JSON は camelCase（`inlineData` / `mimeType`）。公式サンプルは snake_case（`inline_data` / `mime_type`）も使っており、どちらも受け付けられる。

```ts
const MODEL = 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export async function askGemini(imageBase64: string, contoursText: string, signal?: AbortSignal) {
  const body = {
    contents: [{
      role: 'user',
      parts: [
        {
          inlineData: { mimeType: 'image/jpeg', data: imageBase64 },     // "data:image/jpeg;base64," は外す
          mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },           // 画像ごとの解像度（Gemini 3 系）
        },
        { text: PROMPT + '\n\nCONTOURS:\n' + contoursText },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: DIAGRAM_SCHEMA,          // JSON Schema（下記）
      thinkingConfig: { thinkingLevel: 'LOW' },     // 3.8 Flash は MINIMAL 不可
      maxOutputTokens: 2048,                        // 小さすぎると思考で使い切って本文が切れる
      // temperature は付けない（Gemini 3 ガイドが「既定値を変えないこと」を強く推奨）
    },
  };

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': import.meta.env.VITE_GEMINI_API_KEY,   // URL の ?key= より、ログに残りにくいヘッダーで
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json = await res.json();
  // 思考の要約 part（thought: true）が混ざる場合に備えて text だけ拾う
  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .filter((p: any) => typeof p.text === 'string' && !p.thought)
    .map((p: any) => p.text).join('');
  return JSON.parse(text);   // 失敗したら fallback 図に回す
}
```

画像の base64 化（canvas から）:

```ts
const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
const imageBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
```

### JSON スキーマ（CLAUDE.md の基準形を JSON Schema にしたもの）

```ts
const DIAGRAM_SCHEMA = {
  type: 'object',
  properties: {
    diagram: { type: 'string', enum: ['pendulum', 'spring', 'incline', 'projectile', 'pulley', 'fallback'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    bodies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          contourId: { type: 'integer' },
          role: { type: 'string', enum: ['bob', 'mass', 'block', 'ground', 'incline', 'ceiling', 'pivot', 'rope', 'spring', 'pulley', 'cannon', 'arrow', 'ball', 'ignore'] },
          static: { type: 'boolean' },
          mass: { type: 'number' },
        },
        required: ['contourId', 'role', 'static'],
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['rope', 'spring', 'pin'] },
          from: { type: 'integer' },
          to: { type: 'integer' },
        },
        required: ['type', 'from', 'to'],
      },
    },
    params: { type: 'object', properties: { gravity: { type: 'number' } } },
    explanation: { type: 'string' },
  },
  required: ['diagram', 'confidence', 'bodies', 'constraints', 'explanation'],
};
```

- 使えるキーワード（ディスカバリ文書の記載）: `$id $defs $ref $anchor type format title description enum items prefixItems minItems maxItems minimum maximum anyOf oneOf properties additionalProperties required`、加えて独自の `propertyOrdering`。これ以外は無視か拒否。深すぎる・大きすぎるスキーマは拒否されうる。
- role の enum は増やしすぎない。`ignore`（影・文字・汚れ）を用意しておくと誤認識を逃がせる。
- 返ってきた JSON は必ずアプリ側で検証する（存在しない contourId、from==to、bodies が空 → fallback）。構文は保証されるが値の妥当性は保証されない（公式の注意書き）。

### API の書き方が変わりつつある点（注意）

- ディスカバリ文書では `responseSchema`（OpenAPI 形式）と `_responseJsonSchema` に「**Deprecated. Use `response_format` instead.**」と付いている。新形式は:
  ```json
  "generationConfig": { "responseFormat": { "text": { "mimeType": "APPLICATION_JSON", "schema": { ... } } } }
  ```
- 公式ドキュメントの新しいページは Interactions API（`POST /v1beta/interactions`、snake_case の `response_format` / `generation_config.thinking_level`）で書かれているが、Gemini 3 ガイドに「GenerateContent API も引き続きサポート、設定は同じ」とある。
- **未確認**: 手元にキーが無いので、`responseMimeType + responseJsonSchema` と `responseFormat.text` のどちらが 3.8 Flash で通るかは実際に叩いていない。最初の1回で 400 が返ったら、もう片方に切り替える（エラー本文に不正なフィールド名が出る）。

## 3. 思考（thinking）の設定

```json
"thinkingConfig": { "thinkingLevel": "LOW" }
```

- enum（ディスカバリ文書）: `THINKING_LEVEL_UNSPECIFIED | MINIMAL | LOW | MEDIUM | HIGH`。「Gemini 3 以降向け。それより前のモデルで使うとエラー」。
- `thinkingBudget`（整数トークン数）は 2.5 系向け。`thinkingLevel` と同時指定は不可。
- `includeThoughts: true` で思考の要約が返るが、今回は不要（遅くなるだけ）。
- 公式の助言: 遅延とコストを下げたいときは `maxOutputTokens` を小さくするのではなく思考レベルを下げる（出力が途中で切れるため）。

## 4. レイテンシの目安

- 公式に秒数は書かれていない（**未確認**）。思考レベルは「low が遅延とコストを最小化」とだけある。
- 経験則の見込み: 画像1枚（1120 トークン）＋輪郭一覧＋短い JSON 出力、thinkingLevel LOW で 2〜6 秒程度。MEDIUM（既定）だとさらに数秒。**本番 URL で `performance.now()` を測って記録すること**。
- 画面が止まって見えないよう、送信中は「AIが理解中」を出し、10 秒で `AbortController` を切って fallback（または作例 JSON）に回す。

## 5. 推奨画像解像度

- Gemini 3 系の画像トークン（media resolution ページ）: low 280 / medium 560 / **high 1120（推奨・未指定時もこれ）** / ultra_high 2240（画像ごと指定のみ）。
- 従来方式の計算（image understanding ページ）: 384px 以下なら 258 トークン、それ以上は 768×768 タイル単位で 1 タイル 258 トークン。
- リクエスト全体は 20MB まで（inline の場合）。
- 送る画像は **長辺 1024〜1280px の JPEG（品質 0.8〜0.85）**。これ以上大きくしても high の上限で丸められ、アップロードが遅くなるだけ。OpenCV に渡す画像と**同じ画素座標系**にしておく（輪郭座標と画像の位置を AI が対応付けやすい）。
- 精度を上げる小技: 送る画像に、各輪郭を色付きで描き、重心に輪郭 id の番号を書き込んだ「注釈付き画像」を送る（id と形の対応を AI が取り違えにくくなる）。座標の一覧は id・重心・外接矩形・頂点数・面積程度に絞り、生の全頂点は送らない（トークン節約）。
- 参考: Gemini が自分で座標を出すときは `[ymin, xmin, ymax, xmax]` を 0〜1000 に正規化した形式。今回は AI に座標を出させない方針なので使わない。

## 6. HTTP リファラー制限付き API キーと CORS

### CORS（curl で確認済み）

```
OPTIONS /v1beta/models/gemini-3.8-flash:generateContent
Origin: https://example.github.io
Access-Control-Request-Headers: content-type,x-goog-api-key
→ HTTP/2 200
  access-control-allow-origin: https://example.github.io
  access-control-allow-methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
  access-control-allow-headers: content-type,x-goog-api-key
  access-control-max-age: 3600
```

→ GitHub Pages からの fetch は CORS で弾かれない。

### リファラー制限の登録（Google Cloud の API キーのドキュメント）

- ワイルドカードはサブドメインかパスにだけ使える。`*.example.com` は可、URL の途中の `*` は不可。
- 「ブラウザによっては、別オリジンへのリクエストにはオリジンだけを送るリファラーポリシーを使う。そういうユーザーはページ単位の URL 制限付きキーを使えない」。今の主要ブラウザの既定（strict-origin-when-cross-origin）がまさにこれ。
- 登録する値:
  - `https://<GitHubユーザー名>.github.io/*`（本番）
  - 開発中だけ `http://localhost:5173/*`（イベント後に消す）
- `https://<ユーザー名>.github.io/whiteboard-alive/*` だけだと、Referer は `https://<ユーザー名>.github.io/` しか届かないので**弾かれる**。
- ページ側で `<meta name="referrer" content="no-referrer">` などを入れないこと（Referer が消えて全部弾かれる）。
- アプリケーション制限は1種類しか付けられない（リファラーにする）。

### API 制限も必須

- **2026-06-19 以降、Gemini API は「制限の無い API キー」からのリクエストを受け付けない**（Google の告知）。API 制限で「Generative Language API（generativelanguage.googleapis.com）」に限定すること。AI Studio で作ったキーは最初からこの制限付き。
- 403 が返ってプリフライトは通っている場合は、キーの制限（リファラー不一致・API 制限）を疑う。

### その他

- キーはビルドで JS に埋め込まれるので、見ようと思えば誰でも見える。リファラー制限は「他サイトから使われない」ための対策でしかない（curl で Referer を偽装すれば使える）。CLAUDE.md の方針どおりイベント後にキーを削除する。
- 無料枠のレート制限（RPM/RPD）は公式ページに数値が無く「AI Studio で確認」とある。デモ前に AI Studio の画面で 3.8 Flash の上限を確認しておく（**未確認**）。審査中に上限に当たったら作例 JSON に切り替える。

## 出典

- モデル一覧: https://ai.google.dev/gemini-api/docs/models
- 最新モデルの案内（3.8 Flash、thinking_level）: https://ai.google.dev/gemini-api/docs/latest-model
- Gemini 3 開発者ガイド（thinking_level、temperature、GenerateContent 継続サポート、3.5 Flash 廃止）: https://ai.google.dev/gemini-api/docs/interactions/gemini-3
- 思考の設定: https://ai.google.dev/gemini-api/docs/thinking
- 構造化出力: https://ai.google.dev/gemini-api/docs/structured-output
- 画像理解（20MB 制限、タイルとトークン、box_2d）: https://ai.google.dev/gemini-api/docs/image-understanding
- メディア解像度（トークン数）: https://ai.google.dev/gemini-api/docs/media-resolution
- generateContent API リファレンス: https://ai.google.dev/api/generate-content
- v1beta ディスカバリ文書（GenerationConfig / ThinkingConfig / Part / ResponseFormatConfig の正確なフィールド名）: https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta
- レート制限: https://ai.google.dev/gemini-api/docs/rate-limits
- API キーの制限（リファラーの書式と注意）: https://docs.cloud.google.com/docs/authentication/api-keys
- 制限なしキーの受付停止（2026-06-19）告知: https://discuss.ai.google.dev/t/action-required-restrict-gemini-api-keys-by-june-19-to-avoid-service-disruption/171786
