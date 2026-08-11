# 次世代家計簿 - フロントエンド

AIレシート解析による次世代家計簿アプリのフロントエンドUIです。

## 実行形態

フロントエンドは静的HTMLとして配信し、画像解析はFastAPIバックエンド経由でOpenRouterを呼び出します。現在のデータはブラウザのlocalStorageに保存されます。

## 機能

- 📈 **ダッシュボード**: 月次支出・カテゴリ別支出・KPIをグラフで表示
- 🧾 **レシート一覧**: アップロードしたレシートの管理・検索
- 🏷️ **商品マスタ**: レシート明細から集計した商品の管理・編集
- 📉 **価格推移**: 商品の価格変動をトラッキング
- ⚙️ **設定**: カテゴリ・AI解析設定

## 技術スタック

- HTML5 / CSS3 / JavaScript (Vanilla)
- Chart.js 4.4.3 (CDN)
- レスポンシブデザイン対応
- Google Identity Services（家族Googleアカウント認証）

## ローカルでの実行

バックエンドAPI（ポート8000）とフロントエンド（ポート5500）を別々に起動します。

```bash
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

別のターミナルで:

```bash
cd frontend
python -m http.server 5500
# ブラウザで http://localhost:5500 を開く
```

## デプロイ

`.github/workflows/pages.yml`が`frontend`をGitHub Pagesへ自動配信し、FastAPIはCloud Runで稼働します。`frontend/js/config.js`に次を設定します。

```javascript
window.KAKEIBO_API_BASE_URL = "https://<cloud-run-service>.run.app";
window.KAKEIBO_GOOGLE_CLIENT_ID = "<web-oauth-client-id>.apps.googleusercontent.com";
```

OAuthクライアントIDは公開識別子であり、クライアントシークレットやOpenRouter APIキーをフロントへ置かないでください。Cloud Run側では`AUTH_REQUIRED=True`、同じ`GOOGLE_OAUTH_CLIENT_ID`、家族の`ALLOWED_USER_EMAILS`を設定します。

`firebase.json`はFirebase Hostingを使う場合の代替設定として残しています。