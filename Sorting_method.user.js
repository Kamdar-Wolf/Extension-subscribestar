// ==UserScript==
// @name           SubscribeStar: Sorting method (newer / older)
// @namespace     https://github.com/Kamdar-Wolf/Extension-subscribestar
// @version        1.4.1
// @description cs Přidá přepínač řazení (nejnovější ↔ nejstarší) na feed a stránky tvůrců na SubscribeStar.adult a umí na požádání natáhnout všechny stránky s datumovým filtrem.
// @description    Adds a sorting switch (newest ↔ oldest) to feeds and creator pages on SubscribeStar.adult and can pull up all pages with a date filter on request.
// @description    Extract feeds from the site
// @author         Kamdar Wolf
// @copyright      2025-2026, Kamdar Wolf
// @license        Proprietary - internal use only
// @source         https://raw.githubusercontent.com/Kamdar-Wolf/Extension-subscribestar/master/Sorting_method.user.js
// @supportURL     https://github.com/Kamdar-Wolf/Extension-subscribestar/issues
// @icon           https://ss-staging-assets.s3-us-west-1.amazonaws.com/brand/ss_logomark.png
// @icon64         https://ss-staging-assets.s3-us-west-1.amazonaws.com/brand/ss_logomark.png
// @homepageURL    https://github.com/Kamdar-Wolf/Extension-subscribestar
// @updateURL        https://raw.githubusercontent.com/Kamdar-Wolf/Extension-subscribestar/master/Sorting_method.user.js
// @downloadURL      https://raw.githubusercontent.com/Kamdar-Wolf/Extension-subscribestar/master/Sorting_method.user.js
// @match          https://subscribestar.adult/feed*
// @match          https://subscribestar.adult/*
// @run-at         document-idle
// @tag           SubscribeStar
// @grant          none
// ==/UserScript==

(function () {
    'use strict';

    let currentOrder = loadOrder();
    let postsObserver = null;
    let autoLoading = false;
    let cancelLoading = false;
    let dateFilter = loadDateFilter();

    const STORAGE_KEY_ORDER = 'ssPostSortOrder';
    const STORAGE_KEY_FILTER = 'ssPostDateFilter';

    function loadOrder() {
        try {
            const v = localStorage.getItem(STORAGE_KEY_ORDER);
            return (v === 'asc' || v === 'desc') ? v : 'desc';
        } catch (e) {
            return 'desc';
        }
    }

    function saveOrder(order) {
        currentOrder = order;
        try {
            localStorage.setItem(STORAGE_KEY_ORDER, order);
        } catch (e) {
            // ignoruj chybu storage
        }
    }

    function loadDateFilter() {
        try {
            const v = localStorage.getItem(STORAGE_KEY_FILTER);
            if (!v) return { from: null, to: null };
            const parsed = JSON.parse(v);
            return {
                from: parsed.from || null,
                to: parsed.to || null
            };
        } catch (e) {
            return { from: null, to: null };
        }
    }

    function saveDateFilter(filter) {
        dateFilter = filter;
        try {
            localStorage.setItem(STORAGE_KEY_FILTER, JSON.stringify(filter));
        } catch (e) {
            // ignoruj chybu storage
        }
    }

    function injectStyles() {
        if (document.getElementById('ss-sort-controls-style')) return;

        const style = document.createElement('style');
        style.id = 'ss-sort-controls-style';
        style.textContent = `
            #ss-sort-controls {
                margin: 0 0 8px 0;
                display: flex;
                justify-content: flex-end;
                gap: 4px;
                font-size: 13px;
                align-items: center;
                flex-wrap: wrap;
            }
            #ss-sort-controls .ss-sort-label {
                opacity: 0.8;
            }
            #ss-sort-controls .ss-sort-btn {
                padding: 2px 6px;
                border-radius: 3px;
                border: 1px solid rgba(255,255,255,0.25);
                background: rgba(0,0,0,0.35);
                color: inherit;
                cursor: pointer;
                font-size: 12px;
            }
            html:not(.dark) #ss-sort-controls .ss-sort-btn {
                background: #f5f5f5;
                border-color: #ccc;
            }
            #ss-sort-controls .ss-sort-btn.is-active {
                font-weight: 600;
                box-shadow: 0 0 0 1px #f48;
            }
            #ss-sort-controls .ss-sort-btn.ss-stop-btn {
                background: #f44336;
                color: white;
                border-color: #d32f2f;
                display: none;
            }
            #ss-sort-controls .ss-sort-btn.ss-stop-btn.is-loading {
                display: inline-block;
            }
            #ss-sort-controls .ss-sort-status {
                margin-left: 8px;
                font-size: 11px;
                opacity: 0.7;
            }
            #ss-sort-controls .ss-date-filter {
                display: flex;
                gap: 4px;
                align-items: center;
                margin-left: 8px;
                padding-left: 8px;
                border-left: 1px solid rgba(255,255,255,0.2);
            }
            html:not(.dark) #ss-sort-controls .ss-date-filter {
                border-left-color: #ccc;
            }
            #ss-sort-controls .ss-date-input {
                padding: 2px 4px;
                border-radius: 3px;
                border: 1px solid rgba(255,255,255,0.25);
                background: rgba(0,0,0,0.2);
                color: inherit;
                font-size: 11px;
                width: 110px;
            }
            html:not(.dark) #ss-sort-controls .ss-date-input {
                background: white;
                border-color: #ccc;
            }
            #ss-sort-controls .ss-date-sep {
                opacity: 0.6;
            }
        `;
        document.head.appendChild(style);
    }

    function findPostsContainer() {
        return document.querySelector('.posts[data-view="app#infinite_scroll"]');
    }

    /* ====== Datum parsing ====== */
    function parseCZ(stamp) {
        if (!stamp) return null;

        const normalized = stamp.trim().replace(/\s+/g, ' ');

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
                mon = normalizeMonth(m[1]);
                day = parseInt(m[2], 10);
                year = m[3];
                hour = parseInt(m[4], 10);
                min = m[5];
                const ap = (m[6] || '').toLowerCase();
                if (ap === 'odpoledne' && hour < 12) hour += 12;
                if (ap === 'dopoledne' && hour === 12) hour = 0;
            } else {
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

        const cleaned = stamp
            .replace(/\s+v\s+/i, ' ')
            .replace(/\s+at\s+/i, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const dt2 = new Date(cleaned);
        return isNaN(dt2.getTime()) ? null : dt2;
    }

    function getPostDate(postElement) {
        if (!postElement) return null;

        const dateSelectors = [
            '.section-title_date', '.post-date', '.post-date a',
            'time', '[data-role="timestamp"]', '[datetime]'
        ];

        for (const sel of dateSelectors) {
            const stampEl = postElement.querySelector(sel);
            if (!stampEl) continue;

            const raw = stampEl.getAttribute('datetime') ||
                stampEl.getAttribute('data-datetime') ||
                stampEl.textContent || '';

            const dt = parseStampToDate(raw);
            if (dt) return dt;
        }

        return null;
    }

    function parseDateInput(value, endOfDay) {
        if (!value) return null;
        const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
        if (endOfDay) return new Date(y, mo - 1, d, 23, 59, 59, 999);
        return new Date(y, mo - 1, d, 0, 0, 0, 0);
    }

    function buildDateFilter(fromStr, toStr) {
        const from = parseDateInput(fromStr || '', false);
        const to = parseDateInput(toStr || '', true);
        if (!from && !to) return null;
        if (from && to && to.getTime() < from.getTime()) return null;
        return { from, to };
    }

    function dateMatchesFilter(dt, filter) {
        if (!filter || (!filter.from && !filter.to)) return true;
        if (!dt) return true; // neznámé datum nepřeskakujeme agresivně
        const t = dt.getTime();
        if (filter.from && t < filter.from.getTime()) return false;
        if (filter.to && t > filter.to.getTime()) return false;
        return true;
    }

    function postMatchesFilter(postElement) {
        if (!dateFilter || (!dateFilter.from && !dateFilter.to)) return true;
        const dt = getPostDate(postElement);
        const filterObj = buildDateFilter(dateFilter.from, dateFilter.to);
        return dateMatchesFilter(dt, filterObj);
    }

    function formatFilterForDisplay() {
        if (!dateFilter || (!dateFilter.from && !dateFilter.to)) return '';
        const parts = [];
        if (dateFilter.from) parts.push(`od ${dateFilter.from}`);
        if (dateFilter.to) parts.push(`do ${dateFilter.to}`);
        return parts.join(' ');
    }

    /* ====== UI ====== */
    function createSortControls(container) {
        if (!container) return;
        if (document.getElementById('ss-sort-controls')) return;

        const controls = document.createElement('div');
        controls.id = 'ss-sort-controls';
        controls.innerHTML = `
            <span class="ss-sort-label">Řazení:</span>
            <button type="button" class="ss-sort-btn" data-order="desc">
                Nejnovější → Nejstarší
            </button>
            <button type="button" class="ss-sort-btn" data-order="asc">
                Nejstarší → Nejnovější
            </button>
            <button type="button" class="ss-sort-btn" data-action="load-all">
                Načíst vše
            </button>
            <button type="button" class="ss-sort-btn ss-stop-btn" data-action="stop">
                ZASTAVIT
            </button>
            <div class="ss-date-filter">
                <span class="ss-sort-label">Filtr:</span>
                <input type="date" class="ss-date-input" id="ss-date-from" value="${dateFilter.from || ''}" placeholder="Od">
                <span class="ss-date-sep">→</span>
                <input type="date" class="ss-date-input" id="ss-date-to" value="${dateFilter.to || ''}" placeholder="Do">
                <button type="button" class="ss-sort-btn" data-action="apply-filter">Použít</button>
                <button type="button" class="ss-sort-btn" data-action="clear-filter">Zrušit</button>
            </div>
            <span id="ss-sort-status" class="ss-sort-status"></span>
        `;

        const parent = container.parentNode;
        if (parent) {
            parent.insertBefore(controls, container);
        }

        controls.addEventListener('click', function (e) {
            const btn = e.target.closest('.ss-sort-btn');
            if (!btn) return;

            const action = btn.dataset.action;

            if (action === 'load-all') {
                if (!autoLoading) {
                    cancelLoading = false;
                    loadAllPages(container);
                } else {
                    cancelLoading = true;
                }
                return;
            }

            if (action === 'stop') {
                cancelLoading = true;
                return;
            }

            if (action === 'apply-filter') {
                applyDateFilter();
                return;
            }

            if (action === 'clear-filter') {
                clearDateFilter();
                return;
            }

            const order = btn.dataset.order;
            if (order !== 'asc' && order !== 'desc') return;

            saveOrder(order);
            updateButtonsUI(order);
            sortPosts(container, order);
        });

        updateButtonsUI(currentOrder);
    }

    function applyDateFilter() {
        const fromInput = document.getElementById('ss-date-from');
        const toInput = document.getElementById('ss-date-to');

        if (!fromInput || !toInput) return;

        const fromVal = fromInput.value || null;
        const toVal = toInput.value || null;

        const testFilter = buildDateFilter(fromVal, toVal);
        if (!testFilter && (fromVal || toVal)) {
            setStatus('Neplatný datumový rozsah (od > do)');
            setTimeout(() => setStatus(''), 2000);
            return;
        }

        saveDateFilter({ from: fromVal, to: toVal });
        setStatus(`Filtr nastaven: ${formatFilterForDisplay() || 'bez filtru'}`);
        setTimeout(() => setStatus(''), 2000);

        // Aplikuj filtr na viditelné posty
        const container = findPostsContainer();
        if (container) {
            applyFilterToPosts(container);
        }
    }

    function clearDateFilter() {
        saveDateFilter({ from: null, to: null });

        const fromInput = document.getElementById('ss-date-from');
        const toInput = document.getElementById('ss-date-to');
        if (fromInput) fromInput.value = '';
        if (toInput) toInput.value = '';

        setStatus('Filtr zrušen');
        setTimeout(() => setStatus(''), 2000);

        // Zobraz všechny posty
        const container = findPostsContainer();
        if (container) {
            const posts = container.querySelectorAll('.post[data-id]');
            posts.forEach(post => {
                post.style.display = '';
            });
        }
    }

    function applyFilterToPosts(container) {
        if (!container) return;

        const posts = container.querySelectorAll('.post[data-id]');
        let visibleCount = 0;
        let hiddenCount = 0;

        posts.forEach(post => {
            if (postMatchesFilter(post)) {
                post.style.display = '';
                visibleCount++;
            } else {
                post.style.display = 'none';
                hiddenCount++;
            }
        });

        if (hiddenCount > 0) {
            setStatus(`Zobrazeno: ${visibleCount}, Skryto: ${hiddenCount}`);
        }
    }

    function updateButtonsUI(order) {
        const buttons = document.querySelectorAll('#ss-sort-controls .ss-sort-btn[data-order]');
        buttons.forEach(btn => {
            if (btn.dataset.order === order) {
                btn.classList.add('is-active');
            } else {
                btn.classList.remove('is-active');
            }
        });
    }

    function updateLoadAllButton(isRunning) {
        const btn = document.querySelector('#ss-sort-controls .ss-sort-btn[data-action="load-all"]');
        const stopBtn = document.querySelector('#ss-sort-controls .ss-stop-btn');

        if (!btn) return;

        if (isRunning) {
            btn.textContent = 'Načítání...';
            btn.classList.add('is-active');
            btn.disabled = true;
            if (stopBtn) stopBtn.classList.add('is-loading');
        } else {
            btn.textContent = 'Načíst vše';
            btn.classList.remove('is-active');
            btn.disabled = false;
            if (stopBtn) stopBtn.classList.remove('is-loading');
        }
    }

    function setStatus(text) {
        const statusEl = document.getElementById('ss-sort-status');
        if (!statusEl) return;
        statusEl.textContent = text || '';
    }

    /* ====== Řazení a načítání ====== */
    function sortPosts(container, order) {
        if (!container) return;

        const posts = Array.from(container.querySelectorAll('.post[data-id]'));
        if (posts.length < 2) return;

        posts.sort((a, b) => {
            const idA = parseInt(a.dataset.id || '0', 10);
            const idB = parseInt(b.dataset.id || '0', 10);
            if (isNaN(idA) || isNaN(idB)) return 0;

            return order === 'asc'
                ? idA - idB
                : idB - idA;
        });

        const more = container.querySelector('[data-role="infinite_scroll-next_page"]');
        const refNode = more || null;

        posts.forEach(post => {
            container.insertBefore(post, refNode);
        });

        // Po seřazení aplikuj filtr
        applyFilterToPosts(container);
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    async function loadAllPages(container) {
        if (!container) return;
        if (autoLoading) return;

        autoLoading = true;
        cancelLoading = false;
        updateLoadAllButton(true);

        try {
            const filterLabel = formatFilterForDisplay();
            setStatus(`Načítám všechny příspěvky${filterLabel ? ` (${filterLabel})` : ''}...`);

            let lastCount = container.querySelectorAll('.post[data-id]').length;
            let stagnant = 0;
            let iterations = 0;
            const maxIterations = 200;

            while (!cancelLoading && iterations < maxIterations) {
                const more = container.querySelector('.posts-more[data-role="infinite_scroll-next_page"]');
                if (!more) {
                    setStatus('Načteny všechny dostupné příspěvky.');
                    break;
                }

                more.click();
                await sleep(1500);

                const newCount = container.querySelectorAll('.post[data-id]').length;

                if (newCount <= lastCount) {
                    stagnant++;
                    if (stagnant >= 3) {
                        setStatus('Načteny všechny dostupné příspěvky.');
                        break;
                    }
                } else {
                    stagnant = 0;
                    lastCount = newCount;

                    // Aplikuj filtr na nově načtené posty
                    applyFilterToPosts(container);

                    const posts = container.querySelectorAll('.post[data-id]');
                    const visible = Array.from(posts).filter(p => p.style.display !== 'none').length;
                    setStatus(`Načteno: ${newCount} příspěvků (zobrazeno: ${visible})`);
                }

                iterations++;
            }

            if (cancelLoading) {
                setStatus('Načítání zastaveno uživatelem.');
            }

            await sleep(2000);
            setStatus('');

        } finally {
            autoLoading = false;
            cancelLoading = false;
            updateLoadAllButton(false);
        }
    }

    function attachPostsObserver(container) {
        if (!container) return;

        if (postsObserver) {
            postsObserver.disconnect();
        }

        postsObserver = new MutationObserver(mutations => {
            let addedPost = false;
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === 1 && node.classList.contains('post')) {
                        addedPost = true;
                        break;
                    }
                }
                if (addedPost) break;
            }

            if (addedPost) {
                postsObserver.disconnect();
                sortPosts(container, currentOrder);
                postsObserver.observe(container, { childList: true });
            }
        });

        postsObserver.observe(container, { childList: true });
    }

    function setup(container) {
        injectStyles();
        createSortControls(container);
        attachPostsObserver(container);

        // Aplikuj uložený filtr při načtení stránky
        if (dateFilter && (dateFilter.from || dateFilter.to)) {
            applyFilterToPosts(container);
        }
    }

    function init() {
        const container = findPostsContainer();
        if (container) {
            setup(container);
            return;
        }

        const docObserver = new MutationObserver((mutations, obs) => {
            const c = findPostsContainer();
            if (c) {
                obs.disconnect();
                setup(c);
            }
        });

        docObserver.observe(document.documentElement || document.body, {
            childList: true,
            subtree: true
        });
    }

    init();
})();
