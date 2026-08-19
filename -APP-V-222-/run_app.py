import json
import time
import socket
import os
import requests
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, SimpleHTTPRequestHandler
import threading

PORT = 8088
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

from concurrent.futures import ThreadPoolExecutor

_pool_session = requests.Session()
_adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=20)
_pool_session.mount("https://", _adapter)
_pool_session.mount("http://", _adapter)

def fetch_target_price(start_iso, end_iso, lookback_sec=60):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }
    
    # 1. Try Preddy API
    try:
        url = f"https://api.preddy.trade/crypto/price?symbol=btc&startDate={start_iso}&endDate={end_iso}&twapLookbackSeconds={lookback_sec}"
        r = _pool_session.get(url, headers=headers, timeout=3.5)
        if r.status_code == 200:
            data = r.json()
            if data.get("openPrice") is not None:
                return {"openPrice": float(data["openPrice"]), "source": "preddy"}
    except Exception:
        pass

    return {"openPrice": None, "error": "Target price not available yet"}

def fetch_session_history(cond, tok_up, tok_down, start_ts, end_ts):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }
    points = {}
    opening_anchor = None

    def _fetch_clob(tok):
        if not tok: return []
        try:
            url = f"https://clob.polymarket.com/prices-history?market={tok}&interval=1d&fidelity=1"
            r = _pool_session.get(url, headers=headers, timeout=3.0)
            if r.status_code == 200:
                return r.json().get("history", [])
        except Exception:
            pass
        return []

    def _fetch_trades(offset):
        if not cond: return []
        try:
            url = f"https://data-api.polymarket.com/trades?market={cond}&limit=500&offset={offset}"
            r = _pool_session.get(url, headers=headers, timeout=3.0)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return []

    with ThreadPoolExecutor(max_workers=8) as ex:
        f_clob_up = ex.submit(_fetch_clob, tok_up)
        f_clob_down = ex.submit(_fetch_clob, tok_down)
        f_tr0 = ex.submit(_fetch_trades, 0)
        f_tr1 = ex.submit(_fetch_trades, 500)
        f_tr2 = ex.submit(_fetch_trades, 1000)
        f_tr3 = ex.submit(_fetch_trades, 1500)
        f_tr4 = ex.submit(_fetch_trades, 2000)
        f_tr5 = ex.submit(_fetch_trades, 2500)

    # Process CLOB UP
    for p in f_clob_up.result():
        try:
            ts = int(p.get("t", 0))
            val = round(float(p.get("p", 0)) * 100, 1)
            if ts <= start_ts:
                opening_anchor = val
            elif start_ts <= ts <= end_ts:
                points[ts] = val
        except Exception:
            pass

    # Process CLOB DOWN
    for p in f_clob_down.result():
        try:
            ts = int(p.get("t", 0))
            val = round((1.0 - float(p.get("p", 0))) * 100, 1)
            if ts <= start_ts and opening_anchor is None:
                opening_anchor = val
            elif start_ts <= ts <= end_ts and ts not in points:
                points[ts] = val
        except Exception:
            pass

    # Process Trades 6 pages
    for f in [f_tr0, f_tr1, f_tr2, f_tr3, f_tr4, f_tr5]:
        trades = f.result()
        if not isinstance(trades, list): continue
        for tr in trades:
            try:
                ts = int(tr.get("timestamp", 0))
                p = float(tr.get("price", 0))
                outcome = str(tr.get("outcome", "")).lower()
                if outcome == "down" or tr.get("outcomeIndex") == 1:
                    p = 1.0 - p
                up_cents = round(p * 100, 1)
                if ts <= start_ts and opening_anchor is None:
                    opening_anchor = up_cents
                elif start_ts <= ts <= end_ts:
                    points[ts] = up_cents
            except Exception:
                pass

    sorted_pts = sorted(points.items(), key=lambda x: x[0])
    res = [[t, v] for t, v in sorted_pts]
    if opening_anchor is not None:
        res.insert(0, [start_ts, opening_anchor])
    elif res and res[0][0] > start_ts:
        res.insert(0, [start_ts, 50.0])

    return res

class AppHTTPHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/save-history":
            try:
                content_length = int(self.headers.get("Content-Length", 0))
                body = self.rfile.read(content_length)
                history_path = os.path.join(ROOT_DIR, "history.json")
                with open(history_path, "wb") as f:
                    f.write(body)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"success": True, "size": len(body)}).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        # 1. Target price endpoint
        if parsed.path == "/api/target-price":
            start_iso = qs.get("startDate", [None])[0]
            end_iso = qs.get("endDate", [None])[0]
            lookback = int(qs.get("twapLookbackSeconds", [60])[0])

            if not start_iso or not end_iso:
                now_s = int(time.time())
                win_start_s = (now_s // 300) * 300
                win_end_s = win_start_s + 300
                start_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(win_start_s))
                end_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(win_end_s))

            data = fetch_target_price(start_iso, end_iso, lookback)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode("utf-8"))
            return

        # 2. Unified High-Density Parallel Session History Aggregator
        if parsed.path == "/api/session-history":
            cond = qs.get("conditionId", [None])[0]
            tok_up = qs.get("upToken", [None])[0]
            tok_down = qs.get("downToken", [None])[0]
            start_ts = int(qs.get("startTs", [0])[0])
            end_ts = int(qs.get("endTs", [0])[0])
            
            data = fetch_session_history(cond, tok_up, tok_down, start_ts, end_ts)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(data).encode("utf-8"))
            return

        # 3. Polymarket Crypto Proxy endpoint
        if parsed.path.startswith("/api/crypto/"):
            target_url = f"https://polymarket.com{self.path}"
            self._proxy_get(target_url)
            return

        # 4. Polymarket CLOB Proxy endpoint
        if parsed.path.startswith("/api/clob/"):
            target_url = f"https://clob.polymarket.com{self.path.replace('/api/clob', '')}"
            self._proxy_get(target_url)
            return

        # 5. Polymarket Data API Proxy endpoint
        if parsed.path.startswith("/api/data/"):
            target_url = f"https://data-api.polymarket.com{self.path.replace('/api/data', '')}"
            self._proxy_get(target_url)
            return

        # 6. Static files
        return super().do_GET()

    def _proxy_get(self, target_url):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json",
            "Origin": "https://polymarket.com",
            "Referer": "https://polymarket.com/crypto/5m"
        }
        try:
            r = requests.get(target_url, headers=headers, timeout=5)
            self.send_response(r.status_code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(r.content)
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))

import sys
if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

def run_server():
    try:
        from http.server import ThreadingHTTPServer
        server = ThreadingHTTPServer(("0.0.0.0", PORT), AppHTTPHandler)
    except Exception:
        server = HTTPServer(("0.0.0.0", PORT), AppHTTPHandler)
    local_ip = get_local_ip()
    print("=" * 65)
    print(">> POLYMARKET BTC 1:1 TWAP LIVE CHART SERVER (v7.1 Multi-Threaded)")
    print(f"   PC:     http://localhost:{PORT}")
    print(f"   LAN:    http://{local_ip}:{PORT}")
    print(f"   DIR:    {ROOT_DIR}")
    print("=" * 65)
    server.serve_forever()

if __name__ == "__main__":
    run_server()
