// content.js

/* ================== POMOCNÉ FUNKCE (DATUMY A URL) ================== */
const monthMap = {
  'led': 1, 'úno': 2, 'uno': 2, 'bře': 3, 'bre': 3, 'dub': 4,
  'kvě': 5, 'kve': 5, 'čvn': 6, 'cvn': 6, 'čvc': 7, 'cvc': 7,
  'srp': 8, 'zář': 9, 'zar': 9, 'říj': 10, 'rij': 10, 'lis': 11, 'pro': 12,
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
  'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
};

function normalizeMonth(s) {
  const k = s.toLowerCase().slice(0, 3);
  const a = k.normalize('NFKD').replace(/[^\x00-\x7F]/g, '');
  return monthMap[k] || monthMap[a] || null;
}

function parseCZDate(stamp) {
  if (!stamp) return null;
  const normalized = stamp.trim().replace(/\s+/g, ' ');
  const patterns = [
    /([A-Za-zÁ-ž]{3,})\s+(\d{1,2}),?\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(dopoledne|odpoledne)/i,
    /(\d{1,2})\.\s*([A-Za-zÁ-ž]{3,})\s+(\d{4})\s+(\d{1,2}):(\d{2})/i
  ];
  for (const pattern of patterns) {
    const m = normalized.match(pattern);
    if (!m) continue;
    let mon, day, year, hour, min;
    if (pattern.source.startsWith('([A-Za-z')) {
      mon = normalizeMonth(m[1]); day = parseInt(m[2], 10); year = m[3];
      hour = parseInt(m[4], 10); min = m[5];
      const ap = (m[6] || '').toLowerCase();
      if (ap === 'odpoledne' && hour < 12) hour += 12;
      if (ap === 'dopoledne' && hour === 12) hour = 0;
    } else {
      day = parseInt(m[1], 10); mon = normalizeMonth(m[2]); year = m[3];
      hour = parseInt(m[4], 10); min = m[5];
    }
    if (!mon) continue;
    return new Date(year, mon - 1, day, hour, min);
  }
  return null;
}

function resolveDateFromEl(el) {
  if (!el) return null;
  const dateSelectors = ['.section-title_date', '.post-date', '.post-date a', 'time', '[data-role="timestamp"]', '[datetime]'];
  for (const sel of dateSelectors) {
    const stampEl = el.querySelector(sel);
    if (!stampEl) continue;
    const raw = stampEl.getAttribute('datetime') || stampEl.getAttribute('data-datetime');
    if (raw) {
      const dt = new Date(raw);
      if (!isNaN(dt.getTime())) return dt;
    }
    const txt = stampEl.textContent || '';
    const dtCZ = parseCZDate(txt);
    if (dtCZ) return dtCZ;
    const dt2 = new Date(txt.replace(/\s+v\s+/i, ' ').replace(/\s+at\s+/i, ' '));
    if (!isNaN(dt2.getTime())) return dt2;
  }
  return null;
}

function buildDateFilter(fromStr, toStr) {
  const from = fromStr ? new Date(fromStr) : null;
  const to = toStr ? new Date(toStr) : null;
  if (to) to.setHours(23, 59, 59, 999);
  return { from, to };
}

function dateMatches(dt, filter) {
  if (!filter || (!filter.from && !filter.to)) return true;
  if (!dt) return true; // Neznámé raději nevyřazujeme
  const t = dt.getTime();
  if (filter.from && t < filter.from.getTime()) return false;
  if (filter.to && t > filter.to.getTime()) return false;
  return true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================== SCRAPER LOGIC ================== */

function getAuthorInfo() {
  const authorEl = document.querySelector('.subscriber-name, .profile_main_info-name, .feed-title');
  let author = authorEl ? authorEl.textContent.trim() : 'Unknown_Author';
  author = author.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim().replace(/\s+/g, '_');
  return { author: author || 'Unknown_Author' };
}

async function collectPostIds(limit, dateFrom, dateTo) {
  const filter = buildDateFilter(dateFrom, dateTo);
  const ids = new Set();
  const maxAttempts = 15;
  let attempts = 0;

  function scanVisible() {
    const posts = document.querySelectorAll('.post[data-id], .post-card[data-post-id]');
    for (const p of posts) {
      const id = p.getAttribute('data-id') || p.getAttribute('data-post-id');
      const dt = resolveDateFromEl(p);
      if (!filter || dateMatches(dt, filter)) {
        ids.add(id);
      }
    }
  }

  scanVisible();
  
  while (ids.size < limit && attempts < maxAttempts) {
    const moreBtn = document.querySelector('.posts-more');
    if (!moreBtn) break; // Nejsou další posty
    
    const beforeCount = ids.size;
    moreBtn.click();
    await sleep(2000); // Čekání na natažení sítě
    
    scanVisible();
    if (ids.size === beforeCount) {
      attempts++; // Bezpečností brzda, pokud se nic nezmění
    } else {
      attempts = 0;
    }
  }

  return { ids: Array.from(ids).slice(0, limit), author: getAuthorInfo().author };
}

/* ================== HTML CLONING ================== */
async function buildHeadFrom(doc) {
  const head = doc.head.cloneNode(true);
  
  // Převést relativní linky na absolutní
  head.querySelectorAll('[href]').forEach(n => n.setAttribute('href', new URL(n.getAttribute('href'), "https://subscribestar.adult").href));
  head.querySelectorAll('[src]').forEach(n => n.setAttribute('src', new URL(n.getAttribute('src'), "https://subscribestar.adult").href));
  
  const allowedHosts = new Set(['assets.subscribestar.com', 'subscribestar.adult', 'subscribestar.com', 'www.subscribestar.adult']);
  const links = Array.from(head.querySelectorAll('link[rel="stylesheet"][href]'));
  
  // Zkusíme stáhnout a inlinovat CSS
  for (const ln of links) {
    const href = ln.getAttribute('href');
    if (!href) continue;
    try {
      const hn = new URL(href).host;
      if (!allowedHosts.has(hn)) continue;
      
      const res = await fetch(href);
      if (res.ok) {
         const css = await res.text();
         const st = doc.createElement('style');
         st.textContent = css;
         ln.replaceWith(st);
      }
    } catch {}
  }

  // Přidáme fixovací CSS (aby nebyly obrázky obří apod)
  const fit = doc.createElement('style');
  fit.textContent = `
    :root, html, body { margin: 0; padding: 0; width: 100%; min-width: 0 !important; max-width: 1000px !important; box-sizing: border-box; }
    *, *::before, *::after { box-sizing: border-box; }
    body { display: block !important; margin: 0 auto !important; overflow-x: hidden !important; background: #000; color: #fff;}
    #app, .site-wrapper, .site, #root, .ssx-center { max-width: 1000px !important; margin: 0 auto !important; width: 100% !important; padding: 0 16px; }
    .section-body img, .post-uploads.for-youtube .preview__link img { display: block; max-width: 100% !important; height: auto !important; }
    .post-uploads.for-youtube .preview__filename { margin-top: 6px; font: 12px/1.3 system-ui, sans-serif; word-break: break-word; }
    .preview { margin-bottom: 24px; padding: 12px; border: 1px solid #333; border-radius: 8px; background: #111;}
  `;
  head.appendChild(fit);
  return head.innerHTML;
}

function injectIntoForYouTube(cloneRoot, images) {
  let cont = cloneRoot.querySelector('.post-uploads.for-youtube');
  if (!cont) {
    const hostSelectors = ['.post__content', '.post-content', '.post-body', '.post.wrapper', '.post'];
    let host = null;
    for (const sel of hostSelectors) { host = cloneRoot.querySelector(sel); if(host) break; }
    if (!host) host = cloneRoot;
    
    cont = document.createElement('div');
    cont.className = 'post-uploads for-youtube';
    cont.style.marginTop = "24px";
    host.appendChild(cont);
  }
  
  // Vyčistíme původní "rozbité" galerie pro plnou lokální náhradu
  cloneRoot.querySelectorAll('.post-uploads:not(.for-youtube)').forEach(n => n.remove());
  cont.innerHTML = '';
  
  images.forEach(g => {
    const p = document.createElement('div');
    p.className = 'preview';
    
    const mediaContainer = document.createElement('div');
    mediaContainer.className = 'preview__media';
    mediaContainer.style.marginBottom = "8px";
    
    const uri = encodeURI(g.localName);
    const ext = g.localName.split('.').pop().toLowerCase();
    
    // Rozlišení HTML tagů podle typu média
    if (['mp4', 'webm', 'ogg', 'mov', 'm4v'].includes(ext)) {
      const vid = document.createElement('video');
      vid.controls = true;
      vid.style.maxWidth = "100%";
      vid.style.maxHeight = "600px";
      const srcEl = document.createElement('source');
      srcEl.src = uri;
      srcEl.type = `video/${ext === 'mov' ? 'quicktime' : ext}`;
      vid.appendChild(srcEl);
      mediaContainer.appendChild(vid);
    } else if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) {
      const aud = document.createElement('audio');
      aud.controls = true;
      aud.src = uri;
      aud.style.width = "100%";
      mediaContainer.appendChild(aud);
    } else if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'avif', 'bmp'].includes(ext)) {
      const a = document.createElement('a');
      a.className = 'preview__link';
      a.href = uri;
      const img = document.createElement('img');
      img.src = uri;
      img.alt = g.localName;
      a.appendChild(img);
      mediaContainer.appendChild(a);
    } else {
      const div = document.createElement('div');
      div.style.padding = "30px 20px";
      div.style.background = "#222";
      div.style.border = "1px dashed #444";
      div.style.textAlign = "center";
      div.style.borderRadius = "6px";
      div.textContent = `📁 Nespecifikovaný soubor`;
      mediaContainer.appendChild(div);
    }

    const name = document.createElement('div');
    name.className = 'preview__filename';
    name.innerHTML = `<a href="${uri}">${g.localName}</a>`;
    
    p.append(mediaContainer, name);
    cont.appendChild(p);
  });
}

async function scrapePost(postId) {
  // Stáhnout stránku postu
  const url = `/posts/${postId}`;
  const res = await fetch(url);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Název
  const dt = resolveDateFromEl(doc);
  let baseName = `post_${postId}`;
  if (dt) {
    const pad = n => String(n).padStart(2, '0');
    baseName = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}_${pad(dt.getHours())}-${pad(dt.getMinutes())}`;
  }

  // Zkusíme extrahovat galerie z atributu window / data-gallery
  const items = [];
  const galleries = doc.querySelectorAll('[data-gallery]');
  galleries.forEach(n => {
    try {
      const arr = JSON.parse(n.getAttribute('data-gallery') || '[]');
      if (Array.isArray(arr)) arr.forEach(it => { if(it.url || it.id) items.push(it) });
    } catch {}
  });

  // Někdy data nejsou ve viditelném doc, ale lze je získat přes API uploads
  if (!items.length) {
    try {
      const uRes = await fetch(`/posts/${postId}/uploads`);
      const uHtml = await uRes.text();
      const uDoc = new DOMParser().parseFromString(uHtml, 'text/html');
      const g = uDoc.querySelectorAll('[data-gallery]');
      g.forEach(n => {
        try {
          const arr = JSON.parse(n.getAttribute('data-gallery') || '[]');
          if (Array.isArray(arr)) arr.forEach(it => { if(it.url || it.id) items.push(it) });
        } catch {}
      });
    } catch {}
  }

  // Vyřešení originálních URL
  const images = [];
  let idx = 1;
  for (const it of items) {
    let rawUrl = it.url || `/post_uploads/${it.id}`;
    let finalUrl = rawUrl;
    
    // Zkusit fetch a najít orig link: "gallery-image_original_link"
    if (!/amazonaws|b-cdn\.net|cloudfront/.test(finalUrl)) {
      try {
         const iRes = await fetch(rawUrl);
         const iHtml = await iRes.text();
         const iDoc = new DOMParser().parseFromString(iHtml, 'text/html');
         const a = iDoc.querySelector('a.gallery-image_original_link');
         if (a && a.href) finalUrl = new URL(a.href, url).href;
      } catch {}
    }
    
    const nameRef = it.original_filename || finalUrl;
    const cleanFn = nameRef.split('?')[0];
    const m = cleanFn.match(/\.([a-z0-9]+)$/i);
    const ext = m ? m[1].toLowerCase() : 'file';
    const localName = `${baseName}_item${idx}.${ext}`;
    
    finalUrl = new URL(finalUrl, window.location.origin).href;
    
    images.push({ url: finalUrl, localName });
    idx++;
  }

  // Sestavení a pročištění zkopírované struktury HTML
  const headHTML = await buildHeadFrom(doc);
  const rootSelectors = ['.section.for-single_post', '.for-single_post.section', '.post.wrapper.is-single', '.post.wrapper'];
  let root = null;
  for (const sel of rootSelectors) { root = doc.querySelector(sel); if(root) break; }
  if (!root) root = doc.body;

  const clone = root.cloneNode(true);
  clone.querySelectorAll('.post-warning_mature, .comments-row.for-new_comment.for-single_post, .comments-row.for-new_comment, .ssg-wrap').forEach(n => n.remove());

  if (images.length) {
    injectIntoForYouTube(clone, images);
  }
  const htmlContent = `<!DOCTYPE html><html lang="cs"><head>${headHTML}</head><body><div class="ssx-center">${clone.outerHTML}</div></body></html>`;

  // Vytvoření chunku pro celkový master profil
  const feedImages = images.map(i => ({ ...i, localName: `${baseName}/${i.localName}` }));
  const feedClone = root.cloneNode(true);
  feedClone.querySelectorAll('.post-warning_mature, .comments-row.for-new_comment.for-single_post, .comments-row.for-new_comment, .ssg-wrap').forEach(n => n.remove());
  if (feedImages.length) {
    injectIntoForYouTube(feedClone, feedImages);
  }
  const feedChunk = feedClone.outerHTML;

  return {
    baseName,
    htmlContent,
    images,
    feedChunk,
    headHTML
  };
}

/* ================== PŘIJÍMÁNÍ ZPRÁV ================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'GET_AUTHOR_INFO') {
    sendResponse(getAuthorInfo());
    return true;
  } else if (msg.action === 'COLLECT_POST_IDS') {
    collectPostIds(msg.limit, msg.dateFrom, msg.dateTo).then(res => {
      sendResponse(res);
    });
    return true; // async
  } else if (msg.action === 'SCRAPE_POST') {
    scrapePost(msg.id).then(res => {
      sendResponse(res);
    });
    return true;
  }
});


/* ================== INTEGROVANÝ SORTING (UI ve Feed stránce) ================== */

let currentOrder = localStorage.getItem('ssPostSortOrder') || 'desc';

function createSortControlsContainer() {
  const container = document.querySelector('.posts[data-view="app#infinite_scroll"]');
  if (!container || document.getElementById('ss-sort-controls')) return;

  const controls = document.createElement('div');
  controls.id = 'ss-sort-controls';
  controls.style.cssText = `
    margin: 10px 0; display: flex; justify-content: flex-end; gap: 8px; align-items: center;
    background: transparent; padding: 8px 12px; border-radius: 6px; font-size: 13px;
  `;

  controls.innerHTML = `
    <span style="opacity: 0.8">Třídění v DOMu:</span>
    <button type="button" class="ss-sort-btn" data-order="desc" style="${btnStyle(currentOrder === 'desc')}">Nejnovější</button>
    <button type="button" class="ss-sort-btn" data-order="asc" style="${btnStyle(currentOrder === 'asc')}">Nejstarší</button>
    <button type="button" class="ss-sort-btn" data-action="load-all" style="${btnStyle(false)}">Načíst vše</button>
  `;

  container.parentNode.insertBefore(controls, container);

  controls.addEventListener('click', async (e) => {
    const btn = e.target.closest('.ss-sort-btn');
    if (!btn) return;
    
    const action = btn.dataset.action;
    if (action === 'load-all') {
      const b = btn;
      b.textContent = 'Načítání...';
      b.disabled = true;
      b.style.opacity = '0.5';
      await performLoadAll(container);
      b.textContent = 'Načíst vše';
      b.disabled = false;
      b.style.opacity = '1';
      return;
    }

    const order = btn.dataset.order;
    if(!order) return;
    
    localStorage.setItem('ssPostSortOrder', order);
    currentOrder = order;
    
    controls.querySelectorAll('.ss-sort-btn[data-order]').forEach(b => {
      b.style.cssText = btnStyle(b.dataset.order === currentOrder);
    });

    sortPostsInDOM(container, currentOrder);
  });
  
  // Attach observer if new posts load
  const postsObserver = new MutationObserver((mutations) => {
    let added = mutations.some(m => Array.from(m.addedNodes).some(n => n.nodeType === 1 && n.classList.contains('post')));
    if (added) {
      postsObserver.disconnect();
      sortPostsInDOM(container, currentOrder);
      postsObserver.observe(container, { childList: true });
    }
  });
  postsObserver.observe(container, { childList: true });
}

async function performLoadAll(container) {
  let stagnant = 0;
  let iterations = 0;
  let lastCount = container.querySelectorAll('.post[data-id]').length;
  const maxIterations = 200;

  while (iterations < maxIterations) {
    const more = container.querySelector('.posts-more[data-role="infinite_scroll-next_page"]');
    if (!more) break;

    more.click();
    await sleep(1500);

    const newCount = container.querySelectorAll('.post[data-id]').length;
    if (newCount <= lastCount) {
      stagnant++;
      if (stagnant >= 3) break;
    } else {
      stagnant = 0;
      lastCount = newCount;
    }
    iterations++;
  }
  sortPostsInDOM(container, currentOrder);
}

function btnStyle(active) {
  return `padding: 4px 10px; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; background: ${active ? '#bb86fc' : '#222'}; color: ${active ? '#000' : '#fff'}; font-weight: ${active ? 'bold' : 'normal'};`;
}

function sortPostsInDOM(container, order) {
  const posts = Array.from(container.querySelectorAll('.post[data-id]'));
  if (posts.length < 2) return;
  posts.sort((a, b) => {
    const idA = parseInt(a.dataset.id || '0', 10);
    const idB = parseInt(b.dataset.id || '0', 10);
    return order === 'asc' ? idA - idB : idB - idA;
  });
  const refNode = container.querySelector('[data-role="infinite_scroll-next_page"]');
  posts.forEach(post => container.insertBefore(post, refNode));
}

// Inicializace sorting UI
function initContent() {
  createSortControlsContainer();
  new MutationObserver(() => {
    if (!document.getElementById('ss-sort-controls')) createSortControlsContainer();
  }).observe(document.body, { childList: true, subtree: true });
}

initContent();
