let state = {
  isRunning: false,
  statusText: 'Připraveno',
  progress: 0,
  shouldStop: false
};

const ports = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'popup') {
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener((msg) => {
      if (msg.action === 'GET_STATE') {
        port.postMessage({ type: 'STATE_UPDATE', state });
      }
    });
  }
});

function broadcastState() {
  for (const p of ports) {
    p.postMessage({ type: 'STATE_UPDATE', state });
  }
}

function broadcastLog(text) {
  for (const p of ports) {
    p.postMessage({ type: 'LOG', text });
  }
  console.log(text);
}

function updateState(updates) {
  Object.assign(state, updates);
  broadcastState();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wrapper pro zprávy do content scriptu
function askTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        if (resp && resp.error) reject(new Error(resp.error));
        else resolve(resp);
      }
    });
  });
}

function downloadFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, conflictAction: 'overwrite' }, (downloadId) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      // Pro úplnou spolehlivost by se dalo naslouchat na chrome.downloads.onChange
      // ale pro jednoduchost považujeme za vyřešené při startu (stahuje se na pozadí prohlížeče)
      resolve(downloadId);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'START_DETAIL') {
    startDetail(msg.tabId, msg.tabUrl).catch(e => {
      broadcastLog(`Chyba: ${e.message}`);
      updateState({ isRunning: false, statusText: 'Chyba' });
    });
  } else if (msg.action === 'START_LIST') {
    startList(msg.tabId, msg.tabUrl).catch(e => {
      broadcastLog(`Chyba: ${e.message}`);
      updateState({ isRunning: false, statusText: 'Chyba' });
    });
  } else if (msg.action === 'STOP') {
    if (state.isRunning) {
      state.shouldStop = true;
      updateState({ statusText: 'Zastavuji se...' });
      broadcastLog('Zastavuji operaci dle požadavku.');
    }
  }
});

async function processPost(tabId, postId, authorName, forceNew = true) {
  if (state.shouldStop) throw new Error("STOPPED");
  
  // Kontrola historie z chrome.storage
  const store = await chrome.storage.local.get('download_history');
  const history = store.download_history || {};
  
  if (forceNew && history[postId]) {
    broadcastLog(`Přeskakuji #${postId} - již uschováno.`);
    return;
  }

  broadcastLog(`Zpracovávám #${postId}...`);
  updateState({ statusText: `Zpracovávám post #${postId}` });

  // Zavoláme content.js
  const data = await askTab(tabId, { action: 'SCRAPE_POST', id: postId });
  if (!data) throw new Error("Content script neodpověděl s daty.");

  if (data.skipped) {
    broadcastLog(`Přeskočeno #${postId} - ${data.reason}`);
    return;
  }

  const basePath = `SubscribeStar/${authorName}/${data.baseName}`;
  
  // Stáhnout obrázky
  for (const img of data.images) {
    if (state.shouldStop) throw new Error("STOPPED");
    try {
      await downloadFile(img.url, `${basePath}/${img.localName}`);
      broadcastLog(`-> ${img.localName}`);
    } catch(err) {
      broadcastLog(`Chyba stahování obrázku ${img.localName}: ${err.message}`);
    }
    await sleep(200);
  }

  // Uložit HTML (přes Data URL blob)
  if (data.htmlContent) {
    const b64 = btoa(unescape(encodeURIComponent(data.htmlContent)));
    const dataUrl = `data:text/html;charset=utf-8;base64,${b64}`;
    await downloadFile(dataUrl, `${basePath}/post_${postId}.html`);
    broadcastLog(`-> HTML uloženo`);
  }

  // Uložit do historie
  history[postId] = Date.now();
  await chrome.storage.local.set({ download_history: history });

  return { feedChunk: data.feedChunk, headHTML: data.headHTML };
}

async function startDetail(tabId, tabUrl) {
  const m = tabUrl.match(/\/posts\/(\d+)/);
  if (!m) {
    updateState({ statusText: 'Nejsi na detailu postu /posts/{id}' });
    broadcastLog('Chyba: Otevři konkrétní detail postu.');
    return;
  }
  
  const postId = m[1];
  
  updateState({ isRunning: true, shouldStop: false, progress: 0 });
  broadcastLog(`Začínám detail #${postId}`);
  
  try {
    const info = await askTab(tabId, { action: 'GET_AUTHOR_INFO' });
    await processPost(tabId, postId, info.author, false);
    updateState({ progress: 100, statusText: 'Hotovo' });
    broadcastLog('Vše hotovo.');
  } finally {
    updateState({ isRunning: false });
  }
}

async function startList(tabId, tabUrl) {
  updateState({ isRunning: true, shouldStop: false, progress: 0, statusText: 'Načítám ID příspěvků...' });
  broadcastLog('Skenuji aktuální stránku pro příspěvky...');

  try {
    const config = await chrome.storage.local.get(['newOnly', 'limit', 'dateFrom', 'dateTo']);
    const limit = config.limit || 20;

    const reqData = await askTab(tabId, { 
      action: 'COLLECT_POST_IDS', 
      limit: limit,
      dateFrom: config.dateFrom,
      dateTo: config.dateTo
    });

    const { ids, author } = reqData;
    broadcastLog(`Nalezeno ${ids.length} postů vyhovujících filtru.`);

    let allFeedChunks = [];
    let masterHeadHTML = '';

    for (let i = 0; i < ids.length; i++) {
      if (state.shouldStop) break;
      updateState({ progress: Math.floor((i / ids.length) * 100) });
      
      try {
        const postData = await processPost(tabId, ids[i], author, config.newOnly !== false);
        if (postData && postData.feedChunk) {
           allFeedChunks.push(postData.feedChunk);
           if (!masterHeadHTML) masterHeadHTML = postData.headHTML;
        }
      } catch (err) {
        if (err.message === "STOPPED") break;
        broadcastLog(`Chyba u postu ${ids[i]}: ${err.message}`);
      }
    }

    if (allFeedChunks.length > 0 && !state.shouldStop) {
      updateState({ statusText: 'Generuji Master Feed...' });
      const masterFeed = `<!DOCTYPE html><html lang="cs"><head>${masterHeadHTML}</head><body><div class="ssx-center posts">${allFeedChunks.join('<hr style="border: 0; border-top: 1px solid #333; margin: 40px 0;">')}</div></body></html>`;
      const b64 = btoa(unescape(encodeURIComponent(masterFeed)));
      const dataUrl = `data:text/html;charset=utf-8;base64,${b64}`;
      await downloadFile(dataUrl, `SubscribeStar/${author}/_Kompletni_Profil.html`);
      broadcastLog(`Master Feed stránka vytvořena.`);
    }

    if (state.shouldStop) {
      updateState({ statusText: 'Zastaveno.' });
    } else {
      updateState({ progress: 100, statusText: 'Kompletní' });
      broadcastLog('Hromadné stahování dokončeno.');
    }
  } finally {
    updateState({ isRunning: false });
  }
}
