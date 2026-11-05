"""画面確認用のローカルサーバー（ログイン不要・サンプルデータ入り）。

本番のCloud Run APIやFirestoreには一切接続しません。frontend/ を配信し、/api/* をメモリ上の
サンプルデータで応答します。js/config.js だけ差し替えてGoogleログインを無効にします。

使い方（リポジトリのルートで実行）:
    python tools/preview_server.py            # http://localhost:5600
    python tools/preview_server.py frontend 5600 --empty    # 記録なしの初回画面
    python tools/preview_server.py frontend 5600 --legacy   # 設定APIがない旧サーバーの挙動
    python tools/preview_server.py frontend 5600 --auth     # ログイン画面の表示確認
"""
import json
import random
import re
import sys
import uuid
from datetime import date, datetime, timedelta
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

args = [a for a in sys.argv[1:] if not a.startswith("--")]
FLAGS = {a for a in sys.argv[1:] if a.startswith("--")}
FRONTEND = Path(args[0] if args else "frontend").resolve()
PORT = int(args[1]) if len(args) > 1 else 5600
LEGACY = "--legacy" in FLAGS
EMPTY = "--empty" in FLAGS

random.seed(11)
TODAY = date.today()

STORES = {
    "マルエツ 鹿島田店": [("玉ねぎ 3個", 198, "食費", 0.00), ("国産若鶏もも肉", 698, "食費", 0.04), ("牛乳 1L", 228, "食費", 0.09),
                     ("食パン 6枚", 168, "食費", 0.05), ("卵 10個", 258, "食費", 0.14), ("キャベツ", 178, "食費", -0.08),
                     ("納豆 3P", 98, "食費", 0.0), ("バナナ", 158, "食費", 0.03), ("豆腐", 68, "食費", 0.0)],
    "セブン-イレブン 新川崎店": [("おにぎり 鮭", 168, "食費", 0.06), ("ホットコーヒー R", 120, "食費", 0.08), ("サラダチキン", 258, "食費", 0.0)],
    "ウエルシア 川崎店": [("ティッシュ 5箱", 398, "日用品", 0.05), ("シャンプー 詰替", 548, "衛生用品", 0.0),
                     ("歯磨き粉", 228, "衛生用品", 0.0), ("洗濯洗剤 詰替", 438, "日用品", -0.06)],
    "ダイソー 鹿島田店": [("収納ボックス", 110, "日用品", 0.0), ("スポンジ 3P", 110, "日用品", 0.0)],
}
MANUAL = [("ランチ", "交際費", 1200, "同僚と"), ("カフェ", "食費", 520, ""), ("ドラッグストア（現金）", "衛生用品", 880, "")]


def iso(d: date, h=18, m=30):
    return datetime(d.year, d.month, d.day, h, m).isoformat()


def make_receipts():
    if EMPTY:
        return []
    receipts = []
    start = date(2026, 6, 1)
    days = (TODAY - start).days
    for offset in range(days + 1):
        d = start + timedelta(days=offset)
        progress = offset / max(1, days)
        for _ in range(random.choice([0, 1, 1, 1, 2])):
            store = random.choice(list(STORES))
            pool = STORES[store]
            picks = random.sample(pool, k=min(len(pool), random.randint(1, 5)))
            items = []
            for name, base, cat, drift in picks:
                q = random.choice([1, 1, 1, 2])
                p = int(round(base * (1 + drift * progress)))
                items.append({"name": name, "price": p, "quantity": q, "category": cat, "line_total": p * q})
            receipts.append({
                "id": uuid.uuid4().hex[:12], "store": store, "date": iso(d, random.randint(9, 21), random.randint(0, 59)),
                "total": sum(i["line_total"] for i in items), "confidence": round(random.uniform(0.82, 0.99), 2),
                "status": "review" if random.random() < 0.06 else "validated", "items": items, "entry_type": "receipt",
                "image_storage": {"provider": "gcs", "bucket": "mock", "object_name": f"receipts/mock/{offset}.jpg"},
            })
        if random.random() < 0.18:
            name, cat, amount, memo = random.choice(MANUAL)
            receipts.append({
                "id": uuid.uuid4().hex[:12], "store": name, "date": iso(d, 12, 0), "total": amount, "confidence": 1,
                "status": "manual", "entry_type": "manual", "memo": memo,
                "items": [{"name": name, "price": amount, "quantity": 1, "category": cat, "line_total": amount}],
            })
    # 電気代: 先月までは記録済み、今月はまだ（ホームで記録を促す）
    month = date(2026, 6, 10)
    while month < date(TODAY.year, TODAY.month, 1):
        amount = random.choice([6800, 7400, 8900, 9600, 7200])
        receipts.append({
            "id": uuid.uuid4().hex[:12], "store": "電気代", "date": iso(month, 12, 0), "total": amount, "confidence": 1,
            "status": "manual", "entry_type": "manual", "recurring_id": "power", "source_filename": "recurring:power",
            "items": [{"name": "電気代", "price": amount, "quantity": 1, "category": "住居・光熱", "line_total": amount}],
        })
        month = date(month.year + (month.month // 12), month.month % 12 + 1, 10)
    return receipts


RECEIPTS = make_receipts()
SETTINGS = None if EMPTY else {
    "categories": [
        {"name": "食費", "color": "c1", "budget": 45000}, {"name": "日用品", "color": "c2", "budget": 8000},
        {"name": "衛生用品", "color": "c3", "budget": 5000}, {"name": "交際費", "color": "c4", "budget": 10000},
        {"name": "住居・光熱", "color": "c5", "budget": 0}, {"name": "通信・サブスク", "color": "c7", "budget": 0},
        {"name": "その他", "color": "gray", "budget": 0},
    ],
    "monthly_budget": 170000,
    "recurring": [
        {"id": "rent", "name": "家賃", "amount": 85000, "category": "住居・光熱", "day": 27, "start_month": "2026-06", "end_month": "", "memo": ""},
        {"id": "phone", "name": "スマホ代", "amount": 3280, "category": "通信・サブスク", "day": 20, "start_month": "2026-06", "end_month": "", "memo": ""},
        {"id": "video", "name": "動画配信", "amount": 990, "category": "通信・サブスク", "day": 3, "start_month": "2026-06", "end_month": "", "memo": ""},
        {"id": "power", "name": "電気代", "amount": 0, "category": "住居・光熱", "day": 10, "start_month": "2026-06", "end_month": "", "memo": ""},
    ],
}
DEFAULT_SETTINGS = {
    "categories": [
        {"name": "食費", "color": "c1", "budget": 0}, {"name": "日用品", "color": "c2", "budget": 0},
        {"name": "衛生用品", "color": "c3", "budget": 0}, {"name": "交際費", "color": "c4", "budget": 0},
        {"name": "住居・光熱", "color": "c5", "budget": 0}, {"name": "通信・サブスク", "color": "c7", "budget": 0},
        {"name": "その他", "color": "gray", "budget": 0},
    ],
    "monthly_budget": 0, "recurring": [], "is_default": True,
}

RECEIPT_SVG = """<svg xmlns='http://www.w3.org/2000/svg' width='360' height='640' viewBox='0 0 360 640'>
<rect width='360' height='640' fill='#fff'/><g font-family='monospace' font-size='16' fill='#222'>
<text x='24' y='48' font-size='22'>{store}</text><text x='24' y='80'>{date}</text>{lines}
<text x='24' y='600' font-size='20'>合計 ¥{total:,}</text></g></svg>"""


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(FRONTEND), **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _find(self, rid):
        return next((r for r in RECEIPTS if r["id"] == rid), None)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/js/config.js":
            client_id = "000000000000-mock.apps.googleusercontent.com" if "--auth" in FLAGS else ""
            body = ('window.KAKEIBO_API_BASE_URL = window.location.origin;\nwindow.KAKEIBO_GOOGLE_CLIENT_ID = "%s";\n' % client_id).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/receipts":
            return self._json(200, {"success": True, "receipts": sorted(RECEIPTS, key=lambda r: r["date"], reverse=True)})
        if path == "/api/household/settings":
            if LEGACY:
                return self._json(404, {"detail": "Not Found"})
            return self._json(200, {"success": True, "settings": SETTINGS or DEFAULT_SETTINGS})
        m = re.match(r"^/api/receipts/([^/]+)/image$", path)
        if m:
            r = self._find(m.group(1))
            if not r:
                return self._json(404, {"detail": "レシートが見つかりません。"})
            lines = "".join(f"<text x='24' y='{130 + i * 28}'>{it['name'][:10]} ¥{it['line_total']:,}</text>" for i, it in enumerate(r["items"][:14]))
            svg = RECEIPT_SVG.format(store=r["store"], date=r["date"][:16].replace("T", " "), lines=lines, total=r["total"]).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml")
            self.send_header("Content-Length", str(len(svg)))
            self.end_headers()
            self.wfile.write(svg)
            return
        if path.startswith("/api/"):
            return self._json(404, {"detail": "mock: not implemented"})
        return super().do_GET()

    def do_POST(self):
        global SETTINGS
        path = self.path.split("?")[0]
        raw = self._body()
        if path == "/api/receipts/analyze":
            sample = {"store": "マルエツ 鹿島田店", "date": datetime.now().replace(second=0, microsecond=0).isoformat(), "total": 1298, "confidence": 0.94,
                      "items": [{"name": "卵 10個", "price": 298, "quantity": 1, "category": "食費", "line_total": 298},
                                {"name": "牛乳 1L", "price": 248, "quantity": 2, "category": "食費", "line_total": 496},
                                {"name": "ティッシュ 5箱", "price": 418, "quantity": 1, "category": "日用品", "line_total": 418},
                                {"name": "バナナ", "price": 86, "quantity": 1, "category": "食費", "line_total": 86}]}
            return self._json(200, {"success": True, "receipts": [sample], "images": [{"filename": "r.jpg", "receipts": [sample]}]})
        if path == "/api/receipts":
            data = json.loads(raw or b"{}")
            data["id"] = uuid.uuid4().hex[:12]
            data["total"] = sum(int(i.get("line_total") or 0) for i in data.get("items", []))
            if LEGACY:
                for key in ("entry_type", "memo", "recurring_id"):
                    data.pop(key, None)
            RECEIPTS.append(data)
            return self._json(201, {"success": True, "receipt": data})
        if path == "/api/household/categories/reassign":
            if LEGACY:
                return self._json(404, {"detail": "Not Found"})
            body = json.loads(raw or b"{}")
            src, dst = body["from_name"], body["to_name"]
            settings = json.loads(json.dumps(SETTINGS or DEFAULT_SETTINGS))
            names = [c["name"] for c in settings["categories"]]
            if src not in names:
                return self._json(404, {"detail": f"カテゴリ「{src}」が見つかりません。"})
            if dst in names:
                s = next(c for c in settings["categories"] if c["name"] == src)
                t = next(c for c in settings["categories"] if c["name"] == dst)
                t["budget"] += s["budget"]
                settings["categories"] = [c for c in settings["categories"] if c["name"] != src]
            else:
                for c in settings["categories"]:
                    if c["name"] == src:
                        c["name"] = dst
            for r in settings.get("recurring", []):
                if r["category"] == src:
                    r["category"] = dst
            affected = 0
            for rec in RECEIPTS:
                hit = False
                for it in rec["items"]:
                    if it.get("category") == src:
                        it["category"] = dst
                        hit = True
                affected += hit
            settings.pop("is_default", None)
            SETTINGS = settings
            return self._json(200, {"success": True, "settings": SETTINGS, "affected_receipts": affected})
        return self._json(404, {"detail": "mock: not implemented"})

    def do_PUT(self):
        global SETTINGS
        path = self.path.split("?")[0]
        raw = self._body()
        if path == "/api/household/settings":
            if LEGACY:
                return self._json(404, {"detail": "Not Found"})
            SETTINGS = json.loads(raw or b"{}")
            return self._json(200, {"success": True, "settings": SETTINGS})
        m = re.match(r"^/api/receipts/([^/]+)$", path)
        if m:
            r = self._find(m.group(1))
            if not r:
                return self._json(404, {"detail": "レシートが見つかりません。"})
            data = json.loads(raw or b"{}")
            data["total"] = sum(int(i.get("line_total") or 0) for i in data.get("items", []))
            if not data.get("image_storage") and r.get("image_storage"):
                data["image_storage"] = r["image_storage"]
            r.update(data)
            return self._json(200, {"success": True, "receipt": r})
        return self._json(404, {"detail": "mock: not implemented"})

    def do_PATCH(self):
        path = self.path.split("?")[0]
        raw = self._body()
        if path == "/api/items/master":
            body = json.loads(raw or b"{}")
            affected = 0
            for rec in RECEIPTS:
                hit = False
                for it in rec["items"]:
                    if it.get("name") == body["old_name"]:
                        it["name"] = body["new_name"]
                        it["category"] = body["category"]
                        hit = True
                affected += hit
            return self._json(200, {"success": True, "affected_receipts": affected})
        return self._json(404, {"detail": "mock: not implemented"})

    def do_DELETE(self):
        path = self.path.split("?")[0]
        m = re.match(r"^/api/receipts/([^/]+)$", path)
        if m:
            r = self._find(m.group(1))
            if r:
                RECEIPTS.remove(r)
            return self._json(200, {"success": True, "receipt": r, "image_deleted": False})
        return self._json(404, {"detail": "mock: not implemented"})


if __name__ == "__main__":
    print(f"serving {FRONTEND} on http://localhost:{PORT} receipts={len(RECEIPTS)} legacy={LEGACY}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
