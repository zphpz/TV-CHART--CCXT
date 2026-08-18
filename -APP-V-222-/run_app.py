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

def fetch_target_price(start_iso, end_iso, lookback_sec=60):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }
    
    # 1. Try Preddy API
    try:
        url = f"https://api.preddy.trade/crypto/price?symbol=btc&startDate={start_iso}&endDate={end_iso}&twapLookbackSeconds={lookback_sec}"
        r = requests.get(url, headers=headers, timeout=3.5)
        if r.status_code == 200:
            data = r.json()
            if data.get("openPrice") is not None:
                return {"openPrice": float(data["openPrice"]), "source": "preddy"}
    except Exception:
        pass

    # 2. Try Polymarket API
    try:
        url = f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={start_iso}&endDate={end_iso}&twapEnabled=true&twapLookbackSeconds={lookback_sec}"
        r = requests.get(url, headers=headers, timeout=3.5)
        if r.status_code == 200:
            data = r.json()
            if data.get("openPrice") is not None:
                return {"openPrice": float(data["openPrice"]), "source": "polymarket"}
    except Exception:
        pass

    return {"openPrice": None, "error": "Target price not available yet"}

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

        # 2. Polymarket Crypto Proxy endpoint
        if parsed.path.startswith("/api/crypto/"):
            target_url = f"https://polymarket.com{self.path}"
            self._proxy_get(target_url)
            return

        # 3. Polymarket CLOB Proxy endpoint
        if parsed.path.startswith("/api/clob/"):
            target_url = f"https://clob.polymarket.com{self.path.replace('/api/clob', '')}"
            self._proxy_get(target_url)
            return

        # 4. Polymarket Data API Proxy endpoint
        if parsed.path.startswith("/api/data/"):
            target_url = f"https://data-api.polymarket.com{self.path.replace('/api/data', '')}"
            self._proxy_get(target_url)
            return

        # 5. Static files
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

def run_server():
    server = HTTPServer(("0.0.0.0", PORT), AppHTTPHandler)
    local_ip = get_local_ip()
    print("=" * 65)
    print("🚀 POLYMARKET BTC 1:1 TWAP LIVE CHART SERVER (v5.3)")
    print(f"💻 На ПК:       http://localhost:{PORT}")
    print(f"📱 На телефоне:  http://{local_ip}:{PORT}")
    print(f"📁 Папка:       {ROOT_DIR}")
    print("=" * 65)
    server.serve_forever()

if __name__ == "__main__":
    run_server()
