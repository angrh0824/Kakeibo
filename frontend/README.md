# 次世代家計簿 - フロントエンド

AIレシート解析による次世代家計簿アプリのフロントエンドUIです。

## デモ

GitHub Pagesで公開しています: [https://asuki-yamada.github.io/kakeibo/](https://asuki-yamada.github.io/kakeibo/)

## 機能

- 📈 **ダッシュボード**: 月次支出・カテゴリ別支出・KPIをグラフで表示
- 🧾 **レシート一覧**: アップロードしたレシートの管理・検索
- 🏷️ **商品マスタ**: 名寄せされた商品の管理
- 📉 **価格推移**: 商品の価格変動をトラッキング
- ⚙️ **設定**: カテゴリ・AI解析設定

## 技術スタック

- HTML5 / CSS3 / JavaScript (Vanilla)
- Chart.js 4.4.3 (CDN)
- レスポンシブデザイン対応

## ローカルでの実行

```bash
cd frontend
python -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

## デプロイ

GitHub Pages にデプロイする場合:

```bash
# リポジトリのルートにfrontendディレクトリを配置
# GitHub Pages の設定で「Deploy from a branch」→ main ブランチの /frontend を選択