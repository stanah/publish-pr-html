# PR HTML解説の公開ワークフロー設計

2026-09-11 / コーディングエージェント向け実装仕様案

実装はこのリポジトリの `action.yml`、`cleanup/action.yml`、`bin/publish-pr-html.mjs` にあり、導入手順は [README](../README.md) にまとめている。

## 1. 採用方式と範囲

ローカル／エージェントが生成済みのHTMLを、GitへコミットせずActions artifactへ公開し、PRの専用コメントを更新する。

```text
publish-pr-html
  ├─ 小容量: workflow_dispatch.inputs にHTMLを直接格納
  └─ 大容量: 専用draft releaseへassetを置き、dispatchにはasset IDを格納
                    ↓
  共通workflow: 検証 → 非ZIP artifact → PRコメント更新 → 中継asset削除
```

GitHub.com、対象リポジトリへ公開要求を送れる共同作業者を対象とする。fork PRも、権限を持つ共同作業者がベース側リポジトリへ送信する。fork内のworkflowから権限を引き上げる仕組みは作らない。

HTML生成、PR本文の編集、外部ホスティング、専用ブランチ、gzip/Base64転送は対象外。入力はUTF-8の単一HTMLとし、CSS・画像等は自己完結させる。主要な説明はJavaScriptなしでも読めるものとする。

## 2. CLI・転送仕様

```sh
publish-pr-html --repo OWNER/REPO --pr 123 --head-sha FULL_SHA --file explanation.html
```

`head-sha` は**HTML生成時に説明対象としたコミット**を呼び出し元が指定する。送信時の最新SHAで置き換えない。CLIはPRがopenでheadが一致することを確認し、ファイルの元バイト列からSHA-256を算出する。

### dispatch入力

すべて文字列。`html` / `asset_id` は条件付き必須とし、両方指定は拒否する。

| 入力 | 値 |
|---|---|
| `pr_number` | 正の整数文字列 |
| `head_sha` | 完全なコミットSHA |
| `request_id` | CLIが要求ごとに生成するUUID |
| `html_sha256` | 元ファイルのSHA-256、64桁の小文字hex |
| `transport` | `inline` または `release` |
| `html` | inline時のみ。改行を含め原文を保持 |
| `asset_id` | release時のみ。正の整数文字列 |

**転送判定:** `{ref, inputs}` 全体をJSON化したUTF-8バイト数が60,000以下ならinline、それ以外はrelease。GitHubのinputs上限は65,535文字であり、60,000バイトはエスケープや日本語を考慮した保守的な設計値。ファイルサイズだけで判定しない。[^workflow]

JSONは標準入力経由で送信し、HTMLをシェルコマンドへ展開しない。`ref` は対象リポジトリのデフォルトブランチに固定する。workflowは事前に同ブランチへ導入する。[^workflow]

### release経路

初回に既存コミットを対象とする専用draft releaseを作り、そのIDをCLI設定とリポジトリ変数 `PR_HTML_RELEASE_ID` に設定する。通常の製品Releaseを流用せず、公開状態へ変更しない。取得・削除はRelease asset APIを使う。[^release]

asset名は `pr-html-{pr_number}-{head_sha先頭12桁}-{request_id}.html`。同名上書きは禁止。アップロード後に得たasset IDでdispatchし、ダウンロードURL・任意のrelease ID・保存パスは入力として受け付けない。

**初期設定値:** HTML上限10 MiB、artifact保持30日、中継assetの清掃期限7日。GitHub側の制限ではなく、本システムの設定値とする。artifact保持期間は導入先の上限内に設定する。

## 3. 公開workflow

`.github/workflows/publish-pr-html.yml` に実装する。`run-name` にPR番号と `request_id` を含める。CLIがrunを検索する場合はrequest IDで照合し、「最新のrun」を採用しない。dispatch受付を公開完了として報告しない。

1. **受付検証:** デフォルトブランチ以外のrefを拒否。入力形式、PRの存在・open状態・head一致、後述の公開済みメタデータを確認する。
2. **HTML取得:** inlineは `GITHUB_EVENT_PATH` のJSONから読む。releaseは固定Releaseがdraftであり、指定assetがそのRelease配下に存在し、名前が要求と一致することを確認して取得する。どちらもサイズ・UTF-8・SHA-256を検証する。
3. **artifact化:** ファイル名を `pr-{pr_number}-{head_sha先頭12桁}-{run_id}-{run_attempt}.html` としてアップロードする。
4. **コメント更新:** PR headと公開順序を再確認し、更新可能な場合のみ専用コメントを作成／更新する。PR本文には触れない。
5. **後処理:** コメント更新まで成功した場合のみ中継assetを削除する。結果とURLをjob summaryへ記録する。

artifactは `actions/upload-artifact` のv7系を検証済みの完全なcommit SHAで固定し、次の設定を使用する。非ZIPは単一ファイル限定で、`name` は無視され実ファイル名が使われる。[^artifact][^security]

```yaml
with:
  path: <検証済みHTMLの固定作業パス>
  archive: false
  if-no-files-found: error
  retention-days: 30
```

PRに貼るのはaction出力の **`artifact-url`**。リダイレクト後の一時URLやRelease asset URLではない。URLは認証を要し、artifactの期限切れ・削除等で無効になる。[^artifact]

## 4. コメント・競合・再実行

コメントはマーカー `<!-- pr-html-explanation:v1 -->` と**想定する投稿BotのID**の両方で識別する。本文にはHTMLリンク、対象SHA、公開日時、保持期間、workflow runリンクを記載する。非表示メタデータに `request_id` / `head_sha` / `html_sha256` / `run_number` を保存する。

同一PRはconcurrency groupで直列化する。`cancel-in-progress: false`、`queue: max` を使い、実行順序は信用しない。キューには上限があるため、全要求の実行保証は設けない。[^workflow]

- **旧版による上書き禁止:** 保存済み `run_number` より小さい実行は更新しない。比較には元の `github.run_number` を使い、再実行時刻を使わない。同値は同一requestの再実行として扱う。[^context]
- **処理済み要求:** 現行コメントのrequest ID・head・ハッシュが一致する再実行はno-opとする。公開成功後は中継assetが削除済みであり得るため、取得前に判定する。現行コメントと同じrequest IDで内容が異なる場合は拒否する。
- **SHA不一致／PR閉鎖:** 新規公開をskipし、既存コメントを維持する。head確認とコメント更新は原子的ではないため、コメントには常に対象SHAを表示し、「常に最新」とは表現しない。

初期実装で保証するのは**コメントが重複しないことと、旧runが新版を上書きしないこと**。artifactの完全な重複排除は行わない。期限切れ・削除後の再公開は新しいrequest IDで送信する。

## 5. 権限・失敗時の扱い

| 主体 | 権限・境界 |
|---|---|
| CLI | 対象repoのPR読み取り、workflow dispatch。release経路では追加でContents書き込み。fine-grained tokenではdispatchにActions書き込みが必要。[^permissions] |
| 公開workflow | `GITHUB_TOKEN`: `contents: write` / `pull-requests: write`。draft asset取得・削除とPRコメント更新のために使用する。[^release][^permissions] |
| 清掃workflow | `contents: write` のみ。固定の専用Release配下だけを対象にする。[^release] |

公開workflowで実行するコードは信頼済みrefに限定する。checkoutが必要ならrunに対応する `github.sha` を使用し、PR headをcheckout・実行しない。HTMLや入力を `run:` の式へ直接埋め込まず、HTML・dispatch payload・トークンをログへ出さない。dispatch入力を秘密情報の保管先とみなさない。入力検証とHTMLの安全化は別物であり、一般公開の任意HTML投稿サービスとしては扱わない。[^security]

| 状況 | 処理 |
|---|---|
| 検証／取得／artifact化失敗 | 公開失敗。既存コメントは維持。中継assetは清掃期限まで保持 |
| artifact成功、コメント更新失敗 | 公開失敗。artifactと中継assetを保持し再実行可能にする。再実行は別ファイル名でartifactを作成 |
| コメント成功、asset削除失敗 | 公開成功＋清掃警告。リンクを戻さず、後日の清掃に委ねる |
| skip、dispatch失敗、キャンセル | 未処理の中継assetは清掃に委ねる。`always()`で無条件削除しない |

`.github/workflows/cleanup-pr-html.yml` を日次実行し、専用Release配下で本システムの命名規則に一致し、**asset自身の作成日時から7日超**のものだけ削除する。取得・検証・削除には同じRelease IDの制約を適用する。期限超過した要求の再実行は再送を必要とする仕様にする。

## 6. 受け入れ条件

- 小容量・大容量それぞれで、PRコメントから認証済みブラウザでHTMLを直接閲覧でき、ZIP展開を要しない。APIのアップロード成功だけでは完了としない。[^preview]
- 日本語、引用符、CRLF、シェル構文を含むHTMLのバイト列・SHA-256が転送前後で一致する。60,000バイト境界と10 MiB上限を検証する。
- 同一PRへの並行要求、同一SHAでの説明更新、旧runの再実行でコメントの重複・新版から旧版への巻き戻りがない。
- 処理中のPR更新、コメントAPI失敗、dispatch失敗、公開後の再実行、asset削除失敗で上記の状態遷移を満たす。
- 固定Release外のasset、公開済みRelease、ハッシュ不一致、信頼済みref以外を拒否し、無関係なasset・コメント・PRコードに触れない。

実装物はCLI、公開workflow、清掃workflow、転送・状態遷移のテスト、初回設定手順とする。まずinline経路で実際のHTML閲覧を確認し、その後にrelease経路を接続する。

## 7. 実装時の変更（2026-09-11）

実装後の検証で、**runを再実行するとGitHubが前回attemptのartifactを削除する**ことを確認した（公式ドキュメントには明記がなく、実際のrunで観測した挙動）。
この挙動は第4節の「同一requestの再実行はno-op」と両立しないため、次の2点を変更した。

- 現行コメントと同じrequest IDかつ同じrun IDの再実行は、no-opではなく**再公開**とする。HTMLを再度artifact化し、コメントのリンクを新しいartifactへ更新する。
- 中継assetは公開直後に削除せず、清掃workflowの期限（7日）まで保持する。release経路の再実行でもHTMLを再取得できるようにするためで、第5節の「コメント成功、asset削除失敗」の状態は存在しなくなった。

清掃済みのassetを指す再実行は失敗し、CLIからの再送を必要とする点は変わらない。

---

### 仕様参照（2026-09-11確認）

[^artifact]: [upload-artifact v7の入力・出力定義](https://raw.githubusercontent.com/actions/upload-artifact/v7/action.yml)
[^workflow]: [workflow_dispatch / concurrency / permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
[^release]: [Releases API：draftとアクセス条件](https://docs.github.com/en/rest/releases/releases)、[Release assets API](https://docs.github.com/en/rest/releases/assets)
[^permissions]: [Workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)、[PRにも使用するIssue comments API](https://docs.github.com/en/rest/issues/comments)
[^context]: [GitHub context：run_number / run_attempt](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context)
[^security]: [Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
[^preview]: [非ZIP artifactとHTML直接閲覧](https://github.blog/changelog/2026-02-26-github-actions-now-supports-uploading-and-downloading-non-zipped-artifacts/)
