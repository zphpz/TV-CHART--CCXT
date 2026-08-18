import json
import time
import socket
import requests
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

PORT = 8080

def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

def get_polymarket_open_price():
    now_s = int(time.time())
    win_start_s = (now_s // 300) * 300
    win_end_s = win_start_s + 300
    
    start_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(win_start_s))
    end_iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(win_end_s))
    
    # 1. Try Preddy API
    try:
        url = f"https://api.preddy.trade/crypto/price?symbol=btc&startDate={start_iso}&endDate={end_iso}&twapLookbackSeconds=60"
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
        if r.status_code == 200:
            data = r.json()
            if data.get("openPrice") is not None:
                return {
                    "openPrice": float(data["openPrice"]),
                    "winStartSec": win_start_s,
                    "winEndSec": win_end_s
                }
    except Exception:
        pass

    # 2. Try Polymarket API
    try:
        url = f"https://polymarket.com/api/crypto/crypto-price?symbol=BTC&eventStartTime={start_iso}&endDate={end_iso}&twapEnabled=true&twapLookbackSeconds=60"
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=3)
        if r.status_code == 200:
            data = r.json()
            if data.get("openPrice") is not None:
                return {
                    "openPrice": float(data["openPrice"]),
                    "winStartSec": win_start_s,
                    "winEndSec": win_end_s
                }
    except Exception:
        pass

    return {"openPrice": None, "winStartSec": win_start_s, "winEndSec": win_end_s}

HTML_CONTENT = """<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="theme-color" content="#0d1117">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <title>Polymarket BTC 5m Live</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background-color: #0d1117;
            color: #c9d1d9;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 16px;
        }
        .container {
            background: #161b22;
            border: 1px solid #30363d;
            border-radius: 20px;
            padding: 24px;
            width: 100%;
            max-width: 440px;
            box-shadow: 0 12px 36px rgba(0,0,0,0.6);
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
            border-bottom: 1px solid #21262d;
            padding-bottom: 14px;
        }
        .title {
            font-size: 19px;
            font-weight: 700;
            color: #f0f6fc;
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .badge-live {
            background: rgba(46, 160, 67, 0.15);
            color: #3fb950;
            border: 1px solid rgba(46, 160, 67, 0.4);
            font-size: 11px;
            padding: 3px 8px;
            border-radius: 20px;
            font-weight: 700;
            display: inline-flex;
            align-items: center;
            gap: 5px;
        }
        .dot {
            width: 7px;
            height: 7px;
            background: #3fb950;
            border-radius: 50%;
            animation: pulse 1.5s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.3; transform: scale(0.7); }
            100% { opacity: 1; transform: scale(1); }
        }
        .time-box {
            font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
            font-size: 15px;
            font-weight: 700;
            color: #e3b341;
            background: #21262d;
            padding: 5px 12px;
            border-radius: 8px;
            border: 1px solid #30363d;
        }
        .price-section {
            display: flex;
            flex-direction: column;
            gap: 14px;
            margin-bottom: 20px;
        }
        .price-card {
            background: #0d1117;
            border: 1px solid #30363d;
            border-radius: 14px;
            padding: 16px 18px;
            transition: border-color 0.2s;
        }
        .label {
            font-size: 11px;
            color: #8b949e;
            text-transform: uppercase;
            letter-spacing: 0.6px;
            font-weight: 700;
            margin-bottom: 6px;
        }
        .price-val {
            font-size: 30px;
            font-weight: 800;
            font-family: ui-monospace, SFMono-Regular, monospace;
            letter-spacing: -0.5px;
        }
        .price-start { color: #8b949e; }
        .price-current { color: #f0f6fc; }
        .delta-container {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: #21262d;
            border: 1px solid #30363d;
            border-radius: 12px;
            padding: 14px 18px;
        }
        .delta-val {
            font-size: 22px;
            font-weight: 800;
            font-family: ui-monospace, monospace;
        }
        .up { color: #3fb950; text-shadow: 0 0 12px rgba(63, 185, 80, 0.3); }
        .down { color: #f85149; text-shadow: 0 0 12px rgba(248, 81, 73, 0.3); }
        .status-bar {
            font-size: 11px;
            color: #8b949e;
            text-align: center;
            border-top: 1px solid #21262d;
            padding-top: 14px;
            font-family: ui-monospace, monospace;
        }
    </style>
</head>
<body>

<div class="container">
    <div class="header">
        <div class="title">
            <span>₿ BTC 5M</span>
            <span class="badge-live"><span class="dot"></span> LIVE 1:1</span>
        </div>
        <div class="time-box" id="timer">00:00</div>
    </div>

    <div class="price-section">
        <!-- 1. ЦЕЛЕВАЯ ЦЕНА СЕССИИ -->
        <div class="price-card">
            <div class="label">1. Целевая цена (Target / Strike)</div>
            <div class="price-val price-start" id="targetPrice">Загрузка...</div>
        </div>

        <!-- 2. ТЕКУЩАЯ ЦЕНА В ПРЯМОМ ЭФИРЕ -->
        <div class="price-card">
            <div class="label">2. Текущая цена (Live TWAP 60s)</div>
            <div class="price-val price-current" id="currentPrice">---</div>
        </div>

        <!-- 3. ДЕЛЬТА -->
        <div class="delta-container">
            <div class="label" style="margin: 0; font-size: 12px;">Дельта от старта:</div>
            <div class="delta-val" id="deltaVal">---</div>
        </div>
    </div>

    <div class="status-bar" id="statusText">Подключение к прямому потоку...</div>
</div>

<script>
    let activeWindowStart = null;
    let targetPrice = null;
    let currentPrice = null;

    function formatUSD(val) {
        if (val === null || val === undefined || isNaN(val)) return '---';
        return '$' + Number(val).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }

    function updateUI() {
        if (targetPrice !== null) {
            document.getElementById('targetPrice').innerText = formatUSD(targetPrice);
        }
        if (currentPrice !== null) {
            document.getElementById('currentPrice').innerText = formatUSD(currentPrice);
        }
        if (currentPrice !== null && targetPrice !== null) {
            const delta = currentPrice - targetPrice;
            const deltaElem = document.getElementById('deltaVal');
            const sign = delta >= 0 ? '▲ +$' : '▼ -$';
            deltaElem.innerText = `${sign}${Math.abs(delta).toFixed(2)}`;
            deltaElem.className = `delta-val ${delta >= 0 ? 'up' : 'down'}`;
        }
    }

    async function loadTargetPrice() {
        try {
            const res = await fetch('/api/target-price');
            if (res.ok) {
                const data = await res.json();
                if (data && data.openPrice) {
                    targetPrice = data.openPrice;
                    updateUI();
                }
            }
        } catch (e) {
            console.error("Ошибка загрузки openPrice:", e);
        }
    }

    // Таймер обратного отсчета
    setInterval(() => {
        const nowSec = Math.floor(Date.now() / 1000);
        const winStartSec = Math.floor(nowSec / 300) * 300;
        const secInWin = nowSec % 300;
        const remSec = 300 - secInWin;
        const m = Math.floor(remSec / 60).toString().padStart(2, '0');
        const s = (remSec % 60).toString().padStart(2, '0');
        document.getElementById('timer').innerText = `${m}:${s} (${secInWin}s)`;

        if (activeWindowStart !== winStartSec) {
            activeWindowStart = winStartSec;
            targetPrice = null;
            document.getElementById('targetPrice').innerText = 'Загрузка...';
            loadTargetPrice();
        }
    }, 1000);

    // Подключение к WebSocket Polymarket RTDS
    function initWebSocket() {
        const ws = new WebSocket('wss://ws-live-data.polymarket.com');

        ws.onopen = () => {
            document.getElementById('statusText').innerText = '🟢 Подключено: Polymarket RTDS';
            ws.send(JSON.stringify({
                action: 'subscribe',
                subscriptions: [
                    {
                        topic: 'crypto_prices_twap_sixty',
                        type: '*',
                        filters: JSON.stringify({ symbol: 'btc/usd' })
                    }
                ]
            }));
            loadTargetPrice();
        };

        ws.onmessage = (event) => {
            if (!event.data || !event.data.trim()) return;
            try {
                const data = JSON.parse(event.data);
                const payload = data?.payload || {};

                if (payload.data && Array.isArray(payload.data) && payload.data.length > 0) {
                    const lastPt = payload.data[payload.data.length - 1];
                    currentPrice = lastPt.value;
                    if (targetPrice === null) {
                        targetPrice = payload.data[0].value;
                    }
                    updateUI();
                    const timeStr = new Date(lastPt.timestamp).toLocaleTimeString();
                    document.getElementById('statusText').innerText = `🟢 Живой TWAP: ${timeStr} | $${currentPrice.toFixed(2)}`;
                }

                if (payload.value !== undefined && payload.value !== null) {
                    currentPrice = payload.value;
                    updateUI();
                    const timeStr = new Date(payload.timestamp || Date.now()).toLocaleTimeString();
                    document.getElementById('statusText').innerText = `🟢 Живой TWAP: ${timeStr} | $${currentPrice.toFixed(2)}`;
                }
            } catch (err) {
                console.error("Ошибка WS:", err);
            }
        };

        ws.onclose = () => {
            document.getElementById('statusText').innerText = '🔴 Переподключение...';
            setTimeout(initWebSocket, 2000);
        };
    }

    initWebSocket();
</script>

</body>
</html>
"""

class CustomHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/api/target-price":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            data = get_polymarket_open_price()
            self.wfile.write(json.dumps(data).encode("utf-8"))
        else:
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(HTML_CONTENT.encode("utf-8"))

def run_server():
    # Bind to 0.0.0.0 so phone on same Wi-Fi can connect directly
    server = HTTPServer(("0.0.0.0", PORT), CustomHandler)
    local_ip = get_local_ip()
    print("=" * 60)
    print("🚀 POLYMARKET BTC 5M LIVE SERVER ЗАПУЩЕН!")
    print(f"💻 На ПК:      http://localhost:{PORT}")
    print(f"📱 На телефоне: http://{local_ip}:{PORT}")
    print("=" * 60)
    server.serve_forever()

if __name__ == "__main__":
    t = threading.Thread(target=run_server, daemon=True)
    t.start()
    time.sleep(1)
    
    local_ip = get_local_ip()
    print(f"\n[INFO] Сервер активен! Подключайтесь с ПК или смартфона: http://{local_ip}:{PORT}")
    
    while True:
        time.sleep(1)
