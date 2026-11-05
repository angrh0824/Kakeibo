# 次世代家計簿 - フロントエンド

AIレシート解析と家族共有クラウドデータに対応した家計簿UIです。

## 実行形態

フロントエンドはGitHub Pagesの静的HTMLとして配信します。許可されたGoogleアカウントだけがCloud Run APIを利用でき、レシート・商品情報はFirestore、圧縮済みレシート画像は非公開Cloud Storageへ保存されます。ブラウザ`localStorage`は正本として使用しません。

## 主な機能

- ホーム: 今月の支出、予算の残りと1日あたりの目安、月末の見込み、カテゴリ別の予算バー、支出のペース、値動きした品目
- 複数画像および1画像内の複数レシートのAI解析。確認画面で元画像と並べて修正
- 手入力（現金・家賃・サブスクなど）と、毎月自動で計上する固定費
- 家計簿ごとの予算・カテゴリ（追加・名前変更・統合・色）を家族で共有
- 履歴: 日ごとの一覧、店名・品名・メモ検索、種類とカテゴリの絞り込み
- 分析: 月ごとのカテゴリ別推移（表でも確認可）、よく行くお店、品目ごとの価格推移と表記ゆれの統合
- ライト・ダーク両対応、スマートフォンは下部タブ、PCは左メニュー
- CSV・JSONの書き出し
- Googleアカウントの許可メール制御と家計簿の招待共有

## 技術スタック

- HTML5 / CSS3 / Vanilla JavaScript
- Chart.js 4.4.3
- Google Identity Services
- FastAPI / Cloud Run
- Firestore / Cloud Storage

## ローカル実行

```bash
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

別ターミナル:

```bash
cd frontend
python -m http.server 5500
# http://localhost:5500
# 設定API（/api/household/settings）がない古いサーバーでも、設定を端末へ保存して動作します。
```

ローカルから実際のFirestoreとCloud Storageを利用する場合はApplication Default Credentialsと対象Google Cloudリソースへの権限が必要です。通常のUI確認では本番Cloud Run APIを使用できます。

## デプロイ

`.github/workflows/pages.yml`が`frontend`をGitHub Pagesへ配信し、FastAPIはCloud Runで稼働します。

```javascript
window.KAKEIBO_API_BASE_URL = "https://<cloud-run-service>.run.app";
window.KAKEIBO_GOOGLE_CLIENT_ID = "<web-oauth-client-id>.apps.googleusercontent.com";
```

OAuthクライアントIDは公開識別子です。クライアントシークレットとOpenRouter APIキーはフロントへ置かないでください。Cloud Runには認証設定に加え、`FIRESTORE_DATABASE`と`GCS_BUCKET_NAME`を設定します。

詳細は`docs/00_現行実装仕様.md`を参照してください。`firebase.json`はFirebase Hostingへ切り替える場合の代替設定です。