# publish-pr-html

生成済みのHTMLをGitにコミットせず、GitHub Actionsの非ZIP artifactとして公開し、Pull Requestの専用コメントにリンクを貼るツールです。
他のリポジトリから再利用する前提で、composite actionとCLIの二つで構成しています。

```text
publish-pr-html CLI
  ├─ 小容量: workflow_dispatch の inputs にHTMLを直接格納
  └─ 大容量: 専用 draft release に asset を置き、dispatch には asset ID を渡す
                    ↓
対象リポジトリの workflow (uses: stanah/publish-pr-html@<sha>)
  検証 → 非ZIP artifact → PRコメント作成・更新 → 中継 asset 削除
```

PRコメントのリンクは、GitHubにログインしたブラウザで開くとHTMLをそのまま表示します。
ZIPの展開は不要です。
設計の根拠と状態遷移の詳細は [docs/design.md](docs/design.md) にあります。

## 前提条件

- GitHub.com のリポジトリであること。
- 公開を要求する人が、対象リポジトリに対して workflow の dispatch と PR の読み取りができること。
- CLI を動かす環境に Node.js 20 以上があること。
- 認証は `GITHUB_TOKEN`、`GH_TOKEN`、または `gh auth login` 済みの `gh` のいずれかで行うこと。
- HTML は UTF-8 の単一ファイルで、CSS や画像を自己完結させていること。

## 対象リポジトリへの導入

導入は三段階です。
workflow の追加、中継用 draft release の作成、そして action の参照許可の確認です。

### 1. workflow をデフォルトブランチに追加する

[templates/publish-pr-html.yml](templates/publish-pr-html.yml) を対象リポジトリの `.github/workflows/publish-pr-html.yml` にコピーします。
`<PINNED_SHA>` は、レビュー済みのこのリポジトリのコミット SHA に置き換えます。
中継 asset の清掃用に [templates/cleanup-pr-html.yml](templates/cleanup-pr-html.yml) も同様にコピーします。

workflow_dispatch はデフォルトブランチ上の workflow に対して送るため、両方ともデフォルトブランチへマージしておく必要があります。

### 2. 中継用 draft release と変数を作る

大容量の HTML を渡すための draft release を一度だけ作り、その ID をリポジトリ変数 `PR_HTML_RELEASE_ID` に登録します。
CLI の `setup` がまとめて行います。

```bash
npx --yes github:stanah/publish-pr-html setup --repo OWNER/REPO
```

release は draft のまま維持します。
公開状態に変えると、action は中継として使うことを拒否します。
リポジトリ変数を API から設定できない権限の場合、`setup` は release ID を表示して終わるので、リポジトリ設定から手動で登録します。

### 3. action の参照を許可する

このリポジトリが private の間は、同じオーナー配下のリポジトリからだけ `uses:` で参照できます。
このリポジトリの Settings から Actions の Access を「Accessible from repositories owned by the user」に設定してください。
public にした場合、この設定は不要です。

## CLI の使い方

```bash
npx --yes github:stanah/publish-pr-html \
  --repo OWNER/REPO \
  --pr 123 \
  --head-sha <HTMLが説明対象としたコミットの完全なSHA> \
  --file explanation.html
```

`--head-sha` には、HTML を生成したときに説明対象としたコミットを渡します。
CLI は PR が open で head がその SHA に一致することを確認してから送信します。
PR が先に進んでいた場合は送信せずに終了するので、HTML を作り直すか、対応する SHA を指定し直します。

CLI は既定で run の完了を待ち、PR コメントの隠しメタデータに自分の request ID が書かれたことを確認して成功と報告します。
dispatch が受理されただけでは成功とみなしません。

| 終了コード | 意味 |
|---|---|
| 0 | 公開が完了し、コメントにリンクが入った |
| 2 | run は成功したが、この要求は公開されなかった（PR の head 移動、PR の close、より新しい公開の存在） |
| 3 | run の出現または完了を待ち切れなかった |
| 1 | 入力の不備、API エラー、run の失敗 |

主なオプションは次のとおりです。

- `--no-wait`：dispatch の受理で戻る。
- `--timeout SEC`：完了待ちの上限（既定 900 秒）。
- `--release-id ID`：中継 release の ID を明示する。既定は環境変数 `PR_HTML_RELEASE_ID`、次にリポジトリ変数。
- `--json`：結果を JSON で標準出力に出す。エージェントから呼ぶときに使う。

繰り返し使う場合は `npm install -g github:stanah/publish-pr-html` または `pnpm add -g github:stanah/publish-pr-html` で `publish-pr-html` コマンドとして入れられます。

## 動作の要点

**転送方式の判定**は、`{ref, inputs}` 全体を JSON にした UTF-8 のバイト数で行います。
60,000 バイト以下なら inputs に HTML を直接載せ、それを超えると draft release の asset に置いて asset ID だけを渡します。
GitHub の inputs 上限は 65,535 文字なので、エスケープや日本語を見込んだ保守的な値です。

**転送の完全性**は SHA-256 で確認します。
CLI が元ファイルのバイト列からハッシュを計算して送り、action は受け取った HTML のサイズ、UTF-8 としての妥当性、ハッシュを検証してから artifact にします。

**コメントの識別**は、マーカー `<!-- pr-html-explanation:v1 -->` と投稿者の user ID（既定は `github-actions[bot]`）の両方で行います。
本文には HTML のリンク、対象コミット、公開日時、保持期限、run のリンクを書き、隠しメタデータに request ID、head SHA、ハッシュ、run number を保存します。
PR の本文には触れません。

**巻き戻りの防止**は run number で行います。
同一 PR の run は concurrency group で直列化し、保存済みの run number より小さい run はコメントを更新しません。
同じ request ID の再実行は何もせずに成功します。

**失敗時の扱い**は次のとおりです。

| 状況 | 処理 |
|---|---|
| 検証、取得、artifact 化の失敗 | 公開失敗。既存コメントは維持し、中継 asset は清掃期限まで残る |
| artifact 成功、コメント更新失敗 | 公開失敗。artifact と中継 asset を残し、再実行できるようにする |
| コメント成功、asset 削除失敗 | 公開成功と清掃警告。リンクは戻さず、日次の清掃に委ねる |
| PR の head 移動、PR の close | skip。既存コメントを維持する |

清掃 workflow は、中継 release 配下で命名規則 `pr-html-{PR番号}-{SHA先頭12桁}-{request ID}.html` に一致し、asset の作成から 7 日を超えたものだけを削除します。

## 権限

| 主体 | 必要な権限 |
|---|---|
| CLI | PR の読み取り、workflow の dispatch（fine-grained token では Actions の write）、run の状態確認（Actions の read）。release 経路では Contents の write |
| publish workflow | `contents: write`（draft release の asset 取得と削除）、`pull-requests: write`（コメント作成と更新） |
| cleanup workflow | `contents: write` |

action は `run:` の式に入力を埋め込まず、HTML、dispatch の payload、トークンをログに出しません。
実行するコードはデフォルトブランチのものに限り、PR の head を checkout しません。
入力検証と HTML の安全化は別の問題であり、任意の HTML を誰でも投稿できるサービスとしては設計していません。

## 開発

CLI と action は Node.js の標準ライブラリだけで動き、実行時の依存パッケージはありません。
action の実行時にもパッケージのインストールは走りません。
開発用の設定は pnpm で管理しています。

```bash
pnpm install
pnpm test
```

このリポジトリ自身の `.github/workflows/` は、action をローカル参照（`uses: ./`）で使う動作確認用です。
他のリポジトリでは `templates/` のものを使ってください。

## 構成

- `action.yml`：公開用 composite action。
- `cleanup/action.yml`：中継 asset 清掃用 composite action。
- `bin/publish-pr-html.mjs`：CLI の入口。
- `src/lib/`：命名、検証、転送判定、コメント生成と判定の純粋関数。
- `src/action/`：action の各 step のスクリプト。
- `src/cli/`：CLI の publish と setup の流れ。
- `templates/`：対象リポジトリにコピーする workflow。
- `test/`：`node --test` によるテスト。
