/**
 * bundle.js — Automated Single-File Standalone HTML Builder for -APP-V-222-
 * 
 * Bundles index.html, css/style.css, libs/lightweight-charts.js, and all js/*.js modules into a single
 * standalone HTML file: One/index.html.
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname);
const ONE_DIR = path.join(ROOT_DIR, 'One');
const OUTPUT_FILE = path.join(ONE_DIR, 'index.html');

function bundle() {
  console.log('[Bundle] Building standalone single-file HTML into One/index.html...');

  if (!fs.existsSync(ONE_DIR)) {
    fs.mkdirSync(ONE_DIR, { recursive: true });
  }

  let html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

  // 1. Inline CSS
  const cssPath = path.join(ROOT_DIR, 'css', 'style.css');
  if (fs.existsSync(cssPath)) {
    const cssContent = fs.readFileSync(cssPath, 'utf8');
    html = html.replace(
      /<link\s+rel="stylesheet"\s+href="css\/style\.css"\s*\/?>/i,
      () => `<style>\n${cssContent}\n</style>`
    );
  }

  // 2. Inline Lightweight Charts library
  const lcPath = path.join(ROOT_DIR, 'libs', 'lightweight-charts.standalone.production.js');
  let lcContent = '';
  if (fs.existsSync(lcPath)) {
    lcContent = fs.readFileSync(lcPath, 'utf8');
  }

  // 3. JS Modules in order of dependency
  const jsFiles = [
    'js/price.js',
    'js/buffer.js',
    'js/db.js',
    'js/backfill.js',
    'js/market.js',
    'js/ws.js',
    'js/rtds.js',
    'js/live_trading.js',
    'js/chart.js',
    'js/panel.js',
    'js/app.js'
  ];

  let combinedJs = lcContent ? `\n/* ═══ VENDOR: Lightweight Charts v5 ═══ */\n${lcContent}\n;\n` : '';
  for (const relPath of jsFiles) {
    const absPath = path.join(ROOT_DIR, relPath);
    if (fs.existsSync(absPath)) {
      const code = fs.readFileSync(absPath, 'utf8');
      combinedJs += `\n/* ═══ MODULE: ${relPath} ═══ */\n${code}\n;\n`;
    } else {
      console.warn(`[Bundle] Warning: ${relPath} not found!`);
    }
  }

  // Remove vendor library script tag
  html = html.replace(/<script\s+src="libs\/lightweight-charts\.standalone\.production\.js"><\/script>\s*/i, '');

  // Remove individual module script tags
  for (const relPath of jsFiles) {
    const re = new RegExp(`<script\\s+src="${relPath.replace('/', '\\/')}"\\s*><\\/script>\\s*`, 'gi');
    html = html.replace(re, '');
  }

  // Insert inlined combined script before </body>
  html = html.replace(
    '</body>',
    () => `<script>\n${combinedJs}\n</script>\n</body>`
  );

  fs.writeFileSync(OUTPUT_FILE, html, 'utf8');
  const sizeKb = (fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1);
  console.log(`[Bundle] Standalone HTML created successfully: ${OUTPUT_FILE} (${sizeKb} KB)`);
}

bundle();
