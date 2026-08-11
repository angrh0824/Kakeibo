# 次世代家計簿 - フロントエンド

AIレシート解析と家族共有クラウドデータに対応した家計簿UIです。

## 実行形態

フロントエンドはGitHub Pagesの静的HTMLとして配信します。許可されたGoogleアカウントだけがCloud Run APIを利用でき、レシート・商品情報はFirestore、圧縮済みレシート画像は非公開Cloud Storageへ保存されます。ブラウザ`localStorage`は正本として使用しません。

## 主な機能

- 月次支出・カテゴリ別支出・KPIダッシュボード
- 複数画像および1画像内の複数レシートAI解析
- 家族共通のレシート登録・編集・削除・同期
- 認証付き非公開レシート画像閲覧
- レシート明細から生成する共有商品マスタと価格推移
- Googleアカウントの許可メール制御

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