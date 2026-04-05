// ==UserScript==
// @name          SubscribeStar Export (Vylepšená)
// @namespace     https://github.com/Kamdar-Wolf/Extension-subscribestar
// @version       1.2.1
// @description   Extract feeds from the site
// @author        Kamdar Wolf
// @copyright     2025-2026, Kamdar Wolf
// @license       Proprietary - internal use only
// @homepageURL   https://github.com/Kamdar-Wolf/Extension-subscribestar
// @source        https://raw.githubusercontent.com/Kamdar-Wolf/Extension-subscribestar/master/Export.user.js
// @supportURL    https://github.com/Kamdar-Wolf/Extension-subscribestar/issues
// @icon          https://ss-staging-assets.s3-us-west-1.amazonaws.com/brand/ss_logomark.png
// @icon64        https://ss-staging-assets.s3-us-west-1.amazonaws.com/brand/ss_logomark.png
// @updateURL       https://raw.githubusercontent.com/Kamdar-Wolf/Extension-subscribestar/master/Export.user.js
// @downloadURL     https://raw.githubusercontent.com/Kamdar-Wolf/Extension-subscribestar/master/Export.user.js
// @match         https://subscribestar.adult/*
// @match         https://subscribestar.com/*
// @grant         GM_xmlhttpRequest
// @grant         GM_getValue
// @grant         GM_setValue
// @grant         GM_deleteValue
// @connect       subscribestar.adult
// @connect       subscribestar.com
// @connect       assets.subscribestar.com
// @connect       d3ts7pb9ldoin4.cloudfront.net
// @connect       ss-uploads-prod.b-cdn.net
// @run-at        document-idle
// @tag           SubscribeStar
// ==/UserScript==

(function(){
  'use strict';

  /* ================== Konfigurace ================== */
  const CONFIG = {
    MOUNT_DELAY: 200,           // Zvýšený delay pro SPA
    RETRY_ATTEMPTS: 3,          // Počet pokusů při chybě
    RETRY_DELAY: 1000,          // Delay mezi pokusy
    REQUEST_TIMEOUT: 30000,     // Timeout pro requesty
    SCROLL_WAIT: 500,           // Čekání při scrollování
    MAX_SCROLL_ATTEMPTS: 15,    // Max pokusů o načtení obsahu
  };

  /* ================== Mount & UI ================== */
  const STORE_TOGGLES = 'ssx_toggles_v1';
  let LIVE_LAYOUT = null;
  let DIR_HANDLE = null;
  let mounted = false;
  let hostEl = null;
  let shadow = null;
  let panelEl = null;
  let resizeObs = null;
  let trHandle = null;
  let isResizingTR = false;
  let trStartX = 0, trStartY = 0, trStartW = 0, trStartH = 0;
  let activeDateFilter = null;
  let isProcessing = false;
  let shouldStop = false;

  /* ================== Pomocné funkce ================== */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function abs(u, base = location.href) {
    try {
      return new URL(u, base).href;
    } catch {
      return u;
    }
  }

  const extFrom = n => {
    const clean = n.split('?')[0];
    const match = clean.match(/\.(jpe?g|png|webp|gif|bmp|tiff?|heic|avif)$/i);
    return match ? match[1].toLowerCase() : 'jpg';
  };

  const escapeHtml = s => (s || '').replace(/[&<>"]/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
  }[m]));

  /* ================== Storage ================== */
  function getToggles() {
    try {
      return GM_getValue(STORE_TOGGLES, {
        useFs: false,
        newOnly: true,
        limit: 20,
        newestFirst: true,
        panelW: null,
        panelH: null,
        dateFrom: null,
        dateTo: null
      });
    } catch {
      return {
        useFs: false,
        newOnly: true,
        limit: 20,
        newestFirst: true,
        panelW: null,
        panelH: null,
        dateFrom: null,
        dateTo: null
      };
    }
  }

  function setToggles(next) {
    try {
      GM_setValue(STORE_TOGGLES, next);
    } catch(e) {
      log(`Chyba při ukládání nastavení: ${e.message}`, 'warn');
    }
  }

  function updateToggles(part) {
    const cur = getToggles();
    setToggles({ ...cur, ...part });
  }

  const STORE_HASHES = 'ssx_hashes_v1';

  function loadHashes() {
    try {
      return GM_getValue(STORE_HASHES, {});
    } catch {
      return {};
    }
  }

  function saveHashes(obj) {
    try {
      GM_setValue(STORE_HASHES, obj);
    } catch(e) {
      log(`Chyba při ukládání hashů: ${e.message}`, 'warn');
    }
  }

  function hashText(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /* ================== Network s retry logikou ================== */
  function xfetch(url, type = 'text', attempt = 1) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Request timeout'));
      }, CONFIG.REQUEST_TIMEOUT);

      GM_xmlhttpRequest({
        method: 'GET',
        url: abs(url),
        responseType: type,
        timeout: CONFIG.REQUEST_TIMEOUT,
        onload: r => {
          clearTimeout(timeout);
          if (r.status >= 200 && r.status < 300) {
            resolve(r.response);
          } else {
            reject(new Error(`HTTP ${r.status}`));
          }
        },
        onerror: () => {
          clearTimeout(timeout);
          reject(new Error('Network error'));
        },
        ontimeout: () => {
          clearTimeout(timeout);
          reject(new Error('Timeout'));
        }
      });
    }).catch(async (err) => {
      if (attempt < CONFIG.RETRY_ATTEMPTS) {
        log(`Pokus ${attempt}/${CONFIG.RETRY_ATTEMPTS} selhal, zkouším znovu...`, 'warn');
        await sleep(CONFIG.RETRY_DELAY * attempt);
        return xfetch(url, type, attempt + 1);
      }
      throw err;
    });
  }

  async function blobToDataURL(blob) {
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('FileReader error'));
      fr.readAsDataURL(blob);
    });
  }

  /* ================== Datum parsing - robustnější verze ================== */
  function parseCZ(stamp) {
    if (!stamp) return null;

    // Normalizace
    const normalized = stamp.trim().replace(/\s+/g, ' ');

    // Pattern pro český formát
    const patterns = [
      /([A-Za-zÁ-ž]{3,})\s+(\d{1,2}),?\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(dopoledne|odpoledne)/i,
      /(\d{1,2})\.\s*([A-Za-zÁ-ž]{3,})\s+(\d{4})\s+(\d{1,2}):(\d{2})/i
    ];

    const monthMap = {
      'led': 1, 'úno': 2, 'uno': 2, 'bře': 3, 'bre': 3, 'dub': 4,
      'kvě': 5, 'kve': 5, 'čvn': 6, 'cvn': 6, 'čvc': 7, 'cvc': 7,
      'srp': 8, 'zář': 9, 'zar': 9, 'říj': 10, 'rij': 10, 'lis': 11, 'pro': 12,
      'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
      'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
    };

    const normalizeMonth = s => {
      const k = s.toLowerCase().slice(0, 3);
      const a = k.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
      return monthMap[k] || monthMap[a] || null;
    };

    for (const pattern of patterns) {
      const m = normalized.match(pattern);
      if (!m) continue;

      let mon, day, year, hour, min;

      if (pattern.source.startsWith('([A-Za-z')) {
        // První pattern
        mon = normalizeMonth(m[1]);
        day = parseInt(m[2], 10);
        year = m[3];
        hour = parseInt(m[4], 10);
        min = m[5];
        const ap = (m[6] || '').toLowerCase();
        if (ap === 'odpoledne' && hour < 12) hour += 12;
        if (ap === 'dopoledne' && hour === 12) hour = 0;
      } else {
        // Druhý pattern
        day = parseInt(m[1], 10);
        mon = normalizeMonth(m[2]);
        year = m[3];
        hour = parseInt(m[4], 10);
        min = m[5];
      }

      if (!mon) continue;

      const pad = n => String(n).padStart(2, '0');
      return `${year}-${pad(mon)}-${pad(day)} ${pad(hour)}.${min}`;
    }

    return null;
  }

  function parseStampToDate(stamp) {
    if (!stamp) return null;

    // Zkusit český formát
    const cz = parseCZ(stamp);
    if (cz) {
      const m = cz.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})$/);
      if (m) {
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        const h = Number(m[4]), mi = Number(m[5]);
        const dt = new Date(y, mo - 1, d, h, mi, 0, 0);
        if (!isNaN(dt.getTime())) return dt;
      }
    }

    // Fallback na generické parsování
    const cleaned = stamp
      .replace(/\s+v\s+/i, ' ')
      .replace(/\s+at\s+/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const dt2 = new Date(cleaned);
    return isNaN(dt2.getTime()) ? null : dt2;
  }

  function parseDateInput(value, endOfDay) {
    if (!value) return null;
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (endOfDay) return new Date(y, mo - 1, d, 23, 59, 59, 999);
    return new Date(y, mo - 1, d, 0, 0, 0, 0);
  }

  function buildDateFilterFromStrings(fromStr, toStr) {
    const from = parseDateInput(fromStr || '', false);
    const to = parseDateInput(toStr || '', true);
    if (!from && !to) return null;
    if (from && to && to.getTime() < from.getTime()) return null;
    return { from, to };
  }

  function dateMatchesFilter(dt, filter) {
    if (!filter || (!filter.from && !filter.to)) return true;
    if (!dt) return true;
    const t = dt.getTime();
    if (filter.from && t < filter.from.getTime()) return false;
    if (filter.to && t > filter.to.getTime()) return false;
    return true;
  }

  function getPostDateFromElement(el) {
    if (!el) return null;

    const selectors = [
      '.post', '.post-card', '.section.for-single_post',
      '.for-single_post.section', '[data-post-id]'
    ];

    let card = el;
    for (const sel of selectors) {
      const found = el.closest(sel);
      if (found) {
        card = found;
        break;
      }
    }

    if (!card) return null;

    const dateSelectors = [
      '.section-title_date', '.post-date', '.post-date a',
      'time', '[data-role="timestamp"]', '[datetime]'
    ];

    for (const sel of dateSelectors) {
      const stampEl = card.querySelector(sel);
      if (!stampEl) continue;

      const raw = stampEl.getAttribute('datetime') ||
                  stampEl.getAttribute('data-datetime') ||
                  stampEl.textContent || '';

      const dt = parseStampToDate(raw);
      if (dt) return dt;
    }

    return null;
  }

  function getPostDateFromDocument(doc) {
    if (!doc) return null;

    const dateSelectors = [
      '.section-title_date', '.post-date', '.post-date a',
      'time', '[data-role="timestamp"]', '[datetime]'
    ];

    for (const sel of dateSelectors) {
      const stampEl = doc.querySelector(sel);
      if (!stampEl) continue;

      const raw = stampEl.getAttribute('datetime') ||
                  stampEl.getAttribute('data-datetime') ||
                  stampEl.textContent || '';

      const dt = parseStampToDate(raw);
      if (dt) return dt;
    }

    return null;
  }

  function formatFilterForLog(filter) {
    if (!filter || (!filter.from && !filter.to)) return 'bez filtru';
    const iso = d => d ? d.toISOString().slice(0, 10) : '';
    return `${filter.from ? iso(filter.from) : 'od začátku'} → ${filter.to ? iso(filter.to) : 'do konce'}`;
  }

  /* ================== File System ================== */
  async function pickDirectory() {
    if (!('showDirectoryPicker' in window)) {
      throw new Error('Folder picker není podporován tímto prohlížečem');
    }

    try {
      DIR_HANDLE = await window.showDirectoryPicker({
        id: 'ss-export',
        mode: 'readwrite'
      });

      // Ověřit oprávnění
      const permission = await DIR_HANDLE.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        const request = await DIR_HANDLE.requestPermission({ mode: 'readwrite' });
        if (request !== 'granted') {
          throw new Error('Oprávnění k zápisu nebylo uděleno');
        }
      }

      return true;
    } catch (err) {
      DIR_HANDLE = null;
      throw err;
    }
  }

  async function writeToDir(pathName, blob) {
    if (!DIR_HANDLE) throw new Error('Složka není vybrána');

    const safe = pathName.replace(/[\\/]+/g, '_').replace(/[<>:"|?*]/g, '_');

    try {
      const fh = await DIR_HANDLE.getFileHandle(safe, { create: true });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (err) {
      throw new Error(`Nelze zapsat soubor: ${err.message}`);
    }
  }

  async function fsExists(name) {
    if (!DIR_HANDLE) return false;
    try {
      await DIR_HANDLE.getFileHandle(name.replace(/[\\/]+/g, '_'), { create: false });
      return true;
    } catch {
      return false;
    }
  }

  function saveBlobStd(name, blob) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(u);
    }, 1500);
  }

  async function saveFile(name, blob) {
    if (cbUseFs.checked && DIR_HANDLE) {
      try {
        await writeToDir(name, blob);
        return;
      } catch (e) {
        log(`FS save selhalo → běžné stahování: ${e.message}`, 'warn');
      }
    }
    saveBlobStd(name, blob);
  }

  function saveHTML(name, html) {
    return saveFile(name, new Blob([html], { type: 'text/html;charset=utf-8' }));
  }

  /* ================== Content extraction ================== */
  function extractContentText(doc) {
    const selectors = [
      '.post__content', '.post-content', '.post.body',
      '.post-body', '.post', '.section-body'
    ];

    for (const sel of selectors) {
      const root = doc.querySelector(sel);
      if (root) {
        const txt = root.textContent || '';
        return txt.replace(/\s+/g, ' ').trim();
      }
    }

    return '';
  }

  function extractItemsFrom(node) {
    const out = [];
    const galleries = node.querySelectorAll('[data-gallery]');

    galleries.forEach(n => {
      try {
        const raw = n.getAttribute('data-gallery') || '[]';
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr.forEach(it => {
            if (it && typeof it === 'object') out.push(it);
          });
        }
      } catch (e) {
        log(`Chyba při parsování galerie: ${e.message}`, 'warn');
      }
    });

    return out;
  }

  async function resolveOriginalUrl(item) {
    if (item?.url && /\/post_uploads\?payload=/.test(item.url)) {
      return abs(item.url);
    }

    const first = item?.url || (item?.id ? `/post_uploads/${item.id}` : null);
    if (!first) return null;

    try {
      const html = await xfetch(first, 'text');
      const d = new DOMParser().parseFromString(html, 'text/html');
      const a = d.querySelector('a.gallery-image_original_link');
      return a?.href ? abs(a.href, d.baseURI) : abs(first, d.baseURI);
    } catch {
      return abs(first);
    }
  }

  /* ================== UI ================== */
  let btnPick, cbUseFs, cbNew, inpLim, btnDetail, btnList, logBox, btnOrder;
  let inpDateFrom, inpDateTo, btnApplyDate, btnClearDate;
  let isNewestFirst = true;

  function $(sel) {
    return shadow.querySelector(sel);
  }

  function log(msg, cls) {
    if (!logBox) return;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    const timestamp = new Date().toLocaleTimeString('cs-CZ');
    d.textContent = `[${timestamp}] ${msg}`;
    logBox.appendChild(d);
    logBox.scrollTop = logBox.scrollHeight;

    // Omezit počet logů
    while (logBox.children.length > 500) {
      logBox.removeChild(logBox.firstChild);
    }
  }

  function readPanelSize() {
    if (!panelEl) return {};
    const r = panelEl.getBoundingClientRect();
    return {
      panelW: `${Math.round(r.width)}px`,
      panelH: `${Math.round(r.height)}px`
    };
  }

  function applyPanelSize() {
    const t = getToggles();
    if (panelEl) {
      if (t.panelW) panelEl.style.width = t.panelW;
      if (t.panelH) panelEl.style.height = t.panelH;
    }
  }

  function watchPanelResize() {
    if (!panelEl || !window.ResizeObserver) return;
    if (resizeObs) resizeObs.disconnect();

    resizeObs = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const w = Math.round(e.contentRect.width);
      const h = Math.round(e.contentRect.height);
      updateToggles({ panelW: `${w}px`, panelH: `${h}px` });
    });

    resizeObs.observe(panelEl);
  }

  /* ================== Resize handler ================== */
  function initTopRightResize() {
    if (!shadow || !panelEl) return;
    trHandle = shadow.querySelector('.resize-tr');
    if (!trHandle) return;
    trHandle.addEventListener('mousedown', startTopRightResize);
  }

  function startTopRightResize(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!panelEl) return;

    isResizingTR = true;
    const r = panelEl.getBoundingClientRect();
    trStartX = e.clientX;
    trStartY = e.clientY;
    trStartW = r.width;
    trStartH = r.height;

    window.addEventListener('mousemove', doTopRightResize, true);
    window.addEventListener('mouseup', stopTopRightResize, true);
  }

  function doTopRightResize(e) {
    if (!isResizingTR || !panelEl) return;
    e.preventDefault();
    e.stopPropagation();

    const dx = e.clientX - trStartX;
    const dy = trStartY - e.clientY;
    const newW = Math.max(320, trStartW + dx);
    const newH = Math.max(200, trStartH + dy);

    panelEl.style.width = newW + 'px';
    panelEl.style.height = newH + 'px';
  }

  function stopTopRightResize(e) {
    if (!isResizingTR) return;
    e.preventDefault();
    e.stopPropagation();

    isResizingTR = false;
    window.removeEventListener('mousemove', doTopRightResize, true);
    window.removeEventListener('mouseup', stopTopRightResize, true);
    updateToggles(readPanelSize());
  }

  /* ================== Mount ================== */
  function ensureMounted() {
    if (mounted) return;

    hostEl = document.createElement('div');
    hostEl.className = 'ssg-wrap';
    shadow = hostEl.attachShadow({ mode: 'open' });

    document.body.appendChild(hostEl);
    Object.assign(hostEl.style, {
      position: 'fixed',
      left: '16px',
      bottom: '16px',
      zIndex: '2147483647'
    });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: relative;
          font: 13px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Arial;
          color: #111;
          background: #fafafa;
          border: 1px solid #e5e7eb;
          border-radius: 10px;
          padding: 12px;
          min-width: 320px;
          max-width: 90vw;
          box-shadow: 0 6px 18px rgba(0, 0, 0, .12);
          resize: both;
          overflow: auto;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 10px;
          width: var(--ssx-panel-w, 400px);
          height: var(--ssx-panel-h, auto);
        }
        .resize-tr {
          position: absolute;
          top: 4px;
          right: 6px;
          width: 16px;
          height: 16px;
          cursor: nesw-resize;
          border-radius: 3px;
          background: transparent;
          z-index: 10;
        }
        .resize-tr::after {
          content: "";
          position: absolute;
          inset: 3px;
          border-top: 1px solid #9ca3af;
          border-right: 1px solid #9ca3af;
          opacity: .7;
          pointer-events: none;
        }
        .resize-tr:hover::after {
          opacity: 1;
        }
        .row {
          display: flex;
          gap: 10px;
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: 8px;
          width: 100%;
        }
        .row:last-child {
          margin-bottom: 0;
        }
        .row > * {
          flex: 0 1 auto;
        }
        button {
          background: #111;
          color: #fff;
          border-radius: 8px;
          padding: 9px 12px;
          cursor: pointer;
          font-weight: 600;
          border: 0;
          transition: opacity 0.2s;
        }
        button:hover:not(:disabled) {
          opacity: 0.9;
        }
        .row button {
          flex: 1 1 0;
        }
        button:disabled {
          opacity: .6;
          cursor: not-allowed;
        }
        label {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 6px;
          border-radius: 6px;
          background: #fff;
          border: 1px solid #e5e7eb;
          cursor: pointer;
          user-select: none;
        }
        input[type="checkbox"] {
          width: 16px;
          height: 16px;
          cursor: pointer;
        }
        input[type="number"], input[type="date"] {
          width: 120px;
          padding: 6px 8px;
          border: 1px solid #e5e7eb;
          border-radius: 6px;
          font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Arial;
        }
        .log {
          max-height: 300px;
          overflow: auto;
          padding: 8px 10px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: #0e0e10;
          color: #ddd;
          font: 12px/1.35 Consolas, monospace;
          width: 100%;
          box-sizing: border-box;
          flex: 1 1 auto;
        }
        .ok { color: #4caf50; }
        .warn { color: #ffb300; }
        .err { color: #f44336; }
        .hdr {
          font-weight: 700;
          margin-bottom: 8px;
        }
        .small {
          opacity: .7;
          font-size: 12px;
        }
        .processing {
          pointer-events: none;
          opacity: 0.7;
        }
      </style>
      <div class="panel">
        <div class="resize-tr" title="Změnit velikost panelu"></div>
        <div class="hdr">SubscribeStar Export (v1.3.0)</div>
        <div class="row">
          <button id="pick">Vybrat složku</button>
          <label><input id="usefs" type="checkbox"> Ukládat do složky</label>
          <label><input id="newonly" type="checkbox" checked> Jen nové</label>
          <label>Limit: <input id="limit" type="number" min="1" step="1" value="20"></label>
          <button id="order" title="Přepíná pořadí stahování">Pořadí</button>
        </div>
        <div class="row">
          <button id="runDetail">Stáhnout aktuální feed</button>
          <button id="runList">Stáhnout LIST (/posts/*)</button>
          <button id="stopBtn" style="background:#f44336;display:none;">ZASTAVIT</button>
        </div>
        <div class="row">
          <span class="small">Datumový filtr (LIST):</span>
          <input id="dateFrom" type="date">
          <span>→</span>
          <input id="dateTo" type="date">
          <button id="applyDate" type="button">Použít</button>
          <button id="clearDate" type="button">Zrušit</button>
        </div>
        <div class="row small">
          Detail = aktuální /posts/{id}. List = projít odkazy na této stránce a každý /posts/{id} stáhnout samostatně.
        </div>
        <div id="log" class="log"></div>
      </div>
    `;

    panelEl = shadow.querySelector('.panel');
    applyPanelSize();
    watchPanelResize();
    initTopRightResize();

    wireUI();
    mounted = true;
    log('UI připraveno. Otevři detail /posts/{id} nebo list autora.', 'ok');
  }

  /* ================== SPA Navigation ================== */
  function watchForSPA() {
    let timeoutId = null;

    const scheduleMount = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        ensureMounted();
      }, CONFIG.MOUNT_DELAY);
    };

    const _ps = history.pushState;
    history.pushState = function(...args) {
      const r = _ps.apply(this, args);
      scheduleMount();
      return r;
    };

    const _rs = history.replaceState;
    history.replaceState = function(...args) {
      const r = _rs.apply(this, args);
      scheduleMount();
      return r;
    };

    window.addEventListener('popstate', scheduleMount);

    // Lepší MutationObserver
    const mo = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        if (mut.addedNodes.length > 0) {
          scheduleMount();
          break;
        }
      }
    });

    mo.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  /* ================== UI Wiring ================== */
  function wireUI() {
    btnPick = $('#pick');
    cbUseFs = $('#usefs');
    cbNew = $('#newonly');
    inpLim = $('#limit');
    btnDetail = $('#runDetail');
    btnList = $('#runList');
    btnOrder = $('#order');
    logBox = $('#log');
    inpDateFrom = $('#dateFrom');
    inpDateTo = $('#dateTo');
    btnApplyDate = $('#applyDate');
    btnClearDate = $('#clearDate');
    const btnStop = $('#stopBtn');

    const t = getToggles();
    cbUseFs.checked = !!t.useFs;
    cbNew.checked = t.newOnly !== false;
    inpLim.value = String(t.limit ?? 20);
    isNewestFirst = t.newestFirst !== false;

    if (inpDateFrom && t.dateFrom) inpDateFrom.value = t.dateFrom;
    if (inpDateTo && t.dateTo) inpDateTo.value = t.dateTo;

    activeDateFilter = buildDateFilterFromStrings(t.dateFrom, t.dateTo);

    function persistToggles() {
      const fromVal = inpDateFrom ? (inpDateFrom.value || null) : null;
      const toVal = inpDateTo ? (inpDateTo.value || null) : null;
      updateToggles({
        useFs: cbUseFs.checked,
        newOnly: cbNew.checked,
        limit: Number(inpLim.value) || 20,
        newestFirst: isNewestFirst,
        dateFrom: fromVal,
        dateTo: toVal,
        ...readPanelSize()
      });
    }

    function refreshOrderLabel() {
      if (btnOrder) {
        btnOrder.textContent = isNewestFirst ?
          'Pořadí: od nejnovějších' :
          'Pořadí: od nejstarších';
      }
    }
    refreshOrderLabel();

    [cbUseFs, cbNew].forEach(inp => {
      inp.addEventListener('click', e => {
        e.stopPropagation();
        e.stopImmediatePropagation();
      }, true);

      inp.addEventListener('change', () => {
        persistToggles();
        log(`Nastavení uloženo: složka=${cbUseFs.checked ? 'ANO' : 'NE'}, jen-nové=${cbNew.checked ? 'ANO' : 'NE'}`, 'ok');
      });
    });

    inpLim.addEventListener('change', () => {
      const v = Math.max(1, Math.floor(Number(inpLim.value) || 20));
      inpLim.value = String(v);
      persistToggles();
      log(`Limit uložen: ${v}`, 'ok');
    });

    btnOrder.addEventListener('click', (e) => {
      e.stopPropagation();
      isNewestFirst = !isNewestFirst;
      refreshOrderLabel();
      persistToggles();
      log(`Pořadí stahování: ${isNewestFirst ? 'od nejnovějších' : 'od nejstarších'}`, 'ok');
    });

    btnPick.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await pickDirectory();
        log('Složka vybrána (Chromium).', 'ok');
      } catch (err) {
        log(`Výběr složky: ${err.message || err}`, 'warn');
      }
    });

    btnDetail.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isProcessing) {
        log('Zpracování již běží...', 'warn');
        return;
      }
      shouldStop = false;
      disableButtons(true);
      try {
        await processDetail();
      } finally {
        disableButtons(false);
      }
    });

    btnList.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (isProcessing) {
        log('Zpracování již běží...', 'warn');
        return;
      }
      shouldStop = false;
      disableButtons(true);
      try {
        await processList();
      } finally {
        disableButtons(false);
      }
    });

    if (btnStop) {
      btnStop.addEventListener('click', (e) => {
        e.stopPropagation();
        shouldStop = true;
        log('Zastavování po dokončení aktuálního postu...', 'warn');
        btnStop.textContent = 'Zastavuji...';
        btnStop.disabled = true;
      });
    }

    if (btnApplyDate) {
      btnApplyDate.addEventListener('click', (e) => {
        e.stopPropagation();
        applyDateFilterFromUI();
      });
    }

    if (btnClearDate) {
      btnClearDate.addEventListener('click', (e) => {
        e.stopPropagation();
        clearDateFilter();
        persistToggles();
      });
    }
  }

  function disableButtons(v) {
    isProcessing = v;
    if (btnDetail) btnDetail.disabled = !!v;
    if (btnList) btnList.disabled = !!v;

    const btnStop = $('#stopBtn');
    if (btnStop) {
      if (v) {
        btnStop.style.display = 'block';
        btnStop.disabled = false;
        btnStop.textContent = 'ZASTAVIT';
      } else {
        btnStop.style.display = 'none';
        shouldStop = false;
      }
    }

    if (panelEl) {
      if (v) {
        panelEl.classList.add('processing');
      } else {
        panelEl.classList.remove('processing');
      }
    }
  }

  function applyDateFilterFromUI() {
    const fromVal = inpDateFrom ? inpDateFrom.value : '';
    const toVal = inpDateTo ? inpDateTo.value : '';
    const next = buildDateFilterFromStrings(fromVal, toVal);

    if (!next && (fromVal || toVal)) {
      log('Datumový filtr: kombinace "od / do" nedává smysl. Filtr vypnut.', 'warn');
      activeDateFilter = null;
      updateToggles({ dateFrom: null, dateTo: null });
      return;
    }

    activeDateFilter = next;
    updateToggles({ dateFrom: fromVal || null, dateTo: toVal || null });
    log(`Datumový filtr nastaven: ${formatFilterForLog(activeDateFilter)}`, 'ok');
  }

  function clearDateFilter() {
    activeDateFilter = null;
    if (inpDateFrom) inpDateFrom.value = '';
    if (inpDateTo) inpDateTo.value = '';
    updateToggles({ dateFrom: null, dateTo: null });
    log('Datumový filtr zrušen.', 'ok');
  }

  /* ================== Layout & HTML generation ================== */
  function px(v, fb) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? `${Math.round(n)}px` : (fb ?? null);
  }

  function measureLayout() {
    const selectors = [
      '.section.for-single_post',
      '.for-single_post.section',
      '.post.wrapper'
    ];

    let sec = null;
    for (const sel of selectors) {
      sec = document.querySelector(sel);
      if (sec) break;
    }

    const sb = document.querySelector('.section-body');
    const F = '15px';
    const secW = sec ? Math.round(sec.getBoundingClientRect().width) + 'px' : null;

    return {
      secPL: sec ? px(getComputedStyle(sec).paddingLeft, F) : F,
      secPR: sec ? px(getComputedStyle(sec).paddingRight, F) : F,
      sbPL: sb ? px(getComputedStyle(sb).paddingLeft, null) : null,
      sbPR: sb ? px(getComputedStyle(sb).paddingRight, null) : null,
      secW
    };
  }

  async function buildHeadFrom(doc) {
    const head = doc.head.cloneNode(true);

    head.querySelectorAll('[href]').forEach(n =>
      n.setAttribute('href', abs(n.getAttribute('href'), doc.baseURI))
    );
    head.querySelectorAll('[src]').forEach(n =>
      n.setAttribute('src', abs(n.getAttribute('src'), doc.baseURI))
    );

    const allowed = new Set([
      'assets.subscribestar.com',
      new URL(location.href).host
    ]);

    const links = Array.from(head.querySelectorAll('link[rel="stylesheet"][href]'));

    for (const ln of links) {
      const href = ln.getAttribute('href');
      if (!href) continue;

      let ok = false;
      try {
        ok = allowed.has(new URL(href).host);
      } catch {}

      if (!ok) continue;

      try {
        const css = await xfetch(href, 'text');
        const st = doc.createElement('style');
        st.textContent = css;
        ln.replaceWith(st);
        log(`Inline CSS: ${href}`, 'ok');
      } catch (e) {
        log(`CSS inline selhal: ${href} (${e.message})`, 'warn');
      }

      await sleep(50);
    }

    const o = LIVE_LAYOUT || {};
    const fit = doc.createElement('style');
    fit.textContent = `
      :root, html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        min-width: 0 !important;
        max-width: 1000px !important;
        box-sizing: border-box;
      }
      *, *::before, *::after {
        box-sizing: border-box;
      }
      body {
        display: block !important;
        margin-left: auto !important;
        margin-right: auto !important;
        overflow-x: hidden !important;
      }
      #app, .site-wrapper, .site, #root {
        max-width: 1000px !important;
        margin: 0 auto !important;
        width: 100% !important;
      }
      .ssx-center {
        max-width: 1000px !important;
        width: 100% !important;
        margin: 0 auto !important;
        padding: 0 16px;
      }
      .ssx-center > * {
        max-width: 100%;
        width: 100% !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }
      .section-body img, .section-body video, .section-body canvas, .section-body iframe,
      .post-uploads img, .trix-content img, .post-content img, .post__content img {
        max-width: 100% !important;
        height: auto !important;
      }
      #HEADER, header, .HEADER, .site-header {
        margin-left: auto !important;
        margin-right: auto !important;
        text-align: center !important;
        display: block;
      }
      .section.for-single_post, .for-single_post.section, .post.wrapper.is-single, .post.wrapper {
        margin-left: auto !important;
        margin-right: auto !important;
        max-width: 1000px !important;
        width: 100% !important;
        padding-left: ${o.secPL || '15px'} !important;
        padding-right: ${o.secPR || '15px'} !important;
      }
      ${o.sbPL || o.sbPR ? `.section-body {
        ${o.sbPL ? `padding-left: ${o.sbPL} !important;` : ''}
        ${o.sbPR ? `padding-right: ${o.sbPR} !important;` : ''}
      }` : ''}
      .post-uploads.for-youtube .preview .preview__link img {
        display: block;
        width: 100%;
        height: auto;
      }
      .post-uploads.for-youtube .preview .preview__filename {
        margin-top: 6px;
        font: 12px/1.3 system-ui, Segoe UI, Roboto, Arial;
        word-break: break-word;
      }
    `;
    head.appendChild(fit);

    const titleTxt = (doc.title || 'Post').replace(/[&<>"]/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
    }[m]));

    const prepend = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      `<title>${titleTxt}</title>`
    ].join('\n');

    return `<head>\n${prepend}\n${head.innerHTML}\n</head>`;
  }

  function cleanupClone(clone, baseURI) {
    const removeSelectors = [
      '.ssg-wrap',
      '.post-warning_mature',
      '.vertical_more_menu.is-small',
      '.comments-row.for-new_comment.for-single_post',
      '.comments-row.for-new_comment',
      '.post-uploads:not(.for-youtube)'
    ];

    removeSelectors.forEach(sel => {
      clone.querySelectorAll(sel).forEach(n => n.remove());
    });

    clone.querySelectorAll('[href]').forEach(n =>
      n.setAttribute('href', abs(n.getAttribute('href'), baseURI))
    );
    clone.querySelectorAll('[src]').forEach(n =>
      n.setAttribute('src', abs(n.getAttribute('src'), baseURI))
    );
  }

  function injectIntoForYouTube(cloneRoot, galleryObjs) {
    let cont = cloneRoot.querySelector('.post-uploads.for-youtube');

    if (!cont) {
      const hostSelectors = [
        '.post__content', '.post-content', '.post-body',
        '.post.wrapper', '.post'
      ];

      let host = null;
      for (const sel of hostSelectors) {
        host = cloneRoot.querySelector(sel);
        if (host) break;
      }

      if (!host) host = cloneRoot;

      cont = document.createElement('div');
      cont.className = 'post-uploads for-youtube';
      host.appendChild(cont);
    }

    cont.innerHTML = '';

    (galleryObjs || []).forEach(g => {
      const p = document.createElement('div');
      p.className = 'preview';

      const a = document.createElement('a');
      a.className = 'preview__link';
      a.href = encodeURI(g.localName);
      a.setAttribute('download', '');

      const img = document.createElement('img');
      img.src = g.dataURL;
      img.alt = g.filename;
      a.appendChild(img);

      const name = document.createElement('div');
      name.className = 'preview__filename';
      name.innerHTML = `<a href="${encodeURI(g.localName)}" download>${escapeHtml(g.filename)}</a>`;

      p.append(a, name);
      cont.appendChild(p);
    });
  }

  function stableHtmlName(id) {
    return `post-${id}.html`;
  }

  function humanTitleFrom(doc, id) {
    const selectors = [
      '.section-title_date',
      '.post-date',
      '.post-date a',
      'time'
    ];

    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (!el) continue;

      const stamp = el.textContent?.trim();
      if (stamp) {
        const parsed = parseCZ(stamp);
        if (parsed) return parsed;
      }
    }

    return `post-${id}`;
  }

  /* ================== Download single post ================== */
  async function downloadPostById(id, skipDateCheck = false) {
    if (shouldStop) {
      throw new Error('STOPPED_BY_USER');
    }

    const html = await xfetch(`/posts/${id}`, 'text');
    const fetched = new DOMParser().parseFromString(html, 'text/html');

    // Datumová kontrola - pokud není skipDateCheck
    if (!skipDateCheck && activeDateFilter && (activeDateFilter.from || activeDateFilter.to)) {
      const postDate = getPostDateFromDocument(fetched);
      if (postDate && !dateMatchesFilter(postDate, activeDateFilter)) {
        log(`Přeskočeno (datum mimo rozsah): #${id} [${postDate.toISOString().slice(0, 10)}]`, 'warn');
        return;
      }
    }

    const store = loadHashes();
    const h = hashText(extractContentText(fetched));
    const htmlName = stableHtmlName(id);
    const niceBase = humanTitleFrom(fetched, id);

    if (cbNew.checked && store[id] && store[id].hash === h) {
      log(`Přeskočeno (dříve staženo & beze změny): #${id} ⇒ ${store[id].name || htmlName}`, 'warn');
      return;
    }

    log(`Zpracovávám feed #${id} ⇒ ${htmlName}`);

    let items = extractItemsFrom(fetched);

    if (!items.length) {
      try {
        const up = await xfetch(`/posts/${id}/uploads`, 'text');
        const frag = new DOMParser().parseFromString(up, 'text/html');
        items = extractItemsFrom(frag);
      } catch (e) {
        log(`Nelze načíst uploads: ${e.message}`, 'warn');
      }
    }

    const galleryObjs = [];

    if (items.length) {
      let i = 1;
      for (const it of items) {
        if (shouldStop) {
          throw new Error('STOPPED_BY_USER');
        }

        const orig = await resolveOriginalUrl(it);
        if (!orig) {
          log(`Přeskočeno: nelze určit URL pro item ${i}`, 'warn');
          continue;
        }

        try {
          const blob = await xfetch(orig, 'blob');
          const ext = extFrom(it.original_filename || orig);
          const localName = `${niceBase}_${i}.${ext}`;

          await saveFile(localName, blob);
          const dataURL = await blobToDataURL(blob);

          galleryObjs.push({
            index: i,
            filename: (it.original_filename || `image_${i}.${ext}`),
            localName,
            dataURL
          });

          log(`IMG ${localName}`, 'ok');
          i++;
        } catch (e) {
          log(`Chyba IMG: ${e.message || e}`, 'warn');
        }

        await sleep(80);
      }
    }

    LIVE_LAYOUT = measureLayout();
    const headHTML = await buildHeadFrom(fetched);

    const rootSelectors = [
      '.section.for-single_post',
      '.for-single_post.section',
      '.post.wrapper.is-single',
      '.post.wrapper'
    ];

    let root = null;
    for (const sel of rootSelectors) {
      root = fetched.querySelector(sel);
      if (root) break;
    }

    if (!root) root = fetched.body;

    const clone = root.cloneNode(true);
    cleanupClone(clone, fetched.baseURI);

    if (galleryObjs.length) {
      injectIntoForYouTube(clone, galleryObjs);
    }

    const bodyInner = `<div class="ssx-center">${clone.outerHTML}</div>`;
    const finalHTML = [
      '<!doctype html>',
      `<html lang="${fetched.documentElement.getAttribute('lang') || 'cs'}">`,
      headHTML,
      '<body>',
      bodyInner,
      '</body></html>'
    ].join('\n');

    await saveHTML(htmlName, finalHTML);
    log(`HTML ${htmlName}${galleryObjs.length ? ` + IMG x${galleryObjs.length}` : ''}`, 'ok');

    const store2 = loadHashes();
    store2[id] = { hash: h, name: htmlName, t: Date.now() };
    saveHashes(store2);
  }

  /* ================== Process detail ================== */
  async function processDetail() {
    const m = location.pathname.match(/\/posts\/(\d+)/);
    if (!m) {
      log('Nejsi na /posts/{id}.', 'warn');
      return;
    }

    const id = m[1];

    try {
      // Pro detail mode skipnout datumovou kontrolu, protože uživatel je explicitně na té stránce
      await downloadPostById(id, true);
      log('Hotovo (detail).', 'ok');
    } catch (e) {
      if (e.message === 'STOPPED_BY_USER') {
        log('Stahování zastaveno uživatelem.', 'warn');
      } else {
        log(`Chyba: ${e.message || e}`, 'err');
        throw e;
      }
    }
  }

  /* ================== Collect posts from links ================== */
  function collectPostIdsFromLinks(maxCount, filter) {
    const ids = [];
    const seen = new Set();
    const hostAllow = new Set([
      'subscribestar.adult',
      'www.subscribestar.adult',
      'subscribestar.com',
      'www.subscribestar.com'
    ]);

    const candidates = Array.from(document.querySelectorAll(
      'a[href], [data-post-id], [data-id]'
    ));

    const useFilter = !!(filter && (filter.from || filter.to));

    function maybePush(id, el) {
      if (!id) return;
      const norm = String(id).trim();
      if (!/^[0-9]+$/.test(norm)) return;
      if (seen.has(norm)) return;

      if (useFilter) {
        const dt = getPostDateFromElement(el);
        if (!dateMatchesFilter(dt, filter)) {
          seen.add(norm);
          return;
        }
      }

      seen.add(norm);
      ids.push(norm);
    }

    for (const el of candidates) {
      const attrId = el.getAttribute('data-post-id') ||
                     el.getAttribute('data-id');
      if (attrId) maybePush(attrId, el);

      const href = el.getAttribute('href');
      if (!href) {
        if (maxCount && ids.length >= maxCount) break;
        continue;
      }

      try {
        const u = new URL(href, document.baseURI);
        if (!hostAllow.has(u.host)) {
          if (maxCount && ids.length >= maxCount) break;
          continue;
        }

        const m = u.pathname.match(/\/posts\/(\d+)(?=\/|$)/) ||
                  u.pathname.match(/\/posts\/([0-9]+)/);
        if (m) maybePush(m[1], el);
      } catch {}

      if (maxCount && ids.length >= maxCount) break;
    }

    return maxCount ? ids.slice(0, maxCount) : ids;
  }

  /* ================== Process list ================== */
  async function processList() {
    const desired = Math.max(1, Math.floor(Number(inpLim.value) || 20));

    async function clickPostsMore() {
      if (shouldStop) return false;

      const selectors = [
        '.posts-more', '.posts__more',
        '[data-role="posts-more"]', '[data-action="posts-more"]'
      ];

      let btn = null;
      for (const sel of selectors) {
        btn = document.querySelector(sel);
        if (btn) break;
      }

      if (!btn) return false;

      const before = document.querySelectorAll('a[href*="/posts/"]').length;

      try {
        btn.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true
        }));
        if (btn.click) btn.click();
      } catch (e) {
        log(`Chyba při kliknutí na tlačítko: ${e.message}`, 'warn');
      }

      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        if (shouldStop) return false;
        await sleep(CONFIG.SCROLL_WAIT);
        const now = document.querySelectorAll('a[href*="/posts/"]').length;
        if (now > before) return true;
      }

      return false;
    }

    async function scrollForMore() {
      if (shouldStop) return false;

      const before = collectPostIdsFromLinks(undefined, activeDateFilter).length;

      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: 'smooth'
      });

      const t0 = Date.now();
      while (Date.now() - t0 < 2600) {
        if (shouldStop) return false;
        await sleep(CONFIG.SCROLL_WAIT);
        const now = collectPostIdsFromLinks(undefined, activeDateFilter).length;
        if (now > before) return true;
      }

      return false;
    }

    let ids = collectPostIdsFromLinks(desired, activeDateFilter);
    let guard = 0;

    while (ids.length < desired && guard++ < CONFIG.MAX_SCROLL_ATTEMPTS && !shouldStop) {
      log(`Načítám další obsah... (${ids.length}/${desired})`, 'ok');

      const clicked = await clickPostsMore();
      const scrolled = await scrollForMore();

      ids = collectPostIdsFromLinks(desired, activeDateFilter);

      if (ids.length >= desired) break;
      if (!clicked && !scrolled) {
        log('Nelze načíst další obsah, pokračuji s tím co mám', 'warn');
        break;
      }
    }

    if (shouldStop) {
      log('Stahování zastaveno před začátkem.', 'warn');
      return;
    }

    if (!ids.length) {
      log('Na stránce nejsou odkazy ve formátu /posts/{id} (nebo nevyhovují filtru).', 'warn');
      return;
    }

    if (!isNewestFirst) ids = ids.slice().reverse();

    const filterLabel = formatFilterForLog(activeDateFilter);
    log(`Ke stažení: ${ids.length} postů (limit ${desired}). Pořadí: ${isNewestFirst ? 'nejnovější → nejstarší' : 'nejstarší → nejnovější'}. Filtr: ${filterLabel}.`);

    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < ids.length; i++) {
      if (shouldStop) {
        log(`Zastaveno uživatelem po ${success + failed} pokusech.`, 'warn');
        break;
      }

      const id = ids[i];
      log(`[${i + 1}/${ids.length}] Stahuji #${id}...`, 'ok');

      try {
        await downloadPostById(id, false);
        success++;
      } catch (e) {
        if (e.message === 'STOPPED_BY_USER') {
          log('Stahování zastaveno uživatelem.', 'warn');
          break;
        }
        log(`Chyba u #${id}: ${e.message || e}`, 'err');
        failed++;
      }

      await sleep(100);
    }

    const totalProcessed = success + failed;
    log(`Hotovo (list). Úspěšně: ${success}, Selhalo: ${failed}, Zpracováno: ${totalProcessed}/${ids.length}`,
        success === ids.length ? 'ok' : 'warn');
  }

  /* ================== Start ================== */
  ensureMounted();
  watchForSPA();
})();
