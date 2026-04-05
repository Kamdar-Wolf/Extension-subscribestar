// popup.js
document.addEventListener('DOMContentLoaded', async () => {
  const els = {
    newOnly: document.getElementById('new_only'),
    limit: document.getElementById('limit'),
    dateFrom: document.getElementById('date_from'),
    dateTo: document.getElementById('date_to'),
    btnDetail: document.getElementById('btn_detail'),
    btnList: document.getElementById('btn_list'),
    btnStop: document.getElementById('btn_stop'),
    btnClearDate: document.getElementById('clear_date'),
    statusText: document.getElementById('status_text'),
    progressWrapper: document.getElementById('progress_wrapper'),
    progressBar: document.getElementById('progress_bar'),
    logBox: document.getElementById('log_box'),
  };

  // Load config
  const config = await chrome.storage.local.get(['newOnly', 'limit', 'dateFrom', 'dateTo']);
  els.newOnly.checked = config.newOnly !== false;
  els.limit.value = config.limit || 20;
  els.dateFrom.value = config.dateFrom || '';
  els.dateTo.value = config.dateTo || '';

  // Save config on change
  const saveConfig = () => {
    chrome.storage.local.set({
      newOnly: els.newOnly.checked,
      limit: parseInt(els.limit.value, 10) || 20,
      dateFrom: els.dateFrom.value,
      dateTo: els.dateTo.value,
    });
  };

  ['change', 'input'].forEach(evt => {
    els.newOnly.addEventListener(evt, saveConfig);
    els.limit.addEventListener(evt, saveConfig);
    els.dateFrom.addEventListener(evt, saveConfig);
    els.dateTo.addEventListener(evt, saveConfig);
  });

  els.btnClearDate.addEventListener('click', () => {
    els.dateFrom.value = '';
    els.dateTo.value = '';
    saveConfig();
  });

  const getActiveTab = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  };

  const logMessage = (msg) => {
    const d = document.createElement('div');
    d.textContent = `[${new Date().toLocaleTimeString('cs-CZ')}] ${msg}`;
    els.logBox.appendChild(d);
    els.logBox.scrollTop = els.logBox.scrollHeight;
  };

  const updateUIState = (state) => {
    if (state.isRunning) {
      els.btnDetail.classList.add('hidden');
      els.btnList.classList.add('hidden');
      els.btnStop.classList.remove('hidden');
      els.progressWrapper.classList.remove('hidden');
    } else {
      els.btnDetail.classList.remove('hidden');
      els.btnList.classList.remove('hidden');
      els.btnStop.classList.add('hidden');
      els.progressWrapper.classList.add('hidden');
    }
    
    if (state.statusText) {
      els.statusText.textContent = state.statusText;
    }
    
    if (state.progress !== undefined) {
      els.progressBar.style.width = `${state.progress}%`;
    }
  };

  // Connect to background script
  const port = chrome.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_UPDATE') {
      updateUIState(msg.state);
    } else if (msg.type === 'LOG') {
      logMessage(msg.text);
    }
  });

  // Request initial state
  port.postMessage({ action: 'GET_STATE' });

  // Button actions
  els.btnDetail.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.runtime.sendMessage({ 
      action: 'START_DETAIL', 
      tabId: tab.id,
      tabUrl: tab.url
    });
  });

  els.btnList.addEventListener('click', async () => {
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.runtime.sendMessage({ 
      action: 'START_LIST', 
      tabId: tab.id, 
      tabUrl: tab.url 
    });
  });

  els.btnStop.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'STOP' });
  });

  chrome.runtime.onMessage.addListener((msg) => {
    // Also listen to one-off messages if needed, but port is better for live updates
  });
});
