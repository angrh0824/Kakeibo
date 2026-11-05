'use strict';

const LEGACY_STORAGE_KEY = 'kakeibo.appData.v1';
const THEME_STORAGE_KEY = 'kakeibo.theme.v1';
const SHARED_SYNC_STALE_MS = 15000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ===== アプリデータ =====
const appData = {
    receipts: []
};

// ===== 状態 =====
let currentPage = 'dashboard';
let currentMonth = startOfMonth(new Date());
let charts = {};
let reviewItems = [];
let lastSharedSyncAt = 0;
let sharedSyncPromise = null;
let sharedSyncFailed = false;
let detailImageObjectUrl = '';
let analysisTab = 'trend';
let trendRange = 6;
let historyFilter = 'all';

const PAGE_META = {
    dashboard: { title: 'ホーム', hash: 'home', month: true },
    receipts: { title: '履歴', hash: 'history', month: true },
    analysis: { title: '分析', hash: 'analysis', month: true },
    settings: { title: '設定', hash: 'settings', month: false }
};

// ===== ユーティリティ =====
function startOfMonth(date) {
    return new Date(date.getFullYear(), date.getMonth(), 1);
}

function formatCurrency(amount) {
    const value = Math.round(Number(amount) || 0);
    return (value < 0 ? '−¥' : '¥') + Math.abs(value).toLocaleString('ja-JP');
}

function formatSignedCurrency(amount) {
    const value = Math.round(Number(amount) || 0);
    if (value === 0) return '±¥0';
    return (value > 0 ? '+¥' : '−¥') + Math.abs(value).toLocaleString('ja-JP');
}

function formatCompactYen(value) {
    const number = Math.abs(Number(value) || 0);
    if (number >= 10000) return `${(number / 10000).toFixed(number % 10000 === 0 ? 0 : 1)}万`;
    if (number >= 1000) return `${(number / 1000).toFixed(number % 1000 === 0 ? 0 : 1)}千`;
    return String(Math.round(number));
}

function formatPercent(ratio, { signed = true } = {}) {
    const value = Number(ratio) * 100;
    if (!Number.isFinite(value)) return '—';
    const rounded = Math.abs(value) >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    if (!signed) return `${rounded}%`;
    if (rounded === 0) return '±0%';
    return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`;
}

// 日付だけの文字列はUTCではなく端末のローカル日付として扱う。
function parseDate(value) {
    if (value instanceof Date) return value;
    const text = String(value || '');
    const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12);
    const parsed = new Date(text);
    return parsed;
}

function isValidDate(date) {
    return date instanceof Date && !Number.isNaN(date.getTime());
}

function formatDate(dateStr) {
    const d = parseDate(dateStr);
    if (!isValidDate(d)) return '—';
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatMonthDay(dateStr, { weekday = false } = {}) {
    const d = parseDate(dateStr);
    if (!isValidDate(d)) return '—';
    return `${d.getMonth() + 1}月${d.getDate()}日${weekday ? `（${WEEKDAYS[d.getDay()]}）` : ''}`;
}

function formatMonthLabel(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function monthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dayKey(date) {
    return `${monthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

function daysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function isSameMonth(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function toInputDate(date) {
    return dayKey(date);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

function icon(name, className = '') {
    return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function getItemLineTotal(item) {
    const quantity = Number(item?.quantity) || 1;
    const rawLineTotal = item?.line_total;
    const explicitLineTotal = rawLineTotal === null || rawLineTotal === undefined || rawLineTotal === '' ? NaN : Number(rawLineTotal);
    if (Number.isFinite(explicitLineTotal)) return explicitLineTotal;
    return (Number(item?.price) || 0) * quantity;
}

function getStatusBadge(status) {
    const labels = { validated: '確認済み', review: '要確認', extracted: '読み取り済み', manual: '手入力', recurring: '固定費' };
    return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(labels[status] || status)}</span>`;
}

function generateId() {
    return Date.now() + Math.random().toString(36).slice(2, 11);
}

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function categoryNames() {
    return window.KakeiboSettings?.categoryNames?.() || ['その他'];
}

function categoryDot(name) {
    return `<span class="dot" style="--dot:${window.KakeiboSettings?.colorVar?.(name) || 'var(--gray)'}" aria-hidden="true"></span>`;
}

// ===== 記録の種類 =====
function entryKind(receipt) {
    if (receipt?.virtual || receipt?.entry_type === 'recurring') return 'recurring';
    if (receipt?.entry_type === 'manual' || receipt?.status === 'manual') return 'manual';
    return 'receipt';
}

function isLinkedToRecurring(receipt) {
    return Boolean(window.KakeiboSettings?.linkedRecurringId?.(receipt));
}

function entryTotal(receipt) {
    return Number(receipt?.total) || 0;
}

function categoryTotals(receipt) {
    const totals = {};
    (receipt?.items || []).forEach(item => {
        const category = item.category || 'その他';
        totals[category] = (totals[category] || 0) + getItemLineTotal(item);
    });
    return totals;
}

function dominantCategory(receipt) {
    const totals = Object.entries(categoryTotals(receipt));
    if (!totals.length) return 'その他';
    return totals.sort((a, b) => b[1] - a[1])[0][0];
}

function itemSummary(receipt, limit = 2) {
    const items = (receipt?.items || []).filter(item => item.name);
    if (!items.length) return '';
    if (entryKind(receipt) !== 'receipt' && items.length === 1) return receipt.memo || '';
    const names = items.slice(0, limit).map(item => item.name).join('、');
    return items.length > limit ? `${names} ほか${items.length - limit}点` : names;
}

// ===== データ整形 =====
function normalizePersistedItem(item) {
    if (!item || typeof item !== 'object') return null;
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const price = Math.max(0, Number(item.price) || 0);
    const rawLineTotal = item.line_total;
    const lineTotal = rawLineTotal === null || rawLineTotal === undefined || rawLineTotal === ''
        ? price * quantity
        : Math.max(0, Number(rawLineTotal) || 0);
    return {
        ...item,
        name: String(item.name || '未分類の品目'),
        price,
        quantity,
        category: String(item.category || 'その他'),
        line_total: lineTotal
    };
}

function normalizePersistedReceipt(receipt, index) {
    if (!receipt || typeof receipt !== 'object') return null;
    const items = Array.isArray(receipt.items)
        ? receipt.items.map(normalizePersistedItem).filter(Boolean)
        : [];
    const calculatedTotal = items.reduce((sum, item) => sum + getItemLineTotal(item), 0);
    const total = Number.isFinite(Number(receipt.total)) ? Math.max(0, Number(receipt.total)) : calculatedTotal;
    return {
        ...receipt,
        id: receipt.id ?? `restored-${Date.now()}-${index}`,
        date: receipt.date || new Date().toISOString(),
        store: String(receipt.store || '店名なし'),
        items,
        total,
        memo: String(receipt.memo || ''),
        confidence: Math.min(1, Math.max(0, Number(receipt.confidence) || 0)),
        status: receipt.status || 'validated'
    };
}

function receiptsInMonth(date) {
    return appData.receipts.filter(receipt => {
        const d = parseDate(receipt.date);
        return isValidDate(d) && isSameMonth(d, date);
    });
}

// 実際の記録に、その月の固定費（予定を含む）を加えたもの。
function getMonthEntries(date = currentMonth) {
    const actual = receiptsInMonth(date);
    const recurring = window.KakeiboSettings?.recurringForMonth?.(date.getFullYear(), date.getMonth(), actual) || { entries: [], pending: [] };
    return { actual, virtual: recurring.entries, pending: recurring.pending, all: [...actual, ...recurring.entries] };
}

function getMonthReceipts() {
    return getMonthEntries(currentMonth).all;
}

function sortByDateDesc(entries) {
    return [...entries].sort((a, b) => parseDate(b.date) - parseDate(a.date));
}

function makeDataSnapshot() {
    return {
        schemaVersion: 3,
        source: 'google-cloud-firestore',
        exportedAt: new Date().toISOString(),
        receipts: appData.receipts,
        settings: window.KakeiboSettings?.get?.() || null
    };
}

function applySharedData(candidate) {
    const source = Array.isArray(candidate) ? { receipts: candidate } : candidate;
    if (!source || !Array.isArray(source.receipts)) return false;
    const receipts = source.receipts.map(normalizePersistedReceipt).filter(Boolean);
    appData.receipts.splice(0, appData.receipts.length, ...receipts);
    return true;
}

function clearLegacyLocalData() {
    try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
        localStorage.removeItem(`${LEGACY_STORAGE_KEY}.pre-import`);
    } catch (error) {
        console.warn('旧端末データを削除できませんでした。', error);
    }
}

function householdLabel() {
    return window.KakeiboAuth?.getUser?.()?.household?.name || '';
}

function updateStorageStatus(message = '') {
    const status = document.getElementById('storage-status');
    if (!status) return;
    if (message) {
        status.textContent = message;
        return;
    }
    if (!lastSharedSyncAt) {
        status.textContent = '共有データを読み込み中...';
        return;
    }
    const savedAt = new Date(lastSharedSyncAt).toLocaleString('ja-JP');
    status.textContent = `${householdLabel() || '選択中の家計簿'}：${appData.receipts.length}件の記録 · 最終同期 ${savedAt}`;
}

function updateSyncBanner() {
    const banner = document.getElementById('sync-banner');
    if (!banner) return;
    const settingsMode = window.KakeiboSettings?.mode?.();
    let message = '';
    let tone = 'info';
    if (sharedSyncFailed) {
        message = '最新の記録を読み込めませんでした。通信状態を確認して、設定の「今すぐ同期」を押してください。';
        tone = 'warning';
    } else if (settingsMode === 'local') {
        message = '予算・カテゴリ・固定費は、サーバー更新まではこの端末だけに保存されます。';
    }
    banner.hidden = !message;
    banner.dataset.tone = tone;
    banner.innerHTML = message ? `${icon(tone === 'warning' ? 'alert' : 'sync')}<span>${escapeHtml(message)}</span>` : '';
}

function renderCurrentPage() {
    navigateTo(currentPage, { updateHash: false });
}

async function loadSharedData({ announce = false, force = false } = {}) {
    if (!window.KakeiboShared) return false;
    if (window.KakeiboAuth?.enabled && !window.KakeiboAuth.getToken()) return false;
    if (sharedSyncPromise) return sharedSyncPromise;

    updateStorageStatus('共有データを同期中...');
    document.body.classList.add('is-syncing');
    sharedSyncPromise = (async () => {
        try {
            const [payload] = await Promise.all([
                window.KakeiboShared.requestJson('/receipts'),
                window.KakeiboSettings?.load?.({ force }) || Promise.resolve()
            ]);
            if (!applySharedData(payload)) throw new Error('共有データの形式が不正です。');
            clearLegacyLocalData();
            lastSharedSyncAt = Date.now();
            sharedSyncFailed = false;
            updateStorageStatus();
            renderCurrentPage();
            if (announce) showToast(`${appData.receipts.length}件の記録を同期しました`, 'sync');
            return true;
        } catch (error) {
            console.error('共有データの同期に失敗しました。', error);
            sharedSyncFailed = true;
            updateStorageStatus('共有データを同期できませんでした');
            if (announce) showToast(error instanceof Error ? error.message : '共有データを同期できませんでした', 'alert');
            return false;
        } finally {
            sharedSyncPromise = null;
            document.body.classList.remove('is-syncing');
            updateSyncBanner();
        }
    })();
    return sharedSyncPromise;
}

function refreshSharedDataIfStale() {
    if (Date.now() - lastSharedSyncAt >= SHARED_SYNC_STALE_MS) {
        loadSharedData();
    }
}

function clearInMemoryData() {
    appData.receipts.splice(0, appData.receipts.length);
    lastSharedSyncAt = 0;
    window.KakeiboSettings?.reset?.();
    renderCurrentPage();
    updateStorageStatus('ログインすると選択中の家計簿を読み込みます');
}

// ===== トースト =====
function showToast(message, iconName = 'check') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const known = ['check', 'alert', 'sync', 'trash', 'download', 'repeat'];
    const legacy = { '✓': 'check', '✅': 'check', '⚠️': 'alert', '☁️': 'sync', 'ℹ️': 'sync' };
    const name = known.includes(iconName) ? iconName : (legacy[iconName] || 'check');
    const toast = document.createElement('div');
    toast.className = `toast toast-${name === 'alert' ? 'warning' : 'default'}`;
    toast.setAttribute('role', name === 'alert' ? 'alert' : 'status');
    toast.innerHTML = `${icon(name)}<span></span>`;
    toast.querySelector('span').textContent = String(message);
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 400);
    }, name === 'alert' ? 5200 : 3200);
}

// ===== モーダル共通（フォーカスとEscキー） =====
const overlayStack = [];

function openOverlay(element, { onClose, focus } = {}) {
    if (!element) return;
    const entry = { element, onClose, returnFocus: document.activeElement };
    overlayStack.push(entry);
    element.hidden = false;
    element.classList.add('active');
    element.setAttribute('aria-hidden', 'false');
    document.body.classList.add('has-overlay');
    requestAnimationFrame(() => {
        const target = (focus && element.querySelector(focus))
            || element.querySelector('[autofocus]')
            || element.querySelector('.modal-close, button, input, select, textarea');
        target?.focus({ preventScroll: true });
    });
}

function closeOverlay(element, { silent = false } = {}) {
    const index = overlayStack.findIndex(entry => entry.element === element);
    if (index < 0) {
        element?.classList.remove('active');
        return;
    }
    const wasTop = index === overlayStack.length - 1;
    const [entry] = overlayStack.splice(index, 1);
    element.classList.remove('active');
    element.setAttribute('aria-hidden', 'true');
    if (element.classList.contains('sheet-overlay')) element.hidden = true;
    if (!overlayStack.length) document.body.classList.remove('has-overlay');
    if (!silent && typeof entry.onClose === 'function') entry.onClose();
    const back = entry.returnFocus;
    if (wasTop && back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
}

function topOverlay() {
    return overlayStack[overlayStack.length - 1]?.element || null;
}

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const lightbox = document.getElementById('image-lightbox');
    if (lightbox && !lightbox.hidden) return;
    const top = topOverlay();
    if (!top) return;
    event.preventDefault();
    if (top.id === 'receipt-modal') {
        document.getElementById('close-modal')?.click();
        return;
    }
    closeOverlay(top);
});

// ===== ページ切り替え =====
function pageFromHash() {
    const hash = window.location.hash.replace('#', '');
    const found = Object.entries(PAGE_META).find(([, meta]) => meta.hash === hash);
    return found ? found[0] : null;
}

function navigateTo(page, { updateHash = true, scrollTop = false } = {}) {
    if (!PAGE_META[page]) page = 'dashboard';
    const changed = page !== currentPage;
    currentPage = page;

    document.querySelectorAll('.nav-item').forEach(item => {
        const active = item.dataset.page === page;
        item.classList.toggle('active', active);
        if (active) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
    });
    document.querySelectorAll('.page').forEach(section => {
        section.classList.toggle('active', section.id === `page-${page}`);
    });

    const meta = PAGE_META[page];
    document.getElementById('page-title').textContent = meta.title;
    document.getElementById('page-subtitle').textContent = householdLabel() || '家計簿';
    document.getElementById('month-selector').hidden = !meta.month;
    document.title = `${meta.title} · 家計簿`;
    if (updateHash && window.location.hash !== `#${meta.hash}`) {
        history.replaceState(null, '', `#${meta.hash}`);
    }
    if (changed || scrollTop) window.scrollTo({ top: 0 });

    if (page === 'dashboard') renderDashboard();
    if (page === 'receipts') renderHistory();
    if (page === 'analysis') renderAnalysis();
    if (page === 'settings') renderSettings();
}

// ===== 月の切り替え =====
function updateMonthLabel() {
    const label = document.getElementById('current-month');
    if (!label) return;
    label.textContent = formatMonthLabel(currentMonth);
    const isCurrent = isSameMonth(currentMonth, new Date());
    label.classList.toggle('is-current', isCurrent);
    label.setAttribute('aria-label', isCurrent ? `${formatMonthLabel(currentMonth)}（今月）` : `${formatMonthLabel(currentMonth)}。押すと今月に戻ります`);
}

function setMonth(date) {
    currentMonth = startOfMonth(date);
    updateMonthLabel();
    renderCurrentPage();
}

function initMonthSelector() {
    document.getElementById('prev-month').addEventListener('click', () => {
        setMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1));
    });
    document.getElementById('next-month').addEventListener('click', () => {
        setMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1));
    });
    document.getElementById('current-month').addEventListener('click', () => setMonth(new Date()));
    updateMonthLabel();
}

// ===== グラフ共通 =====
function chartTheme() {
    return {
        ink: cssVar('--ink'),
        ink2: cssVar('--ink-2'),
        muted: cssVar('--ink-3'),
        grid: cssVar('--chart-grid'),
        axis: cssVar('--chart-axis'),
        surface: cssVar('--surface'),
        accent: cssVar('--c1'),
        tooltipBg: cssVar('--tooltip-bg'),
        tooltipInk: cssVar('--tooltip-ink'),
        font: cssVar('--font-sans') || 'system-ui, sans-serif'
    };
}

function slotColor(slot) {
    return cssVar(`--${slot}`) || cssVar('--gray');
}

function destroyChart(key) {
    if (charts[key]) {
        charts[key].destroy();
        delete charts[key];
    }
}

// 縦の補助線。指先やマウスの位置に最も近い日付へ吸着する。
const crosshairPlugin = {
    id: 'kakeiboCrosshair',
    afterDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.() || [];
        if (!active.length) return;
        const { ctx, chartArea } = chart;
        const x = active[0].element.x;
        ctx.save();
        ctx.strokeStyle = chartTheme().axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, chartArea.top);
        ctx.lineTo(Math.round(x) + 0.5, chartArea.bottom);
        ctx.stroke();
        ctx.restore();
    }
};

function baseTooltip(theme) {
    return {
        backgroundColor: theme.tooltipBg,
        titleColor: theme.tooltipInk,
        bodyColor: theme.tooltipInk,
        borderColor: theme.grid,
        borderWidth: 1,
        padding: 10,
        cornerRadius: 8,
        boxPadding: 4,
        usePointStyle: true,
        titleFont: { family: theme.font, size: 12, weight: '600' },
        bodyFont: { family: theme.font, size: 12 }
    };
}

function renderLegend(container, entries) {
    if (!container) return;
    container.innerHTML = entries.map(entry => `
        <span class="legend-item">
            <span class="legend-key legend-key-${entry.shape || 'rect'}" style="--key:${entry.color}"></span>
            <span>${escapeHtml(entry.label)}</span>
        </span>`).join('');
}

if (typeof Chart !== 'undefined') {
    Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif';
    Chart.defaults.font.size = 11;
    Chart.defaults.animation.duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 350;
}

// ===== 空の状態 =====
function emptyState({ iconName = 'receipt', title, description = '', action = '' }) {
    return `
        <div class="empty-state">
            <span class="empty-state-icon">${icon(iconName)}</span>
            <p class="empty-state-title">${escapeHtml(title)}</p>
            ${description ? `<p class="empty-state-desc">${escapeHtml(description)}</p>` : ''}
            ${action}
        </div>`;
}

function recordActionButton(label = 'レシートを記録する') {
    return `<button type="button" class="btn btn-primary" data-action="open-record">${icon('plus')}<span>${escapeHtml(label)}</span></button>`;
}


// ===== ホーム =====
// 月の支出の要約。今月は「今日まで」と「このあとの固定費」を分ける。
function summarizeMonth(date = currentMonth, now = new Date()) {
    const month = getMonthEntries(date);
    const isCurrent = isSameMonth(date, now);
    const isFuture = startOfMonth(date) > startOfMonth(now);
    const cutoff = isCurrent ? now : (isFuture ? new Date(date.getFullYear(), date.getMonth(), 0) : new Date(date.getFullYear(), date.getMonth() + 1, 1));
    // 実際の記録は日付に関係なく支出。固定費の予定は日付が来たものだけ支出に数える。
    const spentEntries = month.all.filter(entry => !entry.virtual || parseDate(entry.date) <= cutoff);
    const scheduledEntries = month.virtual.filter(entry => parseDate(entry.date) > cutoff);
    const spent = spentEntries.reduce((sum, entry) => sum + entryTotal(entry), 0);
    const scheduled = scheduledEntries.reduce((sum, entry) => sum + entryTotal(entry), 0);
    const totalDays = daysInMonth(date);
    const today = isCurrent ? now.getDate() : (isFuture ? 0 : totalDays);
    return { ...month, isCurrent, isFuture, spentEntries, scheduledEntries, spent, scheduled, totalDays, today };
}

function cumulativeByDay(entries, date, limitDay) {
    const totalDays = daysInMonth(date);
    const daily = new Array(totalDays).fill(0);
    entries.forEach(entry => {
        const d = parseDate(entry.date);
        if (!isValidDate(d) || !isSameMonth(d, date)) return;
        daily[d.getDate() - 1] += entryTotal(entry);
    });
    let running = 0;
    return daily.map((value, index) => {
        running += value;
        return index < limitDay ? running : null;
    });
}

// 予算の目安線。固定費は支払日にまとめて、残りは日割りで積み上げる。
function budgetPaceByDay(date, budget) {
    if (!(budget > 0)) return [];
    const totalDays = daysInMonth(date);
    const actual = receiptsInMonth(date);
    const recurring = window.KakeiboSettings.recurringForMonth(date.getFullYear(), date.getMonth(), actual).entries;
    const fixedByDay = new Array(totalDays).fill(0);
    const fixedActual = actual.filter(isLinkedToRecurring);
    [...recurring, ...fixedActual].forEach(entry => {
        const d = parseDate(entry.date);
        if (isValidDate(d)) fixedByDay[d.getDate() - 1] += entryTotal(entry);
    });
    const fixedTotal = fixedByDay.reduce((sum, value) => sum + value, 0);
    const flexible = Math.max(0, budget - fixedTotal);
    let fixedRunning = 0;
    return fixedByDay.map((value, index) => {
        fixedRunning += value;
        return Math.round(fixedRunning + flexible * (index + 1) / totalDays);
    });
}

function renderDashboard() {
    const summary = summarizeMonth();
    const hasAnyData = appData.receipts.length > 0 || (window.KakeiboSettings?.get?.().recurring || []).length > 0;
    renderHero(summary, hasAnyData);
    renderPending(summary);
    renderCategoryBars(summary);
    renderPaceChart(summary);
    renderPriceMoves();
    renderRecentEntries();
    // まだ何も記録がないときは、はじめにの案内だけを見せる。
    ['home-categories', 'home-pace', 'home-prices', 'home-recent'].forEach(id => {
        document.getElementById(id).hidden = !hasAnyData;
    });
}

function renderHero(summary, hasAnyData) {
    const hero = document.getElementById('home-hero');
    const budget = window.KakeiboSettings.monthlyBudget();
    const monthName = `${currentMonth.getMonth() + 1}月`;

    if (!hasAnyData) {
        hero.className = 'card hero-card hero-welcome';
        hero.innerHTML = `
            <p class="hero-eyebrow">はじめに</p>
            <h2 class="hero-welcome-title">レシートを撮るだけで、品目まで記録できます</h2>
            <ol class="onboarding-steps">
                <li><span class="step-num">1</span><div><strong>レシートを撮影する</strong><p>AIが店名・品目・金額・カテゴリを読み取ります。</p></div></li>
                <li><span class="step-num">2</span><div><strong>予算を決める</strong><p>使ったペースと残りの金額がひと目で分かります。</p></div></li>
                <li><span class="step-num">3</span><div><strong>家族を招待する</strong><p>同じ家計簿を一緒に記録できます。</p></div></li>
            </ol>
            <div class="hero-actions">
                ${recordActionButton('最初の記録をつける')}
                <button type="button" class="btn btn-secondary" data-open-settings="budget">予算を決める</button>
            </div>`;
        return;
    }

    hero.className = 'card hero-card';
    const label = summary.isCurrent ? `${monthName}に使ったお金` : (summary.isFuture ? `${monthName}の予定` : `${monthName}の支出`);
    const mainValue = summary.isFuture ? summary.scheduled : summary.spent;
    const lines = [];
    let meter = '';
    let status = '';

    // 前月の同じ日までとの比較
    const previous = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    const prevEntries = getMonthEntries(previous).all;
    if (summary.isCurrent || !summary.isFuture) {
        const compareDay = summary.isCurrent ? Math.min(summary.today, daysInMonth(previous)) : daysInMonth(previous);
        const prevCumulative = cumulativeByDay(prevEntries, previous, compareDay)[compareDay - 1] || 0;
        if (prevCumulative > 0 || summary.spent > 0) {
            const diff = summary.spent - prevCumulative;
            const basis = summary.isCurrent ? '先月の同じ日まで' : '先月';
            if (diff === 0) {
                lines.push(`<span class="delta delta-flat">${basis}と同じ</span>`);
            } else {
                const up = diff > 0;
                lines.push(`<span class="delta delta-${up ? 'up' : 'down'}">${icon(up ? 'arrow-up' : 'arrow-down')}${basis}より${formatCurrency(Math.abs(diff))}${up ? '多い' : '少ない'}</span>`);
            }
        }
    }

    if (budget > 0) {
        const committed = summary.spent + summary.scheduled;
        const remaining = budget - committed;
        const ratio = Math.max(0, summary.spent / budget);
        const scheduledRatio = Math.max(0, summary.scheduled / budget);
        const pace = budgetPaceByDay(currentMonth, budget);
        const paceToday = summary.isCurrent ? (pace[summary.today - 1] || 0) : budget;
        let tone = 'ok';
        if (committed > budget) tone = 'over';
        else if (summary.isCurrent && summary.spent > paceToday * 1.05) tone = 'fast';

        const paceMarker = summary.isCurrent ? `<span class="meter-marker" style="--at:${Math.min(100, paceToday / budget * 100)}%" title="今日までの目安 ${formatCurrency(paceToday)}"></span>` : '';
        meter = `
            <div class="meter meter-${tone}" role="img" aria-label="予算${formatCurrency(budget)}のうち${formatCurrency(summary.spent)}を使用">
                <span class="meter-fill" style="width:${Math.min(100, ratio * 100)}%"></span>
                <span class="meter-scheduled" style="left:${Math.min(100, ratio * 100)}%;width:${Math.max(0, Math.min(100 - ratio * 100, scheduledRatio * 100))}%"></span>
                ${paceMarker}
            </div>
            <div class="meter-scale">
                <span class="meter-legend"><span class="meter-key meter-key-used" aria-hidden="true"></span>使った ${formatCurrency(summary.spent)}</span>
                ${summary.scheduled > 0 ? `<span class="meter-legend"><span class="meter-key meter-key-planned" aria-hidden="true"></span>固定費の予定 ${formatCurrency(summary.scheduled)}</span>` : ''}
                ${summary.isCurrent ? '<span class="meter-legend"><span class="meter-key meter-key-pace" aria-hidden="true"></span>今日までの目安</span>' : ''}
                <span class="meter-budget">予算 ${formatCurrency(budget)}</span>
            </div>`;

        if (remaining >= 0) {
            const daysLeft = summary.isCurrent ? summary.totalDays - summary.today + 1 : 0;
            status = `
                <div class="hero-stat">
                    <span class="hero-stat-label">${summary.isCurrent ? '使える残り' : (summary.isFuture ? '使える予算' : '残った予算')}</span>
                    <strong class="hero-stat-value">${formatCurrency(remaining)}</strong>
                    ${summary.scheduled > 0 ? '<span class="hero-stat-note">固定費の予定を除いた額</span>' : ''}
                </div>
                ${summary.isCurrent && daysLeft > 0 ? `
                <div class="hero-stat">
                    <span class="hero-stat-label">1日あたり</span>
                    <strong class="hero-stat-value">${formatCurrency(Math.floor(remaining / daysLeft))}</strong>
                    <span class="hero-stat-note">残り${daysLeft}日</span>
                </div>` : ''}`;
        } else {
            status = `
                <div class="hero-stat hero-stat-over">
                    <span class="hero-stat-label">${icon('alert')}予算オーバー</span>
                    <strong class="hero-stat-value">${formatCurrency(-remaining)}</strong>
                </div>`;
        }
        if (summary.isCurrent && summary.today >= 3 && summary.today < summary.totalDays) {
            const projected = projectMonthEnd(summary);
            const over = projected > budget;
            lines.push(`<span class="hero-note${over ? ' hero-note-warning' : ''}">${icon('chart')}このペースだと月末は${formatCurrency(projected)}（予算${over ? `を${formatCurrency(projected - budget)}超える見込み` : '内の見込み'}）</span>`);
        }
        if (tone === 'fast') lines.push(`<span class="hero-note hero-note-warning">${icon('alert')}今日までの目安より${formatCurrency(summary.spent - paceToday)}多く使っています</span>`);
        else if (tone === 'ok' && summary.isCurrent && summary.spent > 0) lines.push(`<span class="hero-note">${icon('check')}予算どおりのペースです</span>`);
    } else {
        status = `<button type="button" class="btn btn-secondary btn-sm" data-open-settings="budget">${icon('target')}<span>予算を決めると残りが分かります</span></button>`;
    }

    if (summary.scheduled > 0 && !summary.isFuture) {
        lines.push(`<span class="hero-note">${icon('repeat')}このあと固定費 ${formatCurrency(summary.scheduled)}（${summary.scheduledEntries.length}件）</span>`);
    }

    hero.innerHTML = `
        <div class="hero-main">
            <p class="hero-label">${escapeHtml(label)}</p>
            <p class="hero-value">${formatCurrency(mainValue)}</p>
            <div class="hero-lines">${lines.join('')}</div>
        </div>
        ${meter ? `<div class="hero-meter">${meter}</div>` : ''}
        <div class="hero-stats">${status}</div>`;
}

function renderPending(summary) {
    const card = document.getElementById('home-pending');
    const pending = summary.pending || [];
    if (!pending.length || summary.isFuture) {
        card.hidden = true;
        card.innerHTML = '';
        return;
    }
    card.hidden = false;
    card.className = 'card pending-card';
    card.innerHTML = `
        <header class="card-header">
            <h2>${icon('repeat')}まだ記録していない固定費</h2>
        </header>
        <div class="pending-list">
            ${pending.map(({ expense, date }) => `
                <div class="pending-row">
                    ${categoryDot(expense.category)}
                    <div class="pending-copy">
                        <strong>${escapeHtml(expense.name)}</strong>
                        <span>${escapeHtml(expense.category)} · 毎月${expense.day}日ごろ</span>
                    </div>
                    <button type="button" class="btn btn-secondary btn-sm" data-record-recurring="${escapeHtml(expense.id)}" data-record-date="${escapeHtml(toInputDate(date))}">金額を記録</button>
                </div>`).join('')}
        </div>`;
}

function renderCategoryBars(summary) {
    const container = document.getElementById('category-bars');
    const settings = window.KakeiboSettings.get();
    const spentByCategory = {};
    summary.spentEntries.forEach(entry => {
        Object.entries(categoryTotals(entry)).forEach(([name, value]) => {
            spentByCategory[name] = (spentByCategory[name] || 0) + value;
        });
    });
    const known = new Set(settings.categories.map(category => category.name));
    const rows = settings.categories.map(category => ({ ...category, spent: spentByCategory[category.name] || 0 }));
    Object.entries(spentByCategory).forEach(([name, spent]) => {
        if (!known.has(name)) rows.push({ name, color: 'gray', budget: 0, spent, unknown: true });
    });
    const visible = rows.filter(row => row.spent > 0 || row.budget > 0).sort((a, b) => b.spent - a.spent || b.budget - a.budget);

    if (!visible.length) {
        container.innerHTML = emptyState({
            iconName: 'tag',
            title: `${currentMonth.getMonth() + 1}月の記録はまだありません`,
            description: 'レシートを読み取るか手入力すると、カテゴリごとの支出が表示されます。',
            action: recordActionButton('記録する')
        });
        return;
    }

    const maxValue = Math.max(...visible.map(row => Math.max(row.spent, row.budget)), 1);
    container.innerHTML = visible.map(row => {
        const hasBudget = row.budget > 0;
        const over = hasBudget && row.spent > row.budget;
        const scale = hasBudget ? Math.max(row.budget, row.spent) : maxValue;
        const fill = Math.min(100, row.spent / scale * 100);
        // 予算の位置は、超えたときだけ印を付ける（予算内ならバーの右端が予算）。
        const budgetAt = over ? Math.min(100, row.budget / scale * 100) : null;
        let note = '';
        if (hasBudget) {
            note = over
                ? `<span class="bar-note bar-note-over">${icon('alert')}${formatCurrency(row.spent - row.budget)}オーバー</span>`
                : `<span class="bar-note">残り ${formatCurrency(row.budget - row.spent)}</span>`;
        }
        return `
            <button type="button" class="category-bar${over ? ' is-over' : ''}" data-history-category="${escapeHtml(row.name)}" aria-label="${escapeHtml(row.name)} ${formatCurrency(row.spent)}${hasBudget ? `、予算${formatCurrency(row.budget)}` : ''}。履歴を見る">
                <span class="category-bar-head">
                    <span class="category-bar-name">${categoryDot(row.name)}${escapeHtml(row.name)}</span>
                    <span class="category-bar-value">${formatCurrency(row.spent)}${hasBudget ? `<span class="category-bar-budget"> / ${formatCurrency(row.budget)}</span>` : ''}</span>
                </span>
                <span class="bar-track${hasBudget ? ' has-budget' : ''}">
                    <span class="bar-fill" style="width:${fill}%;--bar:${window.KakeiboSettings.colorVar(row.name)}"></span>
                    ${budgetAt !== null ? `<span class="bar-budget-mark" style="left:${budgetAt}%"></span>` : ''}
                </span>
                ${note}
            </button>`;
    }).join('');
}

function renderPaceChart(summary) {
    const canvas = document.getElementById('pace-chart');
    const legend = document.getElementById('pace-legend');
    const caption = document.getElementById('pace-caption');
    destroyChart('pace');
    if (typeof Chart === 'undefined' || !canvas) return;

    const theme = chartTheme();
    const totalDays = summary.totalDays;
    const labels = Array.from({ length: totalDays }, (_, index) => `${index + 1}日`);
    const limit = summary.isCurrent ? summary.today : (summary.isFuture ? 0 : totalDays);
    const current = cumulativeByDay(summary.spentEntries, currentMonth, limit);
    const previousMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    const prevDays = daysInMonth(previousMonth);
    const previousRaw = cumulativeByDay(getMonthEntries(previousMonth).all, previousMonth, prevDays);
    const previous = labels.map((_, index) => index < prevDays ? previousRaw[index] : null);
    const budget = window.KakeiboSettings.monthlyBudget();
    const pace = budgetPaceByDay(currentMonth, budget);

    const datasets = [
        {
            label: `${currentMonth.getMonth() + 1}月`,
            data: current,
            borderColor: theme.accent,
            backgroundColor: theme.accent,
            borderWidth: 2,
            pointRadius: context => (context.dataIndex === limit - 1 ? 4 : 0),
            pointHoverRadius: 5,
            pointBorderColor: theme.surface,
            pointBorderWidth: 2,
            tension: 0,
            spanGaps: false,
            order: 1
        },
        {
            label: `${previousMonth.getMonth() + 1}月`,
            data: previous,
            borderColor: theme.muted,
            backgroundColor: theme.muted,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0,
            order: 2
        }
    ];
    const legendEntries = [
        { label: `${currentMonth.getMonth() + 1}月（表示中）`, color: theme.accent, shape: 'line' },
        { label: `${previousMonth.getMonth() + 1}月`, color: theme.muted, shape: 'line' }
    ];
    if (pace.length) {
        datasets.push({
            label: '予算の目安',
            data: pace,
            borderColor: cssVar('--warning'),
            backgroundColor: cssVar('--warning'),
            borderWidth: 1,
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0,
            order: 3
        });
        legendEntries.push({ label: '予算の目安', color: cssVar('--warning'), shape: 'thin' });
    }
    renderLegend(legend, legendEntries);
    caption.textContent = summary.isCurrent ? `${summary.today}日時点の累計` : '月初からの累計';

    charts.pace = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        plugins: [crosshairPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            layout: { padding: { top: 6, right: 6 } },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    callbacks: {
                        title: items => items.length ? `${items[0].dataIndex + 1}日まで` : '',
                        label: item => item.parsed.y === null ? null : ` ${item.dataset.label}  ${formatCurrency(item.parsed.y)}`
                    },
                    filter: item => item.parsed.y !== null
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    border: { color: theme.axis },
                    ticks: {
                        color: theme.muted,
                        maxRotation: 0,
                        autoSkip: false,
                        callback: (value, index) => ([0, 9, 19, totalDays - 1].includes(index) ? labels[index] : '')
                    }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: theme.grid, drawTicks: false },
                    border: { display: false },
                    ticks: { color: theme.muted, padding: 6, maxTicksLimit: 5, callback: value => `¥${formatCompactYen(value)}` }
                }
            }
        }
    });
}

// ===== 品目の価格 =====
function buildItemIndex(receipts = appData.receipts) {
    const map = new Map();
    receipts.forEach(receipt => {
        if (entryKind(receipt) !== 'receipt') return;
        const date = parseDate(receipt.date);
        if (!isValidDate(date)) return;
        (receipt.items || []).forEach(item => {
            const name = String(item.name || '').trim();
            if (!name) return;
            if (!map.has(name)) map.set(name, { name, category: item.category || 'その他', latestDate: date, purchases: [], spend: 0, quantity: 0 });
            const entry = map.get(name);
            // カテゴリは最後に買ったときのものを使う（品目の編集やカテゴリ変更を反映するため）。
            if (date >= entry.latestDate) {
                entry.latestDate = date;
                entry.category = item.category || 'その他';
            }
            const quantity = Math.max(1, Number(item.quantity) || 1);
            const unit = Math.round(getItemLineTotal(item) / quantity);
            entry.purchases.push({ date, unit, quantity, store: receipt.store, receiptId: receipt.id });
            entry.spend += getItemLineTotal(item);
            entry.quantity += quantity;
        });
    });
    return [...map.values()].map(entry => {
        entry.purchases.sort((a, b) => a.date - b.date);
        const last = entry.purchases[entry.purchases.length - 1];
        const units = entry.purchases.map(purchase => purchase.unit);
        const previous = entry.purchases.slice(0, -1).map(purchase => purchase.unit);
        const previousAvg = previous.length ? previous.reduce((sum, value) => sum + value, 0) / previous.length : null;
        return {
            ...entry,
            count: entry.purchases.length,
            last,
            lastUnit: last.unit,
            avgUnit: Math.round(units.reduce((sum, value) => sum + value, 0) / units.length),
            minUnit: Math.min(...units),
            maxUnit: Math.max(...units),
            previousAvg,
            change: previousAvg ? (last.unit - previousAvg) / previousAvg : null,
            changeYen: previousAvg ? Math.round(last.unit - previousAvg) : null,
            stores: [...new Set(entry.purchases.map(purchase => purchase.store).filter(Boolean))]
        };
    });
}

function significantMoves(items, { since } = {}) {
    return items.filter(item => item.count >= 2 && item.change !== null
        && Math.abs(item.change) >= 0.03 && Math.abs(item.changeYen) >= 5
        && (!since || item.last.date >= since));
}

function priceMoveRow(item) {
    const up = item.change > 0;
    return `
        <button type="button" class="price-move" data-item-name="${escapeHtml(item.name)}">
            <span class="price-move-main">
                <span class="price-move-name">${escapeHtml(item.name)}</span>
                <span class="price-move-meta">${categoryDot(item.category)}${escapeHtml(item.category)} · ${item.count}回購入 · 最後は${escapeHtml(formatMonthDay(item.last.date))}</span>
            </span>
            <span class="price-move-side">
                <span class="price-move-price">${formatCurrency(Math.round(item.previousAvg))} → ${formatCurrency(item.lastUnit)}</span>
                <span class="delta delta-${up ? 'up' : 'down'}">${icon(up ? 'arrow-up' : 'arrow-down')}${up ? '値上がり' : '値下がり'} ${formatPercent(item.change)}</span>
            </span>
        </button>`;
}

function renderPriceMoves() {
    const container = document.getElementById('price-moves');
    const monthEnd = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0, 23, 59);
    const since = new Date(monthEnd.getTime() - 75 * 24 * 60 * 60 * 1000);
    const relevant = appData.receipts.filter(receipt => parseDate(receipt.date) <= monthEnd);
    const moves = significantMoves(buildItemIndex(relevant), { since })
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
        .slice(0, 4);
    if (!moves.length) {
        container.innerHTML = `<p class="muted-copy">同じ品を2回以上買うと、前回までと比べた値動きがここに出ます。</p>`;
        return;
    }
    container.innerHTML = moves.map(priceMoveRow).join('');
}

// ===== 記録の行 =====
function entryRow(entry, { showDate = false } = {}) {
    const kind = entryKind(entry);
    const category = dominantCategory(entry);
    const kindIcon = { receipt: 'receipt', manual: 'pencil', recurring: 'repeat' }[kind];
    const summary = itemSummary(entry);
    const badges = [];
    if (entry.virtual) badges.push(`<span class="tag tag-muted">${parseDate(entry.date) > new Date() ? '予定' : '固定費'}</span>`);
    else if (isLinkedToRecurring(entry)) badges.push('<span class="tag tag-muted">固定費</span>');
    if (entry.status === 'review') badges.push(`<span class="tag tag-warning">${icon('alert')}要確認</span>`);
    const sub = [
        showDate ? escapeHtml(formatMonthDay(entry.date)) : '',
        `${categoryDot(category)}${escapeHtml(category)}`,
        summary ? escapeHtml(summary) : ''
    ].filter(Boolean).join('<span class="sep" aria-hidden="true">·</span>');
    return `
        <button type="button" class="entry-row${entry.virtual ? ' is-virtual' : ''}" data-entry-id="${escapeHtml(entry.id)}">
            <span class="entry-icon">${icon(kindIcon)}</span>
            <span class="entry-main">
                <span class="entry-title">${escapeHtml(entry.store)}</span>
                <span class="entry-sub">${sub}</span>
            </span>
            <span class="entry-side">
                <span class="entry-amount">${formatCurrency(entryTotal(entry))}</span>
                ${badges.length ? `<span class="entry-badges">${badges.join('')}</span>` : ''}
            </span>
        </button>`;
}

function renderRecentEntries() {
    const container = document.getElementById('recent-entries');
    const recent = sortByDateDesc(appData.receipts).slice(0, 6);
    if (!recent.length) {
        container.innerHTML = `<p class="muted-copy">まだ記録がありません。</p>`;
        return;
    }
    container.innerHTML = recent.map(entry => entryRow(entry, { showDate: true })).join('');
}


// ===== 履歴 =====
function matchesHistoryFilter(entry, filter) {
    if (filter === 'all') return true;
    if (filter === 'review') return entry.status === 'review';
    if (filter === 'recurring') return entryKind(entry) === 'recurring' || isLinkedToRecurring(entry);
    return entryKind(entry) === filter;
}

function matchesSearch(entry, query) {
    if (!query) return true;
    const haystack = [entry.store, entry.memo, ...(entry.items || []).map(item => item.name)]
        .join(' ').toLowerCase();
    return haystack.includes(query);
}

function fillCategorySelect(select, { includeUnknown = [] } = {}) {
    if (!select) return;
    const previous = select.value || 'all';
    const names = [...new Set([...categoryNames(), ...includeUnknown])];
    select.innerHTML = `<option value="all">すべてのカテゴリ</option>` +
        names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    select.value = names.includes(previous) ? previous : 'all';
}

function renderHistory() {
    const container = document.getElementById('receipts-container');
    const summaryEl = document.getElementById('history-summary');
    const month = getMonthEntries(currentMonth);
    const categoryFilter = document.getElementById('history-category-filter');
    const usedCategories = [...new Set(month.all.flatMap(entry => (entry.items || []).map(item => item.category)))];
    fillCategorySelect(categoryFilter, { includeUnknown: usedCategories });

    const query = document.getElementById('receipt-search').value.trim().toLowerCase();
    const category = categoryFilter.value;
    const filtered = sortByDateDesc(month.all).filter(entry => matchesHistoryFilter(entry, historyFilter)
        && matchesSearch(entry, query)
        && (category === 'all' || (entry.items || []).some(item => item.category === category)));

    // 絞り込み中のカテゴリだけの金額を合計する。
    const amountOf = entry => category === 'all'
        ? entryTotal(entry)
        : (entry.items || []).filter(item => item.category === category).reduce((sum, item) => sum + getItemLineTotal(item), 0);
    const now = new Date();
    const upcoming = filtered.filter(entry => entry.virtual && parseDate(entry.date) > now).reverse();
    const past = filtered.filter(entry => !(entry.virtual && parseDate(entry.date) > now));
    const total = past.reduce((sum, entry) => sum + amountOf(entry), 0);
    const upcomingTotal = upcoming.reduce((sum, entry) => sum + amountOf(entry), 0);
    const reviewCount = month.actual.filter(entry => entry.status === 'review').length;
    summaryEl.innerHTML = `
        <div class="history-total">
            <span class="history-total-label">${escapeHtml(formatMonthLabel(currentMonth))}${filtered.length !== month.all.length ? '（絞り込み中）' : ''}</span>
            <strong>${formatCurrency(total)}</strong>
            <span class="history-total-count">${past.length}件${upcoming.length ? `・このあと予定 ${formatCurrency(upcomingTotal)}` : ''}</span>
        </div>
        ${reviewCount ? `<button type="button" class="tag tag-warning tag-button" data-history-filter="review">${icon('alert')}要確認 ${reviewCount}件</button>` : ''}`;

    document.querySelectorAll('#receipt-filter .chip').forEach(chip => {
        const active = chip.dataset.filter === historyFilter;
        chip.classList.toggle('is-active', active);
        chip.setAttribute('aria-pressed', String(active));
    });

    if (!month.all.length) {
        container.innerHTML = emptyState({
            iconName: 'calendar',
            title: `${formatMonthLabel(currentMonth)}の記録はありません`,
            description: appData.receipts.length ? '上の矢印で別の月を表示できます。' : 'レシートを読み取るか手入力すると、ここに並びます。',
            action: recordActionButton('記録する')
        });
        return;
    }
    if (!filtered.length) {
        container.innerHTML = emptyState({ iconName: 'search', title: '条件に合う記録がありません', description: '検索語や絞り込みを変えてみてください。' });
        return;
    }

    const groups = new Map();
    past.forEach(entry => {
        const key = dayKey(parseDate(entry.date));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    });
    const upcomingHtml = upcoming.length ? `
        <section class="day-group day-group-upcoming" aria-label="このあとの予定">
            <header class="day-header">
                <span class="day-label">${icon('repeat')}このあとの予定</span>
                <span class="day-total">${formatCurrency(upcomingTotal)}</span>
            </header>
            <div class="entry-list">${upcoming.map(entry => entryRow(entry, { showDate: true })).join('')}</div>
        </section>` : '';
    // 今日の記録を先頭に出すため、このあとの予定は一番下にまとめる。
    container.innerHTML = [...groups.entries()].map(([key, entries]) => {
        const dayTotal = entries.reduce((sum, entry) => sum + amountOf(entry), 0);
        const [y, m, d] = key.split('-').map(Number);
        const date = new Date(y, m - 1, d);
        const isToday = dayKey(new Date()) === key;
        return `
            <section class="day-group" aria-label="${escapeHtml(formatMonthDay(date, { weekday: true }))}">
                <header class="day-header">
                    <span class="day-label">${escapeHtml(formatMonthDay(date, { weekday: true }))}${isToday ? '<span class="tag tag-accent">今日</span>' : ''}</span>
                    <span class="day-total">${formatCurrency(dayTotal)}</span>
                </header>
                <div class="entry-list">${entries.map(entry => entryRow(entry)).join('')}</div>
            </section>`;
    }).join('') + upcomingHtml;
}

function initHistoryControls() {
    let searchTimer = 0;
    document.getElementById('receipt-search').addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderHistory, 120);
    });
    document.getElementById('history-category-filter').addEventListener('change', renderHistory);
    document.getElementById('receipt-filter').addEventListener('click', event => {
        const chip = event.target.closest('[data-filter]');
        if (!chip) return;
        historyFilter = chip.dataset.filter;
        renderHistory();
    });
}

function findEntry(id) {
    const key = String(id);
    const actual = appData.receipts.find(entry => String(entry.id) === key);
    if (actual) return actual;
    if (key.startsWith('recurring:')) {
        const [, , month] = key.split(':');
        const [y, m] = month.split('-').map(Number);
        return getMonthEntries(new Date(y, m - 1, 1)).virtual.find(entry => entry.id === key) || null;
    }
    return null;
}

// ===== 詳細シート =====
function closeDetailModal() {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;
    closeOverlay(modal);
    if (detailImageObjectUrl) {
        URL.revokeObjectURL(detailImageObjectUrl);
        detailImageObjectUrl = '';
    }
}

// actions: [{ label, icon, variant: 'primary'|'secondary'|'danger', onClick, close }]
function showDetailModal(title, bodyHtml, onOpen, actions = null) {
    const modal = document.getElementById('detail-modal');
    const titleEl = document.getElementById('detail-modal-title');
    const bodyEl = document.getElementById('detail-modal-body');
    const footer = document.getElementById('detail-modal-footer');
    if (!modal || !titleEl || !bodyEl) return;
    if (detailImageObjectUrl) {
        URL.revokeObjectURL(detailImageObjectUrl);
        detailImageObjectUrl = '';
    }
    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;
    bodyEl.scrollTop = 0;
    const buttons = actions || [{ label: '閉じる', variant: 'secondary', close: true }];
    footer.innerHTML = buttons.map((action, index) => `
        <button type="button" class="btn btn-${action.variant || 'secondary'}${action.variant === 'danger' ? ' btn-push' : ''}" data-detail-action="${index}" ${action.form ? `form="${escapeHtml(action.form)}" type="submit"` : ''}>
            ${action.icon ? icon(action.icon) : ''}<span>${escapeHtml(action.label)}</span>
        </button>`).join('');
    footer.querySelectorAll('[data-detail-action]').forEach(button => {
        const action = buttons[Number(button.dataset.detailAction)];
        if (action.form) return;
        button.addEventListener('click', async () => {
            if (action.onClick) {
                const result = await action.onClick(button);
                if (result === false) return;
            }
            if (action.close !== false) closeDetailModal();
        });
    });
    if (!modal.classList.contains('active')) openOverlay(modal);
    if (onOpen) onOpen(bodyEl);
}

function initDetailModal() {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;
    document.getElementById('detail-modal-close')?.addEventListener('click', closeDetailModal);
    modal.addEventListener('click', event => {
        if (event.target === modal) closeDetailModal();
    });
}

async function loadReceiptImage(receipt, body) {
    const holder = body.querySelector('[data-receipt-image-holder]');
    if (!holder) return;
    const loading = holder.querySelector('[data-receipt-image-loading]');
    const image = holder.querySelector('img');
    try {
        const response = await window.KakeiboShared.request(`/receipts/${encodeURIComponent(receipt.id)}/image`);
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.detail || 'レシート画像を読み込めませんでした。');
        }
        const blob = await response.blob();
        if (detailImageObjectUrl) URL.revokeObjectURL(detailImageObjectUrl);
        detailImageObjectUrl = URL.createObjectURL(blob);
        image.src = detailImageObjectUrl;
        image.hidden = false;
        loading.hidden = true;
    } catch (error) {
        loading.textContent = error instanceof Error ? error.message : 'レシート画像を読み込めませんでした。';
        loading.classList.add('error');
    }
}

async function deleteEntry(entry) {
    const label = entry.store || '記録';
    if (!window.confirm(`「${label}」${formatCurrency(entryTotal(entry))} の記録を削除します。家計簿のメンバー全員から見えなくなります。`)) return false;
    try {
        await window.KakeiboShared.requestJson(`/receipts/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
        const index = appData.receipts.findIndex(item => String(item.id) === String(entry.id));
        if (index >= 0) appData.receipts.splice(index, 1);
        lastSharedSyncAt = Date.now();
        updateStorageStatus();
        renderCurrentPage();
        showToast(`「${label}」の記録を削除しました`, 'trash');
        return true;
    } catch (error) {
        showToast(error instanceof Error ? error.message : '記録を削除できませんでした', 'alert');
        return false;
    }
}

function openEntryDetails(entry) {
    if (!entry) return;
    const kind = entryKind(entry);
    if (kind === 'recurring') {
        openRecurringOccurrence(entry);
        return;
    }
    const items = entry.items || [];
    const totals = Object.entries(categoryTotals(entry)).sort((a, b) => b[1] - a[1]);
    const hasImage = Boolean(entry.image_storage?.object_name);
    const meta = [
        ['日時', escapeHtml(formatMonthDay(entry.date, { weekday: true })) + (kind === 'receipt' ? ` ${escapeHtml(timeOf(entry.date))}` : '')],
        ['種類', kind === 'manual' ? '手入力' : 'レシート'],
        kind === 'receipt' ? ['状態', getStatusBadge(entry.status)] : null,
        entry.memo ? ['メモ', escapeHtml(entry.memo)] : null,
        entry.created_by?.name ? ['記録した人', escapeHtml(entry.created_by.name)] : null
    ].filter(Boolean);

    const body = `
        <div class="detail-hero">
            <p class="detail-hero-value">${formatCurrency(entryTotal(entry))}</p>
            <div class="detail-categories">${totals.map(([name, value]) => `<span class="tag">${categoryDot(name)}${escapeHtml(name)} ${formatCurrency(value)}</span>`).join('')}</div>
        </div>
        <dl class="detail-meta">${meta.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>
        ${kind === 'receipt' ? `
        <h4 class="detail-section-title">品目（${items.length}点）</h4>
        <div class="table-scroll">
            <table class="detail-items-table">
                <thead><tr><th scope="col">品名</th><th scope="col" class="num">単価</th><th scope="col" class="num">数量</th><th scope="col" class="num">金額</th></tr></thead>
                <tbody>${items.map(item => `
                    <tr>
                        <td><button type="button" class="link-button item-link" data-item-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button><span class="item-cat">${categoryDot(item.category)}${escapeHtml(item.category)}</span></td>
                        <td class="num">${formatCurrency(Number(item.price) || 0)}</td>
                        <td class="num">${item.quantity || 1}</td>
                        <td class="num">${formatCurrency(getItemLineTotal(item))}</td>
                    </tr>`).join('') || '<tr><td colspan="4">品目がありません</td></tr>'}
                </tbody>
            </table>
        </div>
        <h4 class="detail-section-title">レシート画像</h4>
        ${hasImage ? `
            <div class="receipt-image-viewer" data-receipt-image-holder>
                <div class="receipt-image-loading" data-receipt-image-loading>画像を読み込み中...</div>
                <img alt="${escapeHtml(entry.store || 'レシート')}のレシート画像" hidden>
            </div>` : '<p class="muted-copy">この記録には保存された画像がありません。</p>'}` : ''}`;

    const actions = [
        { label: '削除', icon: 'trash', variant: 'danger', close: false, onClick: async () => { if (await deleteEntry(entry)) closeDetailModal(); return false; } },
        {
            label: '編集', icon: 'pencil', variant: 'primary', onClick: () => {
                closeDetailModal();
                if (kind === 'manual') openManualEntry({ entry });
                else window.openReceiptEditor?.(entry);
            }
        }
    ];
    showDetailModal(entry.store || '記録の詳細', body, element => {
        if (hasImage) loadReceiptImage(entry, element);
        element.querySelectorAll('.item-link').forEach(button => {
            button.addEventListener('click', () => {
                closeDetailModal();
                openItemDetail(button.dataset.itemName);
            });
        });
        const image = element.querySelector('[data-receipt-image-holder] img');
        image?.addEventListener('click', () => {
            if (image.src) window.KakeiboUpload?.openLightbox?.(image.src, entry.store);
        });
    }, actions);
}

function timeOf(value) {
    const d = parseDate(value);
    if (!isValidDate(d) || /^\d{4}-\d{2}-\d{2}$/.test(String(value))) return '';
    const hh = d.getHours();
    const mm = d.getMinutes();
    if (hh === 12 && mm === 0) return '';
    return `${hh}:${String(mm).padStart(2, '0')}`;
}

// 固定費の予定（まだ実際の記録がないもの）
function openRecurringOccurrence(entry) {
    const expense = (window.KakeiboSettings.get().recurring || []).find(item => item.id === entry.recurring_id);
    const date = parseDate(entry.date);
    const future = date > new Date();
    const body = `
        <div class="detail-hero">
            <p class="detail-hero-value">${formatCurrency(entryTotal(entry))}</p>
            <div class="detail-categories">${categoryDot(dominantCategory(entry))}<span>${escapeHtml(dominantCategory(entry))}</span></div>
        </div>
        <p class="detail-copy">${future ? `${escapeHtml(formatMonthDay(date))}に引き落とし予定の固定費です。` : '設定した金額で自動計上している固定費です。'}金額が違った月は「今月の金額を記録」で実際の金額に置き換えられます。</p>
        <dl class="detail-meta">
            <div><dt>支払日</dt><dd>毎月${expense ? expense.day : date.getDate()}日</dd></div>
            ${expense?.memo ? `<div><dt>メモ</dt><dd>${escapeHtml(expense.memo)}</dd></div>` : ''}
        </dl>`;
    showDetailModal(entry.store, body, null, [
        { label: '固定費の設定', icon: 'settings', variant: 'secondary', onClick: () => { if (expense) openRecurringEditor(expense); return false; } },
        { label: '今月の金額を記録', icon: 'pencil', variant: 'primary', onClick: () => openManualEntry({ recurring: expense, date }) }
    ]);
}


// ===== 分析 =====
function setAnalysisTab(tab) {
    analysisTab = tab === 'items' ? 'items' : 'trend';
    document.querySelectorAll('[role="tab"][data-analysis-tab]').forEach(button => {
        const active = button.dataset.analysisTab === analysisTab;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        button.tabIndex = active ? 0 : -1;
    });
    document.getElementById('analysis-trend').hidden = analysisTab !== 'trend';
    document.getElementById('analysis-items').hidden = analysisTab !== 'items';
}

function renderAnalysis() {
    setAnalysisTab(analysisTab);
    if (analysisTab === 'trend') renderTrendPanel();
    else renderItemsPanel();
}

function monthsEndingAt(date, count) {
    return Array.from({ length: count }, (_, index) => new Date(date.getFullYear(), date.getMonth() - (count - 1 - index), 1));
}

// カテゴリは設定の並び順で色が固定。9番目以降と未登録のカテゴリは「その他」にまとめる。
function chartCategories(monthData) {
    const settings = window.KakeiboSettings.categories();
    const used = new Set();
    monthData.forEach(month => Object.keys(month.byCategory).forEach(name => used.add(name)));
    const ordered = settings.filter(category => used.has(category.name) && category.name !== 'その他').slice(0, 8);
    const keep = new Set(ordered.map(category => category.name));
    return { ordered, keep };
}

function renderTrendPanel() {
    const months = monthsEndingAt(currentMonth, trendRange);
    const monthData = months.map(date => {
        const entries = date > new Date() && !isSameMonth(date, new Date()) ? [] : summarizeMonth(date).spentEntries;
        const byCategory = {};
        entries.forEach(entry => Object.entries(categoryTotals(entry)).forEach(([name, value]) => {
            byCategory[name] = (byCategory[name] || 0) + value;
        }));
        const total = Object.values(byCategory).reduce((sum, value) => sum + value, 0);
        return { date, byCategory, total, count: entries.length };
    });
    const { ordered, keep } = chartCategories(monthData);
    const series = [...ordered.map(category => ({ name: category.name, slot: category.color })), { name: 'その他', slot: 'gray' }];
    const valueOf = (month, name) => name === 'その他'
        ? Object.entries(month.byCategory).filter(([key]) => !keep.has(key)).reduce((sum, [, value]) => sum + value, 0)
        : (month.byCategory[name] || 0);
    const visibleSeries = series.filter(entry => monthData.some(month => valueOf(month, entry.name) > 0));

    renderTrendStats(monthData);
    renderMonthlyChart(monthData, visibleSeries, valueOf);
    renderMonthlyTable(monthData, visibleSeries, valueOf);
    renderStoreRanking();
}

function projectMonthEnd(summary) {
    // 固定費（予定・実績）は確定額として、それ以外の支出は今日までのペースで月末まで伸ばす。
    const flexible = summary.spentEntries
        .filter(entry => !entry.virtual && !isLinkedToRecurring(entry))
        .reduce((sum, entry) => sum + entryTotal(entry), 0);
    const daysLeft = Math.max(0, summary.totalDays - summary.today);
    const perDay = summary.today > 0 ? flexible / summary.today : 0;
    return Math.round(summary.spent + summary.scheduled + perDay * daysLeft);
}

function renderTrendStats(monthData) {
    const container = document.getElementById('trend-stats');
    const current = monthData[monthData.length - 1];
    const past = monthData.slice(0, -1).filter(month => month.total > 0);
    const average = past.length ? past.reduce((sum, month) => sum + month.total, 0) / past.length : 0;
    const budget = window.KakeiboSettings.monthlyBudget();
    const summary = summarizeMonth(current.date);
    const monthName = `${current.date.getMonth() + 1}月`;
    const diffText = (value, base, noun) => value >= base ? `${noun}より${formatCurrency(value - base)}多い` : `${noun}より${formatCurrency(base - value)}少ない`;
    let tiles;
    if (summary.isCurrent && summary.today < summary.totalDays) {
        const projected = projectMonthEnd(summary);
        tiles = [
            { label: `${monthName}の支出（今日まで）`, value: formatCurrency(current.total), note: `${summary.today}日目・${current.count}件の記録` },
            { label: '月末の見込み', value: formatCurrency(projected), note: budget > 0 ? diffText(projected, budget, '予算') : '今日までのペースと固定費から計算' },
            { label: `それまでの${past.length || ''}か月平均`, value: past.length ? formatCurrency(average) : '—', note: past.length ? diffText(projected, average, '見込みは平均') : 'データが増えると表示' }
        ];
    } else {
        tiles = [
            { label: `${monthName}の支出`, value: formatCurrency(current.total), note: current.count ? `${current.count}件の記録` : '記録なし' },
            { label: `それまでの${past.length || ''}か月平均`, value: past.length ? formatCurrency(average) : '—', note: past.length && current.total ? diffText(current.total, average, '平均') : 'データが増えると表示' },
            budget > 0
                ? { label: '予算との差', value: formatCurrency(Math.abs(budget - current.total)), note: current.total > budget ? '予算オーバー' : '予算内' }
                : { label: '予算', value: '未設定', note: '設定すると比較できます' }
        ];
    }
    container.innerHTML = tiles.map(tile => `
        <div class="stat-tile">
            <span class="stat-label">${escapeHtml(tile.label)}</span>
            <strong class="stat-value">${tile.value}</strong>
            <span class="stat-note">${escapeHtml(tile.note)}</span>
        </div>`).join('');
}

function renderMonthlyChart(monthData, series, valueOf) {
    const canvas = document.getElementById('monthly-chart');
    destroyChart('monthly');
    if (typeof Chart === 'undefined' || !canvas) return;
    const theme = chartTheme();
    const labels = monthData.map(month => (month.date.getMonth() === 0 || month === monthData[0])
        ? `${month.date.getFullYear() % 100}年${month.date.getMonth() + 1}月` : `${month.date.getMonth() + 1}月`);
    // 積み上げの一番上の要素だけ角を丸める。
    const topIndex = monthData.map(month => {
        let top = -1;
        series.forEach((entry, index) => { if (valueOf(month, entry.name) > 0) top = index; });
        return top;
    });
    const datasets = series.map((entry, datasetIndex) => ({
        label: entry.name,
        data: monthData.map(month => valueOf(month, entry.name)),
        backgroundColor: slotColor(entry.slot),
        hoverBackgroundColor: slotColor(entry.slot),
        borderColor: theme.surface,
        borderWidth: { top: 2, right: 0, bottom: 0, left: 0 },
        borderSkipped: false,
        borderRadius: context => (topIndex[context.dataIndex] === datasetIndex ? { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 } : 0),
        maxBarThickness: 24,
        categoryPercentage: 0.7,
        barPercentage: 0.9
    }));
    renderLegend(document.getElementById('monthly-legend'), series.map(entry => ({ label: entry.name, color: slotColor(entry.slot), shape: 'rect' })));
    if (!series.length) {
        canvas.parentElement.classList.add('is-empty');
    } else {
        canvas.parentElement.classList.remove('is-empty');
    }

    charts.monthly = new Chart(canvas, {
        type: 'bar',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
                    filter: item => item.parsed.y > 0,
                    callbacks: {
                        title: items => items.length ? formatMonthLabel(monthData[items[0].dataIndex].date) : '',
                        label: item => ` ${item.dataset.label}  ${formatCurrency(item.parsed.y)}`,
                        footer: items => items.length ? `合計 ${formatCurrency(monthData[items[0].dataIndex].total)}` : ''
                    },
                    footerFont: { family: theme.font, size: 12, weight: '600' },
                    footerColor: theme.tooltipInk
                }
            },
            onClick: (event, elements) => {
                if (!elements.length) return;
                setMonth(monthData[elements[0].index].date);
            },
            scales: {
                x: { stacked: true, grid: { display: false }, border: { color: theme.axis }, ticks: { color: theme.muted, maxRotation: 0, autoSkip: true } },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    grid: { color: theme.grid, drawTicks: false },
                    border: { display: false },
                    ticks: { color: theme.muted, padding: 6, maxTicksLimit: 5, callback: value => `¥${formatCompactYen(value)}` }
                }
            }
        }
    });
}

function renderMonthlyTable(monthData, series, valueOf) {
    const container = document.getElementById('monthly-table');
    container.innerHTML = `
        <table class="data-table">
            <thead><tr><th scope="col">月</th>${series.map(entry => `<th scope="col" class="num">${escapeHtml(entry.name)}</th>`).join('')}<th scope="col" class="num">合計</th></tr></thead>
            <tbody>${monthData.slice().reverse().map(month => `
                <tr>
                    <th scope="row">${escapeHtml(formatMonthLabel(month.date))}</th>
                    ${series.map(entry => `<td class="num">${formatCurrency(valueOf(month, entry.name))}</td>`).join('')}
                    <td class="num"><strong>${formatCurrency(month.total)}</strong></td>
                </tr>`).join('')}
            </tbody>
        </table>`;
}

function renderStoreRanking() {
    const container = document.getElementById('store-ranking');
    const caption = document.getElementById('store-caption');
    caption.textContent = formatMonthLabel(currentMonth);
    const stores = new Map();
    receiptsInMonth(currentMonth).forEach(entry => {
        if (entryKind(entry) !== 'receipt') return;
        const name = entry.store || '店名なし';
        const current = stores.get(name) || { name, total: 0, visits: 0 };
        current.total += entryTotal(entry);
        current.visits += 1;
        stores.set(name, current);
    });
    const ranked = [...stores.values()].sort((a, b) => b.total - a.total).slice(0, 8);
    if (!ranked.length) {
        container.innerHTML = '<p class="muted-copy">この月のレシートはまだありません。</p>';
        return;
    }
    const max = ranked[0].total || 1;
    container.innerHTML = ranked.map((store, index) => `
        <div class="rank-row">
            <span class="rank-num">${index + 1}</span>
            <span class="rank-main">
                <span class="rank-head"><span class="rank-name">${escapeHtml(store.name)}</span><span class="rank-value">${formatCurrency(store.total)}</span></span>
                <span class="bar-track bar-track-thin"><span class="bar-fill" style="width:${store.total / max * 100}%;--bar:var(--c1)"></span></span>
                <span class="rank-meta">${store.visits}回 · 1回あたり${formatCurrency(Math.round(store.total / store.visits))}</span>
            </span>
        </div>`).join('');
}

// ===== 品目と価格 =====
function renderItemsPanel() {
    const items = buildItemIndex();
    const statsEl = document.getElementById('basket-stats');
    const container = document.getElementById('items-container');
    const categorySelect = document.getElementById('item-category-filter');
    fillCategorySelect(categorySelect, { includeUnknown: [...new Set(items.map(item => item.category))] });

    const repeated = items.filter(item => item.count >= 2 && item.change !== null);
    const weight = repeated.reduce((sum, item) => sum + item.spend, 0);
    const basket = weight ? repeated.reduce((sum, item) => sum + item.change * item.spend, 0) / weight : null;
    const rises = significantMoves(items).filter(item => item.change > 0).length;
    const falls = significantMoves(items).filter(item => item.change < 0).length;
    statsEl.innerHTML = `
        <div class="stat-tile">
            <span class="stat-label">よく買う品の価格</span>
            <strong class="stat-value">${basket === null ? '—' : formatPercent(basket)}</strong>
            <span class="stat-note">${basket === null ? '同じ品を2回以上買うと計算します' : '最後に買った価格と、それまでの平均の比較'}</span>
        </div>
        <div class="stat-tile">
            <span class="stat-label">値上がりした品</span>
            <strong class="stat-value">${rises}<small>品</small></strong>
            <span class="stat-note">3%以上の変化</span>
        </div>
        <div class="stat-tile">
            <span class="stat-label">値下がりした品</span>
            <strong class="stat-value">${falls}<small>品</small></strong>
            <span class="stat-note">記録した品目 ${items.length}種類</span>
        </div>`;

    if (!items.length) {
        container.innerHTML = emptyState({
            iconName: 'tag',
            title: '品目のデータはまだありません',
            description: 'レシートを読み取ると、品目ごとの購入回数や価格の変化が分かるようになります。',
            action: recordActionButton('レシートを読み取る')
        });
        return;
    }

    const query = document.getElementById('item-search').value.trim().toLowerCase();
    const category = categorySelect.value;
    const sort = document.getElementById('item-sort').value;
    const sorters = {
        count: (a, b) => b.count - a.count || b.spend - a.spend,
        rise: (a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity),
        spend: (a, b) => b.spend - a.spend,
        recent: (a, b) => b.last.date - a.last.date
    };
    const filtered = items
        .filter(item => (!query || item.name.toLowerCase().includes(query)) && (category === 'all' || item.category === category))
        .sort(sorters[sort] || sorters.count);
    if (!filtered.length) {
        container.innerHTML = emptyState({ iconName: 'search', title: '条件に合う品目がありません' });
        return;
    }
    container.innerHTML = filtered.slice(0, 200).map(item => {
        const change = item.change !== null && Math.abs(item.change) >= 0.03 && Math.abs(item.changeYen) >= 5
            ? `<span class="delta delta-${item.change > 0 ? 'up' : 'down'}">${icon(item.change > 0 ? 'arrow-up' : 'arrow-down')}${formatPercent(item.change)}</span>`
            : (item.count >= 2 ? '<span class="delta delta-flat">ほぼ横ばい</span>' : '');
        return `
            <button type="button" class="item-row" data-item-name="${escapeHtml(item.name)}">
                <span class="item-main">
                    <span class="item-name">${escapeHtml(item.name)}</span>
                    <span class="item-meta">${categoryDot(item.category)}${escapeHtml(item.category)}<span class="sep" aria-hidden="true">·</span>${item.count}回<span class="sep" aria-hidden="true">·</span>計${formatCurrency(item.spend)}</span>
                </span>
                <span class="item-side">
                    <span class="item-price">${formatCurrency(item.lastUnit)}</span>
                    ${change}
                </span>
            </button>`;
    }).join('') + (filtered.length > 200 ? `<p class="muted-copy">上位200件を表示しています。検索で絞り込めます。</p>` : '');
}

function initAnalysisControls() {
    document.querySelectorAll('[role="tab"][data-analysis-tab]').forEach(button => {
        button.addEventListener('click', () => {
            setAnalysisTab(button.dataset.analysisTab);
            renderAnalysis();
        });
        button.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const next = analysisTab === 'trend' ? 'items' : 'trend';
            setAnalysisTab(next);
            renderAnalysis();
            document.querySelector(`[role="tab"][data-analysis-tab="${next}"]`)?.focus();
        });
    });
    document.querySelectorAll('[data-trend-range]').forEach(button => {
        button.addEventListener('click', () => {
            trendRange = Number(button.dataset.trendRange) || 6;
            document.querySelectorAll('[data-trend-range]').forEach(other => {
                const active = other === button;
                other.classList.toggle('is-active', active);
                other.setAttribute('aria-pressed', String(active));
            });
            renderTrendPanel();
        });
    });
    let timer = 0;
    document.getElementById('item-search').addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(renderItemsPanel, 120);
    });
    document.getElementById('item-category-filter').addEventListener('change', renderItemsPanel);
    document.getElementById('item-sort').addEventListener('change', renderItemsPanel);
}

function openItemDetail(name) {
    const item = buildItemIndex().find(entry => entry.name === name);
    if (!item) {
        showToast('この品目の購入記録が見つかりませんでした', 'alert');
        return;
    }
    const history = item.purchases.slice().reverse();
    const changeText = item.change === null ? '1回だけ購入'
        : `${formatCurrency(Math.round(item.previousAvg))}（それまでの平均）→ ${formatCurrency(item.lastUnit)}`;
    const body = `
        <div class="detail-hero">
            <p class="detail-hero-label">${categoryDot(item.category)}${escapeHtml(item.category)}</p>
            <p class="detail-hero-value">${formatCurrency(item.lastUnit)}<small> 最後に買った価格</small></p>
            ${item.change !== null ? `<span class="delta delta-${item.change > 0 ? 'up' : (item.change < 0 ? 'down' : 'flat')}">${item.change ? icon(item.change > 0 ? 'arrow-up' : 'arrow-down') : ''}${formatPercent(item.change)} · ${escapeHtml(changeText)}</span>` : `<span class="muted-copy">${escapeHtml(changeText)}</span>`}
        </div>
        <div class="stat-row stat-row-compact">
            <div class="stat-tile"><span class="stat-label">平均</span><strong class="stat-value">${formatCurrency(item.avgUnit)}</strong></div>
            <div class="stat-tile"><span class="stat-label">最安</span><strong class="stat-value">${formatCurrency(item.minUnit)}</strong></div>
            <div class="stat-tile"><span class="stat-label">最高</span><strong class="stat-value">${formatCurrency(item.maxUnit)}</strong></div>
            <div class="stat-tile"><span class="stat-label">購入</span><strong class="stat-value">${item.count}<small>回</small></strong></div>
        </div>
        ${item.count >= 2 ? `
        <h4 class="detail-section-title">価格の推移</h4>
        <div class="chart-box chart-box-item"><canvas id="item-price-chart" role="img" aria-label="${escapeHtml(item.name)}の購入ごとの価格"></canvas></div>` : ''}
        <h4 class="detail-section-title">購入履歴</h4>
        <div class="table-scroll">
            <table class="detail-items-table">
                <thead><tr><th scope="col">日付</th><th scope="col">お店</th><th scope="col" class="num">単価</th><th scope="col" class="num">数量</th></tr></thead>
                <tbody>${history.map(purchase => `
                    <tr>
                        <td>${escapeHtml(formatDate(purchase.date))}</td>
                        <td>${escapeHtml(purchase.store || '—')}</td>
                        <td class="num">${formatCurrency(purchase.unit)}</td>
                        <td class="num">${purchase.quantity}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
    showDetailModal(item.name, body, element => {
        if (item.count >= 2) renderItemPriceChart(element.querySelector('#item-price-chart'), item);
    }, [
        { label: '閉じる', variant: 'secondary' },
        { label: '品名・カテゴリを編集', icon: 'pencil', variant: 'primary', close: false, onClick: () => { openItemEditor(item); return false; } }
    ]);
}

function renderItemPriceChart(canvas, item) {
    destroyChart('item');
    if (typeof Chart === 'undefined' || !canvas) return;
    const theme = chartTheme();
    const color = slotColor(window.KakeiboSettings.colorSlot(item.category));
    charts.item = new Chart(canvas, {
        type: 'line',
        data: {
            labels: item.purchases.map(purchase => `${purchase.date.getMonth() + 1}/${purchase.date.getDate()}`),
            datasets: [{
                label: item.name,
                data: item.purchases.map(purchase => purchase.unit),
                borderColor: color,
                backgroundColor: color,
                borderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointHitRadius: 14,
                pointBorderColor: theme.surface,
                pointBorderWidth: 2,
                tension: 0
            }]
        },
        plugins: [crosshairPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...baseTooltip(theme),
                    callbacks: {
                        title: items => items.length ? formatDate(item.purchases[items[0].dataIndex].date) : '',
                        label: entry => ` ${formatCurrency(entry.parsed.y)}  ${item.purchases[entry.dataIndex].store || ''}`
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, border: { color: theme.axis }, ticks: { color: theme.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
                y: {
                    grid: { color: theme.grid, drawTicks: false },
                    border: { display: false },
                    grace: '15%',
                    ticks: { color: theme.muted, padding: 6, maxTicksLimit: 4, callback: value => `¥${Math.round(value).toLocaleString('ja-JP')}` }
                }
            }
        }
    });
}

function openItemEditor(item) {
    const names = buildItemIndex().map(entry => entry.name).filter(name => name !== item.name);
    const options = categoryNames().map(name => `<option value="${escapeHtml(name)}" ${name === item.category ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    showDetailModal('品名・カテゴリを編集', `
        <form class="stack-form" id="item-edit-form" novalidate>
            <label class="field">
                <span class="field-label">品名</span>
                <input class="form-input" name="name" value="${escapeHtml(item.name)}" list="item-name-options" maxlength="300" required>
                <datalist id="item-name-options">${names.slice(0, 300).map(name => `<option value="${escapeHtml(name)}"></option>`).join('')}</datalist>
                <span class="field-help">すでにある品名にすると、同じ品としてまとめて集計します（表記ゆれの統合）。</span>
            </label>
            <label class="field">
                <span class="field-label">カテゴリ</span>
                <select class="form-input select-input" name="category">${options}</select>
            </label>
            <p class="field-help">これまでの${item.count}回分の記録がすべて変更されます。</p>
        </form>`, null, [
        { label: 'キャンセル', variant: 'secondary' },
        {
            label: '保存', variant: 'primary', close: false, onClick: async button => {
                const form = document.getElementById('item-edit-form');
                const name = form.elements.name.value.trim();
                const category = form.elements.category.value;
                if (!name) {
                    showToast('品名を入力してください', 'alert');
                    return false;
                }
                button.disabled = true;
                try {
                    await window.KakeiboShared.requestJson('/items/master', {
                        method: 'PATCH',
                        body: JSON.stringify({ old_name: item.name, new_name: name, category })
                    });
                    await loadSharedData({ force: true });
                    showToast(names.includes(name) ? `「${item.name}」を「${name}」にまとめました` : `「${name}」を更新しました`);
                    openItemDetail(name);
                } catch (error) {
                    showToast(error instanceof Error ? error.message : '品目を更新できませんでした', 'alert');
                    button.disabled = false;
                }
                return false;
            }
        }
    ]);
}


// ===== 設定 =====
function renderSettings() {
    renderAccountCard();
    renderBudgetForm();
    renderCategorySettings();
    renderRecurringSettings();
    renderThemeSwitch();
    updateStorageStatus();
    window.KakeiboAccess?.load();
}

function renderAccountCard() {
    const user = window.KakeiboAuth?.getUser?.();
    const enabled = Boolean(window.KakeiboAuth?.enabled);
    const name = document.getElementById('settings-user-name');
    const email = document.getElementById('settings-user-email');
    const avatar = document.getElementById('settings-avatar');
    const signOut = document.getElementById('settings-sign-out');
    name.textContent = user?.name || (enabled ? 'ログインしていません' : 'この端末で表示中');
    email.textContent = [user?.email, user?.household?.name].filter(Boolean).join(' · ') || (enabled ? '' : 'ログインなしのローカル表示です');
    avatar.textContent = (user?.name || user?.email || '家').trim().charAt(0).toUpperCase();
    if (user?.picture) {
        avatar.style.backgroundImage = `url("${String(user.picture).replace(/["\\]/g, '')}")`;
        avatar.classList.add('has-image');
    } else {
        avatar.style.backgroundImage = '';
        avatar.classList.remove('has-image');
    }
    signOut.hidden = !enabled || !user;
}

function renderBudgetForm() {
    const settings = window.KakeiboSettings.get();
    const total = document.getElementById('budget-total');
    if (document.activeElement !== total) total.value = settings.monthly_budget > 0 ? String(settings.monthly_budget) : '';
    const sum = settings.categories.reduce((acc, category) => acc + category.budget, 0);
    document.getElementById('budget-total-help').textContent = settings.monthly_budget > 0
        ? `カテゴリ予算の合計は${formatCurrency(sum)}です。${sum > settings.monthly_budget ? '月の予算を超えています。' : ''}`
        : `空欄にすると、カテゴリ予算の合計（いま${formatCurrency(sum)}）を月の予算にします。`;
    const spent = {};
    summarizeMonth(startOfMonth(new Date())).spentEntries.forEach(entry => {
        Object.entries(categoryTotals(entry)).forEach(([name, value]) => { spent[name] = (spent[name] || 0) + value; });
    });
    document.getElementById('budget-category-list').innerHTML = settings.categories.map((category, index) => `
        <label class="budget-row">
            <span class="budget-row-name">${categoryDot(category.name)}${escapeHtml(category.name)}</span>
            <span class="budget-row-hint">今月 ${formatCurrency(spent[category.name] || 0)}</span>
            <span class="money-input money-input-sm">
                <span aria-hidden="true">¥</span>
                <input class="form-input" type="number" inputmode="numeric" min="0" step="1000" data-budget-index="${index}" value="${category.budget > 0 ? category.budget : ''}" placeholder="なし" aria-label="${escapeHtml(category.name)}の予算">
            </span>
        </label>`).join('');
}

async function saveBudgetForm(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const settings = window.KakeiboSettings.get();
    settings.monthly_budget = Math.max(0, Math.round(Number(document.getElementById('budget-total').value) || 0));
    form.querySelectorAll('[data-budget-index]').forEach(input => {
        const category = settings.categories[Number(input.dataset.budgetIndex)];
        if (category) category.budget = Math.max(0, Math.round(Number(input.value) || 0));
    });
    button.disabled = true;
    try {
        await window.KakeiboSettings.save(settings);
        showToast('予算を保存しました');
        renderSettings();
    } catch (error) {
        showToast(error instanceof Error ? error.message : '予算を保存できませんでした', 'alert');
    } finally {
        button.disabled = false;
    }
}

function categoryUsage() {
    const usage = {};
    appData.receipts.forEach(receipt => (receipt.items || []).forEach(item => {
        usage[item.category] = (usage[item.category] || 0) + 1;
    }));
    return usage;
}

function renderCategorySettings() {
    const usage = categoryUsage();
    const settings = window.KakeiboSettings.get();
    document.getElementById('category-settings').innerHTML = settings.categories.map(category => {
        const fixed = category.name === window.KakeiboSettings.FALLBACK_CATEGORY;
        return `
            <div class="settings-row">
                <button type="button" class="swatch-button" data-category-color="${escapeHtml(category.name)}" aria-label="${escapeHtml(category.name)}の色を変更" style="--dot:var(--${category.color})"></button>
                <span class="settings-row-main">
                    <span class="settings-row-title">${escapeHtml(category.name)}</span>
                    <span class="settings-row-meta">${usage[category.name] || 0}件の品目${category.budget ? ` · 予算 ${formatCurrency(category.budget)}` : ''}${fixed ? ' · 読み取りの受け皿として常に残ります' : ''}</span>
                </span>
                <span class="settings-row-actions">
                    ${fixed ? '' : `
                    <button type="button" class="btn btn-icon" data-category-rename="${escapeHtml(category.name)}" aria-label="${escapeHtml(category.name)}の名前を変更">${icon('pencil')}</button>
                    <button type="button" class="btn btn-icon" data-category-delete="${escapeHtml(category.name)}" aria-label="${escapeHtml(category.name)}を削除">${icon('trash')}</button>`}
                </span>
            </div>`;
    }).join('');
}

function colorPickerHtml(selected) {
    return `<div class="swatch-grid" role="radiogroup" aria-label="色">${window.KakeiboSettings.COLOR_SLOTS.map(slot => `
        <label class="swatch-option">
            <input type="radio" name="color" value="${slot}" ${slot === selected ? 'checked' : ''}>
            <span class="swatch" style="--dot:var(--${slot})" aria-hidden="true"></span>
            <span class="visually-hidden">${slot === 'gray' ? 'グレー' : `色${slot.slice(1)}`}</span>
        </label>`).join('')}</div>
        <p class="field-help">色は見分けやすさを検証した9色から選べます。グラフでは名前も一緒に表示します。</p>`;
}

function openCategoryEditor(name = null) {
    const settings = window.KakeiboSettings.get();
    const existing = name ? settings.categories.find(category => category.name === name) : null;
    const color = existing?.color || window.KakeiboSettings.nextColorSlot();
    showDetailModal(existing ? 'カテゴリを編集' : 'カテゴリを追加', `
        <form class="stack-form" id="category-form" novalidate>
            <label class="field">
                <span class="field-label">名前</span>
                <input class="form-input" name="name" maxlength="40" value="${escapeHtml(existing?.name || '')}" placeholder="例: 子ども、ペット、医療" required>
            </label>
            <fieldset class="field">
                <legend class="field-label">色</legend>
                ${colorPickerHtml(color)}
            </fieldset>
            ${existing ? `<p class="field-help">名前を変えると、これまでの${categoryUsage()[existing.name] || 0}件の品目もまとめて変わります。</p>` : ''}
        </form>`, body => body.querySelector('input[name="name"]')?.focus(), [
        { label: 'キャンセル', variant: 'secondary' },
        {
            label: existing ? '保存' : '追加', variant: 'primary', close: false, onClick: async button => {
                const form = document.getElementById('category-form');
                const nextName = form.elements.name.value.trim();
                const nextColor = form.querySelector('input[name="color"]:checked')?.value || color;
                if (!nextName) { showToast('名前を入力してください', 'alert'); return false; }
                const current = window.KakeiboSettings.get();
                if ((!existing || nextName !== existing.name) && current.categories.some(category => category.name === nextName)) {
                    showToast(`「${nextName}」はすでにあります。統合するには削除から移動先に選んでください`, 'alert');
                    return false;
                }
                button.disabled = true;
                try {
                    if (existing && nextName !== existing.name) {
                        const result = await window.KakeiboSettings.reassignCategory(existing.name, nextName, appData.receipts);
                        await loadSharedData({ force: true });
                        showToast(`「${existing.name}」を「${nextName}」に変更しました（${result.affected}件の記録）`);
                    }
                    const latest = window.KakeiboSettings.get();
                    const target = latest.categories.find(category => category.name === (existing ? nextName : null));
                    if (target) {
                        target.color = nextColor;
                    } else if (!existing) {
                        const fallbackIndex = latest.categories.findIndex(category => category.name === window.KakeiboSettings.FALLBACK_CATEGORY);
                        latest.categories.splice(fallbackIndex < 0 ? latest.categories.length : fallbackIndex, 0, { name: nextName, color: nextColor, budget: 0 });
                    }
                    await window.KakeiboSettings.save(latest);
                    if (!existing) showToast(`「${nextName}」を追加しました`);
                    closeDetailModal();
                    renderSettings();
                } catch (error) {
                    showToast(error instanceof Error ? error.message : 'カテゴリを保存できませんでした', 'alert');
                    button.disabled = false;
                }
                return false;
            }
        }
    ]);
}

function openCategoryDelete(name) {
    const settings = window.KakeiboSettings.get();
    const count = categoryUsage()[name] || 0;
    const targets = settings.categories.filter(category => category.name !== name);
    showDetailModal(`「${name}」を削除`, `
        <form class="stack-form" id="category-delete-form" novalidate>
            <p class="detail-copy">${count ? `このカテゴリの品目${count}件と予算は、選んだカテゴリへ移します。` : 'このカテゴリを使っている記録はありません。'}</p>
            <label class="field">
                <span class="field-label">移動先</span>
                <select class="form-input select-input" name="target">${targets.map(category => `<option value="${escapeHtml(category.name)}" ${category.name === window.KakeiboSettings.FALLBACK_CATEGORY ? 'selected' : ''}>${escapeHtml(category.name)}</option>`).join('')}</select>
            </label>
        </form>`, null, [
        { label: 'キャンセル', variant: 'secondary' },
        {
            label: '削除する', icon: 'trash', variant: 'danger', close: false, onClick: async button => {
                const target = document.getElementById('category-delete-form').elements.target.value;
                button.disabled = true;
                try {
                    const result = await window.KakeiboSettings.reassignCategory(name, target, appData.receipts);
                    await loadSharedData({ force: true });
                    closeDetailModal();
                    showToast(`「${name}」を削除し、${result.affected}件の記録を「${target}」へ移しました`, 'trash');
                    renderSettings();
                } catch (error) {
                    showToast(error instanceof Error ? error.message : 'カテゴリを削除できませんでした', 'alert');
                    button.disabled = false;
                }
                return false;
            }
        }
    ]);
}

function renderRecurringSettings() {
    const settings = window.KakeiboSettings.get();
    const container = document.getElementById('recurring-settings');
    if (!settings.recurring.length) {
        container.innerHTML = '<p class="muted-copy">まだ登録されていません。家賃、通信費、サブスクなどを登録すると、毎月の支出に自動で入ります。</p>';
        return;
    }
    const monthly = settings.recurring.filter(expense => !expense.end_month || expense.end_month >= monthKey(new Date()))
        .reduce((sum, expense) => sum + expense.amount, 0);
    container.innerHTML = `<p class="settings-summary">毎月の固定費 ${formatCurrency(monthly)}${settings.recurring.some(expense => !expense.amount) ? ' ＋ 毎月入力するもの' : ''}</p>` +
        settings.recurring.map(expense => {
            const ended = expense.end_month && expense.end_month < monthKey(new Date());
            return `
            <div class="settings-row${ended ? ' is-muted' : ''}">
                <span class="settings-row-icon">${icon('repeat')}</span>
                <span class="settings-row-main">
                    <span class="settings-row-title">${escapeHtml(expense.name)}</span>
                    <span class="settings-row-meta">${categoryDot(expense.category)}${escapeHtml(expense.category)} · 毎月${expense.day}日${expense.end_month ? ` · ${expense.end_month.replace('-', '年')}月まで` : ''}${ended ? '（終了）' : ''}</span>
                </span>
                <span class="settings-row-value">${expense.amount ? formatCurrency(expense.amount) : '毎月入力'}</span>
                <span class="settings-row-actions">
                    <button type="button" class="btn btn-icon" data-recurring-edit="${escapeHtml(expense.id)}" aria-label="${escapeHtml(expense.name)}を編集">${icon('pencil')}</button>
                </span>
            </div>`;
        }).join('');
}

function openRecurringEditor(expense = null, preset = {}) {
    const base = expense || {
        id: window.KakeiboSettings.recurringId(),
        name: preset.name || '',
        amount: preset.amount || 0,
        category: preset.category || '住居・光熱',
        day: preset.day || new Date().getDate(),
        start_month: preset.start_month || monthKey(new Date()),
        end_month: '',
        memo: ''
    };
    const categories = categoryNames();
    if (!categories.includes(base.category)) base.category = categories[0] || 'その他';
    showDetailModal(expense ? '固定費を編集' : '固定費を追加', `
        <form class="stack-form" id="recurring-form" novalidate>
            <label class="field">
                <span class="field-label">名前</span>
                <input class="form-input" name="name" maxlength="100" value="${escapeHtml(base.name)}" placeholder="例: 家賃、スマホ代、動画配信" required>
            </label>
            <label class="field">
                <span class="field-label">金額</span>
                <span class="money-input"><span aria-hidden="true">¥</span><input class="form-input" name="amount" type="number" inputmode="numeric" min="0" step="1" value="${base.amount || ''}" placeholder="毎月変わる場合は空欄"></span>
                <span class="field-help">空欄にすると毎月の金額をホームで記録できます（電気代・ガス代など）。</span>
            </label>
            <div class="field-row">
                <label class="field">
                    <span class="field-label">カテゴリ</span>
                    <select class="form-input select-input" name="category">${categories.map(name => `<option value="${escapeHtml(name)}" ${name === base.category ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select>
                </label>
                <label class="field">
                    <span class="field-label">支払日</span>
                    <select class="form-input select-input" name="day">${Array.from({ length: 31 }, (_, index) => index + 1).map(day => `<option value="${day}" ${day === base.day ? 'selected' : ''}>毎月${day}日${day === 31 ? '（月末）' : ''}</option>`).join('')}</select>
                </label>
            </div>
            <div class="field-row">
                <label class="field">
                    <span class="field-label">開始月</span>
                    <input class="form-input" name="start_month" type="month" value="${escapeHtml(base.start_month)}" required>
                </label>
                <label class="field">
                    <span class="field-label">終了月</span>
                    <input class="form-input" name="end_month" type="month" value="${escapeHtml(base.end_month)}">
                    <span class="field-help">解約した場合などに入力</span>
                </label>
            </div>
            <label class="field">
                <span class="field-label">メモ</span>
                <input class="form-input" name="memo" maxlength="200" value="${escapeHtml(base.memo)}" placeholder="任意">
            </label>
        </form>`, body => body.querySelector('input[name="name"]')?.focus(), [
        ...(expense ? [{
            label: '削除', icon: 'trash', variant: 'danger', close: false, onClick: async () => {
                if (!window.confirm(`固定費「${expense.name}」を削除します。これまでに自動計上していた分も表示されなくなります。解約しただけなら終了月を入れてください。`)) return false;
                const settings = window.KakeiboSettings.get();
                settings.recurring = settings.recurring.filter(item => item.id !== expense.id);
                try {
                    await window.KakeiboSettings.save(settings);
                    closeDetailModal();
                    showToast(`「${expense.name}」を削除しました`, 'trash');
                    renderCurrentPage();
                } catch (error) {
                    showToast(error instanceof Error ? error.message : '固定費を削除できませんでした', 'alert');
                }
                return false;
            }
        }] : [{ label: 'キャンセル', variant: 'secondary' }]),
        {
            label: '保存', variant: 'primary', close: false, onClick: async button => {
                const form = document.getElementById('recurring-form');
                const next = {
                    id: base.id,
                    name: form.elements.name.value.trim(),
                    amount: Math.max(0, Math.round(Number(form.elements.amount.value) || 0)),
                    category: form.elements.category.value,
                    day: Number(form.elements.day.value) || 1,
                    start_month: form.elements.start_month.value || monthKey(new Date()),
                    end_month: form.elements.end_month.value || '',
                    memo: form.elements.memo.value.trim()
                };
                if (!next.name) { showToast('名前を入力してください', 'alert'); return false; }
                if (next.end_month && next.end_month < next.start_month) { showToast('終了月は開始月以降にしてください', 'alert'); return false; }
                const settings = window.KakeiboSettings.get();
                const index = settings.recurring.findIndex(item => item.id === next.id);
                if (index >= 0) settings.recurring.splice(index, 1, next);
                else settings.recurring.push(next);
                button.disabled = true;
                try {
                    await window.KakeiboSettings.save(settings);
                    closeDetailModal();
                    showToast(`固定費「${next.name}」を保存しました`, 'repeat');
                    renderCurrentPage();
                } catch (error) {
                    showToast(error instanceof Error ? error.message : '固定費を保存できませんでした', 'alert');
                    button.disabled = false;
                }
                return false;
            }
        }
    ]);
}

// ===== テーマ =====
function currentThemeChoice() {
    try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        return stored === 'light' || stored === 'dark' ? stored : 'auto';
    } catch (_) {
        return 'auto';
    }
}

function applyTheme(choice) {
    if (choice === 'light' || choice === 'dark') document.documentElement.dataset.theme = choice;
    else delete document.documentElement.dataset.theme;
    try {
        if (choice === 'auto') localStorage.removeItem(THEME_STORAGE_KEY);
        else localStorage.setItem(THEME_STORAGE_KEY, choice);
    } catch (_) { /* 保存できなくても今回の表示には反映する */ }
    renderThemeSwitch();
    renderCurrentPage();
}

function renderThemeSwitch() {
    const choice = currentThemeChoice();
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
        const active = button.dataset.themeChoice === choice;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-checked', String(active));
    });
}

// ===== 書き出し =====
function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv() {
    const header = ['日付', '種類', 'お店・支払先', '品名', 'カテゴリ', '単価', '数量', '金額', 'メモ', '状態'];
    const rows = [header];
    sortByDateDesc(appData.receipts).forEach(receipt => {
        const kind = { receipt: 'レシート', manual: '手入力', recurring: '固定費' }[entryKind(receipt)];
        const date = formatDate(receipt.date);
        (receipt.items.length ? receipt.items : [{ name: '', category: '', price: 0, quantity: 1, line_total: receipt.total }]).forEach(item => {
            rows.push([date, kind, receipt.store, item.name, item.category, item.price, item.quantity, getItemLineTotal(item), receipt.memo || '', receipt.status]);
        });
    });
    const csv = '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `kakeibo-${toInputDate(new Date())}.csv`);
    showToast('CSVを書き出しました。Excelやスプレッドシートで開けます', 'download');
}

function downloadDataBackup() {
    const blob = new Blob([JSON.stringify(makeDataSnapshot(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, `kakeibo-backup-${toInputDate(new Date())}.json`);
    showToast('バックアップを書き出しました', 'download');
}

function initSettingsControls() {
    document.getElementById('budget-form').addEventListener('submit', saveBudgetForm);
    document.getElementById('btn-add-category').addEventListener('click', () => openCategoryEditor());
    document.getElementById('btn-add-recurring').addEventListener('click', () => openRecurringEditor());
    document.getElementById('category-settings').addEventListener('click', event => {
        const rename = event.target.closest('[data-category-rename]');
        const remove = event.target.closest('[data-category-delete]');
        const color = event.target.closest('[data-category-color]');
        if (rename) openCategoryEditor(rename.dataset.categoryRename);
        if (remove) openCategoryDelete(remove.dataset.categoryDelete);
        if (color) openCategoryEditor(color.dataset.categoryColor);
    });
    document.getElementById('recurring-settings').addEventListener('click', event => {
        const button = event.target.closest('[data-recurring-edit]');
        if (!button) return;
        const expense = window.KakeiboSettings.get().recurring.find(item => item.id === button.dataset.recurringEdit);
        if (expense) openRecurringEditor(expense);
    });
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
        button.addEventListener('click', () => applyTheme(button.dataset.themeChoice));
    });
    document.getElementById('settings-sign-out').addEventListener('click', () => document.getElementById('btn-sign-out')?.click());
    document.getElementById('btn-export-csv').addEventListener('click', downloadCsv);
    document.getElementById('btn-export-data').addEventListener('click', downloadDataBackup);
    document.getElementById('btn-sync-data').addEventListener('click', () => loadSharedData({ announce: true, force: true }));
}

// ===== 手入力 =====
const entryForm = { mode: 'new', entry: null, recurring: null, category: null };

function renderEntryCategoryChips(selected) {
    const container = document.getElementById('entry-category-chips');
    const names = categoryNames();
    if (selected && !names.includes(selected)) names.push(selected);
    container.innerHTML = names.map(name => `
        <label class="category-chip">
            <input type="radio" name="entry-category" value="${escapeHtml(name)}" ${name === selected ? 'checked' : ''}>
            <span>${categoryDot(name)}${escapeHtml(name)}</span>
        </label>`).join('');
}

function parseAmount(text) {
    const normalized = String(text || '').replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0)).replace(/[^\d]/g, '');
    return normalized ? Math.min(100000000, Number(normalized)) : 0;
}

// options: { entry } 既存の手入力を編集 / { recurring, date } 固定費の今月分 / { } 新規
function openManualEntry(options = {}) {
    const modal = document.getElementById('entry-modal');
    const { entry = null, recurring = null } = options;
    entryForm.mode = entry ? 'edit' : 'new';
    entryForm.entry = entry;
    entryForm.recurring = recurring;

    const item = entry?.items?.[0];
    const date = entry ? parseDate(entry.date) : (options.date ? parseDate(options.date) : new Date());
    const isCurrentMonthView = isSameMonth(currentMonth, new Date());
    const defaultDate = entry || options.date || isCurrentMonthView ? date : new Date(currentMonth.getFullYear(), currentMonth.getMonth(), Math.min(new Date().getDate(), daysInMonth(currentMonth)));

    const lastManual = sortByDateDesc(appData.receipts.filter(receipt => entryKind(receipt) === 'manual'))[0];
    const category = item?.category || recurring?.category || lastManual?.items?.[0]?.category || categoryNames()[0];
    document.getElementById('entry-modal-title').textContent = entry ? '手入力の記録を編集' : (recurring ? `${recurring.name}を記録` : '手入力で記録');
    document.getElementById('entry-amount').value = entry ? String(entryTotal(entry)) : (recurring?.amount ? String(recurring.amount) : '');
    document.getElementById('entry-name').value = item?.name || recurring?.name || '';
    document.getElementById('entry-store').value = entry && entry.store !== item?.name ? entry.store : '';
    document.getElementById('entry-memo').value = entry?.memo || '';
    document.getElementById('entry-date').value = toInputDate(defaultDate);
    renderEntryCategoryChips(category);

    const suggestions = [...new Set(appData.receipts.filter(receipt => entryKind(receipt) === 'manual').flatMap(receipt => (receipt.items || []).map(entryItem => entryItem.name)))].slice(0, 50);
    document.getElementById('entry-name-suggestions').innerHTML = suggestions.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');

    const repeatField = document.getElementById('entry-repeat-field');
    const repeat = document.getElementById('entry-repeat');
    repeat.checked = false;
    repeatField.hidden = Boolean(entry || recurring);
    const note = document.getElementById('entry-recurring-note');
    note.hidden = !recurring;
    note.textContent = recurring
        ? `固定費「${recurring.name}」の${formatMonthLabel(defaultDate)}分として記録します。${recurring.amount ? `設定している${formatCurrency(recurring.amount)}の代わりに、この金額で計上します。` : ''}`
        : '';
    document.getElementById('entry-delete').hidden = !entry;
    document.getElementById('entry-save').textContent = entry ? '保存' : '記録する';
    openOverlay(modal, { focus: '#entry-amount' });
}

function closeManualEntry() {
    closeOverlay(document.getElementById('entry-modal'));
}

async function saveManualEntry(event) {
    event.preventDefault();
    const amount = parseAmount(document.getElementById('entry-amount').value);
    const category = document.querySelector('input[name="entry-category"]:checked')?.value || 'その他';
    const name = document.getElementById('entry-name').value.trim() || category;
    const store = document.getElementById('entry-store').value.trim();
    const memo = document.getElementById('entry-memo').value.trim();
    const dateValue = document.getElementById('entry-date').value;
    if (!amount) {
        showToast('金額を入力してください', 'alert');
        document.getElementById('entry-amount').focus();
        return;
    }
    if (!dateValue) {
        showToast('日付を入力してください', 'alert');
        return;
    }
    const [y, m, d] = dateValue.split('-').map(Number);
    const existingTime = entryForm.entry ? parseDate(entryForm.entry.date) : null;
    const date = new Date(y, m - 1, d, existingTime ? existingTime.getHours() : 12, existingTime ? existingTime.getMinutes() : 0);
    const editing = entryForm.mode === 'edit' && entryForm.entry;
    const repeat = !editing && !entryForm.recurring && document.getElementById('entry-repeat').checked;
    const recurringId = entryForm.recurring?.id || entryForm.entry?.recurring_id || window.KakeiboSettings.linkedRecurringId(entryForm.entry)
        || (repeat ? window.KakeiboSettings.recurringId() : '');
    const body = {
        date: window.KakeiboSettings.localIso(date),
        store: store || name,
        // 古いサーバーでも固定費との対応が分かるよう、source_filenameにも保存する。
        source_filename: recurringId ? `recurring:${recurringId}` : '',
        image_storage: null,
        items: [{ name, price: amount, quantity: 1, category, line_total: amount }],
        total: amount,
        confidence: 1,
        status: 'manual',
        entry_type: 'manual',
        memo,
        recurring_id: recurringId
    };
    const save = document.getElementById('entry-save');
    save.disabled = true;
    try {
        const payload = await window.KakeiboShared.requestJson(editing ? `/receipts/${encodeURIComponent(entryForm.entry.id)}` : '/receipts', {
            method: editing ? 'PUT' : 'POST',
            body: JSON.stringify(body)
        });
        const saved = normalizePersistedReceipt({ ...body, ...payload.receipt }, appData.receipts.length);
        if (editing) {
            const index = appData.receipts.findIndex(receipt => String(receipt.id) === String(entryForm.entry.id));
            if (index >= 0) appData.receipts.splice(index, 1, saved);
        } else {
            appData.receipts.push(saved);
        }
        if (repeat) {
            // 今回の記録をその月の分として固定費に結びつけ、翌月以降は自動で計上する。
            const settings = window.KakeiboSettings.get();
            settings.recurring.push({
                id: recurringId,
                name,
                amount,
                category,
                day: d,
                start_month: monthKey(date),
                end_month: '',
                memo
            });
            await window.KakeiboSettings.save(settings).catch(error => showToast(error instanceof Error ? error.message : '固定費を保存できませんでした', 'alert'));
        }
        lastSharedSyncAt = Date.now();
        updateStorageStatus();
        closeManualEntry();
        const entryDate = startOfMonth(date);
        if (!isSameMonth(entryDate, currentMonth)) setMonth(entryDate);
        else renderCurrentPage();
        showToast(editing ? `「${name}」を更新しました` : `${formatCurrency(amount)}（${name}）を記録しました`);
    } catch (error) {
        showToast(error instanceof Error ? error.message : '記録できませんでした', 'alert');
    } finally {
        save.disabled = false;
    }
}

function initManualEntry() {
    const modal = document.getElementById('entry-modal');
    document.getElementById('entry-form').addEventListener('submit', saveManualEntry);
    document.getElementById('entry-close').addEventListener('click', closeManualEntry);
    document.getElementById('entry-cancel').addEventListener('click', closeManualEntry);
    modal.addEventListener('click', event => { if (event.target === modal) closeManualEntry(); });
    document.getElementById('entry-delete').addEventListener('click', async () => {
        if (entryForm.entry && await deleteEntry(entryForm.entry)) closeManualEntry();
    });
    // 3桁区切りで表示する。日本語入力の変換中に値を書き換えると数字が二重に入るため、確定後に整える。
    const amount = document.getElementById('entry-amount');
    const formatAmount = () => {
        const value = parseAmount(amount.value);
        const formatted = value ? value.toLocaleString('ja-JP') : '';
        if (amount.value !== formatted) amount.value = formatted;
    };
    amount.addEventListener('input', event => {
        if (event.isComposing) return;
        formatAmount();
    });
    amount.addEventListener('compositionend', formatAmount);
    amount.addEventListener('blur', formatAmount);
    document.getElementById('btn-manual-entry').addEventListener('click', () => openManualEntry());
}

// ===== 記録の入口（スマホの＋ボタン） =====
function uploadBlocked() {
    const upload = document.getElementById('btn-upload');
    return upload?.dataset.billingBlocked === 'true' ? (upload.title || 'AI読み取りの利用上限に達しています') : '';
}

function openRecordSheet() {
    const sheet = document.getElementById('record-sheet');
    const blocked = uploadBlocked();
    sheet.querySelectorAll('[data-record="camera"], [data-record="gallery"]').forEach(button => { button.disabled = Boolean(blocked); });
    const note = document.getElementById('record-sheet-note');
    note.hidden = !blocked;
    note.textContent = blocked ? `${blocked}。手入力は使えます。` : '';
    openOverlay(sheet);
}

function initRecordSheet() {
    const sheet = document.getElementById('record-sheet');
    document.getElementById('btn-record').addEventListener('click', openRecordSheet);
    sheet.addEventListener('click', event => {
        if (event.target === sheet || event.target.closest('[data-close-sheet]')) {
            closeOverlay(sheet);
            return;
        }
        const option = event.target.closest('[data-record]');
        if (!option || option.disabled) return;
        closeOverlay(sheet, { silent: true });
        const action = option.dataset.record;
        // ファイル選択はタップ操作の中で直接開く必要がある。
        if (action === 'camera') window.KakeiboUpload?.openCamera();
        if (action === 'gallery') window.KakeiboUpload?.openGallery();
        if (action === 'manual') openManualEntry();
    });
}

// ===== レシート画像の拡大表示（ピンチ・ダブルタップ・ホイール対応） =====
function createImageLightbox() {
    const root = document.getElementById('image-lightbox');
    const stage = document.getElementById('image-lightbox-stage');
    const image = document.getElementById('image-lightbox-image');
    const caption = document.getElementById('image-lightbox-caption');
    const closeButton = document.getElementById('image-lightbox-close');
    const MIN_SCALE = 1;
    const MAX_SCALE = 6;
    const pointers = new Map();
    let view = { scale: 1, x: 0, y: 0 };
    let gesture = null;
    let lastTap = null;
    let returnFocus = null;

    function clampScale(scale) {
        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    }

    // 拡大後も画像の端がステージ内側へ入り込みすぎないよう移動量を制限する。
    function applyView(next) {
        const scale = clampScale(next.scale);
        const maxX = Math.max(0, (image.offsetWidth * scale - stage.clientWidth) / 2);
        const maxY = Math.max(0, (image.offsetHeight * scale - stage.clientHeight) / 2);
        view = {
            scale,
            x: Math.min(maxX, Math.max(-maxX, next.x)),
            y: Math.min(maxY, Math.max(-maxY, next.y))
        };
        image.style.transform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
        root.classList.toggle('is-zoomed', view.scale > 1.01);
    }

    // ステージ中央を原点とした座標へ変換する。
    function stagePoint(clientX, clientY) {
        const rect = stage.getBoundingClientRect();
        return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    }

    // 指定点の下にある画像位置を固定したまま倍率を変える。
    function zoomAt(point, scale) {
        const target = clampScale(scale);
        const ratio = target / view.scale;
        applyView({
            scale: target,
            x: point.x - (point.x - view.x) * ratio,
            y: point.y - (point.y - view.y) * ratio
        });
    }

    function beginGesture() {
        const points = Array.from(pointers.values());
        if (points.length >= 2) {
            const [a, b] = points;
            gesture = {
                type: 'pinch',
                distance: Math.hypot(b.x - a.x, b.y - a.y) || 1,
                center: stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2),
                view: { ...view }
            };
        } else if (points.length === 1) {
            gesture = { type: 'pan', start: { x: points[0].x, y: points[0].y }, view: { ...view } };
        } else {
            gesture = null;
        }
    }

    function handleTap(pointer) {
        const now = performance.now();
        if (lastTap && now - lastTap.time < 320 && Math.hypot(pointer.x - lastTap.x, pointer.y - lastTap.y) < 30) {
            lastTap = null;
            if (view.scale > 1.01) applyView({ scale: 1, x: 0, y: 0 });
            else zoomAt(stagePoint(pointer.x, pointer.y), 2.5);
            return;
        }
        lastTap = { time: now, x: pointer.x, y: pointer.y };
    }

    function endPointer(event) {
        const pointer = pointers.get(event.pointerId);
        if (!pointer) return;
        pointers.delete(event.pointerId);
        if (event.type === 'pointerup' && pointers.size === 0 && gesture?.type === 'pan') {
            const moved = Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY);
            if (moved < 10 && performance.now() - pointer.downAt < 300) handleTap(pointer);
        }
        beginGesture();
    }

    stage.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        event.preventDefault();
        try {
            stage.setPointerCapture(event.pointerId);
        } catch (_) {
            // キャプチャできなくてもステージ内の操作は継続できる。
        }
        pointers.set(event.pointerId, {
            x: event.clientX,
            y: event.clientY,
            downX: event.clientX,
            downY: event.clientY,
            downAt: performance.now()
        });
        beginGesture();
    });

    stage.addEventListener('pointermove', event => {
        const pointer = pointers.get(event.pointerId);
        if (!pointer || !gesture) return;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        if (gesture.type === 'pinch' && pointers.size >= 2) {
            const [a, b] = Array.from(pointers.values());
            const center = stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
            const scale = clampScale(gesture.view.scale * (Math.hypot(b.x - a.x, b.y - a.y) || 1) / gesture.distance);
            const ratio = scale / gesture.view.scale;
            applyView({
                scale,
                x: center.x - (gesture.center.x - gesture.view.x) * ratio,
                y: center.y - (gesture.center.y - gesture.view.y) * ratio
            });
        } else if (gesture.type === 'pan') {
            applyView({
                scale: view.scale,
                x: gesture.view.x + pointer.x - gesture.start.x,
                y: gesture.view.y + pointer.y - gesture.start.y
            });
        }
    });

    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);
    stage.addEventListener('wheel', event => {
        event.preventDefault();
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        zoomAt(stagePoint(event.clientX, event.clientY), view.scale * Math.exp(-delta * 0.0018));
    }, { passive: false });

    root.querySelectorAll('[data-lightbox-zoom]').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.lightboxZoom;
            if (action === 'reset') applyView({ scale: 1, x: 0, y: 0 });
            else zoomAt({ x: 0, y: 0 }, view.scale * (action === 'in' ? 1.5 : 1 / 1.5));
        });
    });

    function open(src, label = '') {
        if (!src) return;
        returnFocus = document.activeElement;
        pointers.clear();
        gesture = null;
        lastTap = null;
        image.src = src;
        image.alt = label || 'レシート画像';
        caption.textContent = label;
        root.hidden = false;
        applyView({ scale: 1, x: 0, y: 0 });
        closeButton.focus();
    }

    function close() {
        if (root.hidden) return;
        root.hidden = true;
        pointers.clear();
        gesture = null;
        image.removeAttribute('src');
        if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
        returnFocus = null;
    }

    closeButton.addEventListener('click', close);
    image.addEventListener('load', () => applyView(view));
    window.addEventListener('resize', () => {
        if (!root.hidden) applyView(view);
    });
    document.addEventListener('keydown', event => {
        if (root.hidden) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
        } else if (event.key === '+' || event.key === '=') {
            zoomAt({ x: 0, y: 0 }, view.scale * 1.5);
        } else if (event.key === '-') {
            zoomAt({ x: 0, y: 0 }, view.scale / 1.5);
        } else if (event.key === '0') {
            applyView({ scale: 1, x: 0, y: 0 });
        }
    });

    return { open, close };
}

// ===== Human-in-the-Loop: アップロード & レビューモーダル =====
function initUploadModal() {
    const modal = document.getElementById('receipt-modal');
    const uploadZone = document.getElementById('upload-zone');
    const cameraInput = document.getElementById('camera-input');
    const galleryInput = document.getElementById('gallery-input');
    const cameraButton = document.getElementById('btn-open-camera');
    const galleryButton = document.getElementById('btn-select-gallery');
    const clearFilesButton = document.getElementById('btn-clear-files');
    const analyzeFilesButton = document.getElementById('btn-analyze-files');
    const uploadSelection = document.getElementById('upload-selection');
    const selectedFileList = document.getElementById('selected-file-list');
    const closeBtn = document.getElementById('close-modal');
    const cancelBtn = document.getElementById('btn-modal-cancel');
    const approveBtn = document.getElementById('btn-modal-approve');
    const addItemBtn = document.getElementById('btn-add-item');
    const modalDialog = modal.querySelector('.modal-review');
    const reviewSource = document.getElementById('review-source');
    const reviewSourceToggle = document.getElementById('review-source-toggle');
    const reviewSourceCaption = document.getElementById('review-source-caption');
    const reviewSourceOpen = document.getElementById('review-source-open');
    const reviewSourceImage = document.getElementById('review-source-image');
    const reviewSourceEmpty = document.getElementById('review-source-empty');
    const reviewSourceNote = document.getElementById('review-source-note');
    const reviewSourceThumbs = document.getElementById('review-source-thumbs');
    const receiptTotalInput = document.getElementById('review-receipt-total');
    const reviewTotalBar = document.getElementById('review-total-bar');
    const reviewTotalDiff = document.getElementById('review-total-diff');
    const reviewFooterDiff = document.getElementById('review-footer-diff');
    const mobileLayoutQuery = window.matchMedia('(max-width: 768px)');
    const imageLightbox = createImageLightbox();

    let currentStep = 1;
    let editingReceiptId = null;
    let reviewQueue = [];
    let currentReviewIndex = 0;
    let registeredReceiptCount = 0;
    let selectedUploadFiles = [];
    // 確認ステップで照合する元画像。previewUrlは確認ステップ終了時に解放する。
    let reviewImages = [];
    let reviewSourceMessage = '';
    let activeReviewImageIndex = 0;
    let reviewSourceCollapsed = false;
    let analysisRunId = 0;
    let storedImageRequestId = 0;
    reviewItems = [];

    // モーダルを開く
    function openUploadModal() {
        if (!modal.classList.contains('active')) openOverlay(modal, { focus: '#btn-open-camera' });
        goToStep(1);
    }
    document.getElementById('btn-upload').addEventListener('click', openUploadModal);

    // モーダルを閉じる
    function closeModal() {
        closeOverlay(modal, { silent: true });
        resetModal();
    }

    closeBtn.addEventListener('click', closeModal);

    async function discardEditingReceipt() {
        if (!editingReceiptId) {
            closeModal();
            return;
        }

        const index = appData.receipts.findIndex(item => String(item.id) === String(editingReceiptId));
        if (index < 0) {
            closeModal();
            return;
        }

        const removed = appData.receipts[index];
        if (!window.confirm(`${removed.store || 'レシート'}のレシートを削除します。この操作は同じ家計簿の全メンバーへ反映されます。`)) return;

        cancelBtn.disabled = true;
        try {
            await window.KakeiboShared.requestJson(`/receipts/${encodeURIComponent(editingReceiptId)}`, { method: 'DELETE' });
            appData.receipts.splice(index, 1);
            lastSharedSyncAt = Date.now();
            closeModal();
            updateStorageStatus();
            showToast(`${removed.store || 'レシート'}の記録を削除しました`, 'trash');
            renderCurrentPage();
        } catch (error) {
            console.error('共有レシートの削除に失敗しました。', error);
            showToast(error instanceof Error ? error.message : 'レシートを削除できませんでした', '⚠️');
        } finally {
            cancelBtn.disabled = false;
        }
    }

    cancelBtn.addEventListener('click', () => {
        if (currentStep === 3 && editingReceiptId) {
            discardEditingReceipt();
            return;
        }
        closeModal();
    });
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // ステップ遷移
    function goToStep(step) {
        currentStep = step;
        document.querySelectorAll('.modal-step').forEach(s => s.classList.remove('active'));

        if (step === 1) document.getElementById('step-upload').classList.add('active');
        if (step === 2) document.getElementById('step-progress').classList.add('active');
        if (step === 3) document.getElementById('step-review').classList.add('active');

        document.querySelectorAll('.step-indicator .step').forEach(s => {
            const sNum = parseInt(s.dataset.step);
            s.classList.remove('active', 'completed');
            if (sNum === step) s.classList.add('active');
            if (sNum < step) s.classList.add('completed');
        });

        const titles = { 1: 'レシートをアップロード', 2: 'AI解析中...', 3: 'AI解析結果の確認・修正' };
        document.getElementById('modal-title').textContent = titles[step];

        analyzeFilesButton.style.display = step === 1 ? 'inline-flex' : 'none';
        approveBtn.style.display = step === 3 ? 'inline-flex' : 'none';
        cancelBtn.textContent = step === 3 ? '破棄する' : 'キャンセル';
        if (step !== 3) reviewFooterDiff.hidden = true;
        updateReviewLayoutMode();
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;
    }

    function selectedFileKey(file) {
        return [file.name, file.size, file.lastModified, file.type].join(':');
    }

    function formatUploadFileSize(value) {
        const size = Math.max(0, Number(value) || 0);
        if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }

    function renderSelectedFiles() {
        const count = selectedUploadFiles.length;
        uploadSelection.hidden = count === 0;
        document.getElementById('selected-file-count').textContent = `${count}枚を選択中`;
        document.getElementById('selected-file-remaining').textContent = count >= 10
            ? '10枚の上限に達しました'
            : `あと${10 - count}枚追加できます`;
        document.getElementById('camera-action-label').textContent = count ? '続けて撮影' : 'カメラで撮影';
        document.getElementById('gallery-action-label').textContent = count ? '写真を追加' : '写真から選ぶ';
        cameraButton.disabled = count >= 10;
        galleryButton.disabled = count >= 10;
        clearFilesButton.disabled = count === 0;
        analyzeFilesButton.disabled = count === 0;
        analyzeFilesButton.textContent = count ? `選択した${count}枚をまとめて解析` : '選択した画像をまとめて解析';
        selectedFileList.innerHTML = selectedUploadFiles.map((entry, index) => {
            const name = entry.file.name || `撮影画像 ${index + 1}`;
            return `
                <article class="selected-file-item" role="listitem">
                    <img src="${escapeHtml(entry.previewUrl)}" alt="" class="selected-file-thumb">
                    <div class="selected-file-copy">
                        <strong>${escapeHtml(name)}</strong>
                        <span>${formatUploadFileSize(entry.file.size)}</span>
                    </div>
                    <button type="button" class="selected-file-remove" data-remove-selected="${index}" aria-label="${escapeHtml(name)}を選択から外す">×</button>
                </article>`;
        }).join('');
    }

    // keepPreviews: 解析済み画像のプレビューURLを確認ステップへ引き継ぐ場合は解放しない。
    function clearSelectedFiles({ keepPreviews = false } = {}) {
        if (!keepPreviews) selectedUploadFiles.forEach(entry => URL.revokeObjectURL(entry.previewUrl));
        selectedUploadFiles = [];
        cameraInput.value = '';
        galleryInput.value = '';
        renderSelectedFiles();
    }

    function addSelectedFiles(files) {
        const candidates = Array.from(files || []).filter(file => !file.type || file.type.startsWith('image/'));
        if (candidates.length === 0) {
            showToast('画像ファイルを選択してください', '⚠️');
            return;
        }

        const existingKeys = new Set(selectedUploadFiles.map(entry => entry.key));
        let duplicateCount = 0;
        let overflowCount = 0;
        candidates.forEach(file => {
            const key = selectedFileKey(file);
            if (existingKeys.has(key)) {
                duplicateCount += 1;
                return;
            }
            if (selectedUploadFiles.length >= 10) {
                overflowCount += 1;
                return;
            }
            existingKeys.add(key);
            selectedUploadFiles.push({ file, key, previewUrl: URL.createObjectURL(file) });
        });
        cameraInput.value = '';
        galleryInput.value = '';
        renderSelectedFiles();
        if (overflowCount) showToast(`最大10枚です。${overflowCount}枚は追加されませんでした`, '⚠️');
        else if (duplicateCount) showToast('同じ画像は重複せず1枚だけ追加しました', 'ℹ️');
    }

    cameraButton.addEventListener('click', () => {
        if (selectedUploadFiles.length >= 10) return;
        cameraInput.value = '';
        cameraInput.click();
    });
    galleryButton.addEventListener('click', () => {
        if (selectedUploadFiles.length >= 10) return;
        galleryInput.value = '';
        galleryInput.click();
    });
    cameraInput.addEventListener('change', event => addSelectedFiles(event.target.files));
    galleryInput.addEventListener('change', event => addSelectedFiles(event.target.files));
    clearFilesButton.addEventListener('click', clearSelectedFiles);
    selectedFileList.addEventListener('click', event => {
        const button = event.target.closest('[data-remove-selected]');
        if (!button) return;
        const index = Number(button.dataset.removeSelected);
        const [removed] = selectedUploadFiles.splice(index, 1);
        if (removed) URL.revokeObjectURL(removed.previewUrl);
        renderSelectedFiles();
    });
    analyzeFilesButton.addEventListener('click', () => {
        if (!selectedUploadFiles.length) {
            showToast('解析する画像を1枚以上追加してください', '⚠️');
            return;
        }
        const entries = selectedUploadFiles.slice();
        analyzeFilesButton.disabled = true;
        goToStep(2);
        analyzeFiles(entries);
    });

    // ドラッグ&ドロップ
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('dragover');
    });
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            addSelectedFiles(e.dataTransfer.files);
        }
    });

    // 実画像解析。APIへの送信は進捗演出より先に開始し、不要な待機を作らない。
    async function analyzeFiles(entries) {
        const files = entries.map(entry => entry.file);
        // 解析中にモーダルを閉じた場合は、遅れて届いた結果を表示しない。
        const runId = ++analysisRunId;
        const status = document.getElementById('analysis-status');
        const ocrProgress = document.getElementById('ocr-progress');
        const parseProgress = document.getElementById('parse-progress');
        const classifyProgress = document.getElementById('classify-progress');
        const ocrStep = document.getElementById('a-step-ocr');
        const parseStep = document.getElementById('a-step-parse');
        const classifyStep = document.getElementById('a-step-classify');

        status.classList.remove('error');
        [ocrProgress, parseProgress, classifyProgress].forEach(progress => {
            progress.classList.remove('is-indeterminate');
            progress.style.width = '0%';
        });
        [ocrStep, parseStep, classifyStep].forEach(s => {
            s.classList.remove('active', 'completed', 'error');
            s.querySelector('.a-step-status').textContent = '待機中';
        });

        // リクエストを直ちに開始する。失敗も値として保持し、画面遷移中の未処理例外を防ぐ。
        const analysisRequest = requestReceiptAnalysis(files).then(
            resultData => ({ ok: true, resultData }),
            error => ({ ok: false, error })
        );

        // Step 1: 画像送信（この演出中にも実際のリクエストは進行している）
        ocrStep.classList.add('active');
        ocrStep.querySelector('.a-step-status').textContent = '送信中...';
        status.textContent = '画像を解析APIへ送信しています...';

        try {
            await animateProgress(ocrProgress, 350);
            ocrStep.classList.remove('active');
            ocrStep.classList.add('completed');
            ocrStep.querySelector('.a-step-status').textContent = '送信済み ✓';

            // Step 2: OCR・品目抽出・金額補正・カテゴリ分類をAIが一括で行う。
            parseStep.classList.add('active');
            parseStep.querySelector('.a-step-status').textContent = '処理中...';
            status.textContent = 'AIが文字・品目・金額・カテゴリを一括解析中...';
            parseProgress.classList.add('is-indeterminate');

            const outcome = await analysisRequest;
            if (runId !== analysisRunId) return;
            if (!outcome.ok) throw outcome.error;
            const resultData = outcome.resultData;

            parseProgress.classList.remove('is-indeterminate');
            parseProgress.style.width = '100%';
            parseStep.classList.remove('active');
            parseStep.classList.add('completed');
            parseStep.querySelector('.a-step-status').textContent = '完了 ✓';

            // Step 3: 受信済みデータを画面表示用に整える短い工程。
            classifyStep.classList.add('active');
            classifyStep.querySelector('.a-step-status').textContent = '準備中...';
            status.textContent = '解析結果を表示する準備中...';
            await animateProgress(classifyProgress, 220);
            classifyStep.classList.remove('active');
            classifyStep.classList.add('completed');
            classifyStep.querySelector('.a-step-status').textContent = '完了 ✓';
            status.textContent = '解析完了！';
            if (runId !== analysisRunId) return;

            reviewQueue = resultData;
            currentReviewIndex = 0;
            registeredReceiptCount = 0;
            setReviewImages(entries.map((entry, index) => ({
                previewUrl: entry.previewUrl,
                name: entry.file.name || `撮影画像 ${index + 1}`
            })));
            clearSelectedFiles({ keepPreviews: true });
            goToStep(3);
            showReviewForm(reviewQueue[currentReviewIndex]);
        } catch (e) {
            if (runId !== analysisRunId) return;
            const message = e instanceof Error ? e.message : '画像解析に失敗しました';
            console.error('実画像解析に失敗しました:', e);
            [ocrProgress, parseProgress, classifyProgress].forEach(progress => {
                progress.classList.remove('is-indeterminate');
            });
            [ocrStep, parseStep, classifyStep].forEach(step => {
                step.classList.remove('active', 'completed');
                step.classList.add('error');
                step.querySelector('.a-step-status').textContent = '失敗';
            });
            status.classList.add('error');
            status.textContent = message;
            showToast(message, '⚠️');
            setTimeout(() => {
                goToStep(1);
                renderSelectedFiles();
            }, 700);
        }
    }

    // バックエンドAPIで実画像を解析する。API障害時にテストデータへは切り替えない。
    async function requestReceiptAnalysis(files) {
        const formData = new FormData();
        files.forEach(file => formData.append('files', file));
        const authHeaders = window.KakeiboAuth?.getAuthorizationHeaders?.() || {};
        if (window.KakeiboAuth?.enabled && !authHeaders.Authorization) {
            window.KakeiboAuth.handleUnauthorized();
            throw new Error('Googleログインが必要です。');
        }

        const res = await fetch(getReceiptAnalyzeUrl(), {
            method: 'POST',
            headers: authHeaders,
            body: formData
        });
        const resJson = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
            window.KakeiboAuth?.handleUnauthorized?.(resJson.detail || 'このGoogleアカウントでは利用できません。');
        }
        if (!res.ok) throw new Error(resJson.detail || `解析APIエラー (${res.status})`);
        if (!resJson.success) throw new Error(resJson.detail || '解析APIが失敗しました');

        const resultData = normalizeAnalysisResults(resJson, files);
        if (resultData.length === 0) throw new Error('画像からレシートを検出できませんでした');
        return resultData;
    }

    function getReceiptAnalyzeUrl() {
        const configuredBase = typeof window !== 'undefined' ? window.KAKEIBO_API_BASE_URL : '';
        const isLocalHost = typeof window !== 'undefined' && window.location
            && ['localhost', '127.0.0.1'].includes(window.location.hostname);
        const isHttpOrigin = typeof window !== 'undefined' && window.location
            && /^https?:$/.test(window.location.protocol);
        const defaultBase = isHttpOrigin && !isLocalHost
            ? window.location.origin
            : 'http://localhost:8000';
        const baseUrl = String(configuredBase || defaultBase).replace(/\/+$/, '');
        return `${baseUrl}/api/receipts/analyze`;
    }

    // 各レシートに、読み取り元となった選択画像の番号(source_image_index)を付ける。特定できなければnull。
    function normalizeAnalysisResults(payload, files = []) {
        const images = payload && Array.isArray(payload.images) ? payload.images : [];
        // APIは送信順に画像ごとの結果を返すため、件数が一致すれば番号で確実に対応付けられる。
        if (images.length > 0 && images.length === files.length) {
            const receipts = images.flatMap((image, imageIndex) => (Array.isArray(image.receipts) ? image.receipts : [])
                .map(receipt => ({ ...receipt, source_image_index: imageIndex })));
            if (receipts.length > 0) return receipts;
        }
        return extractAnalysisReceipts(payload).map(receipt => ({
            ...receipt,
            source_image_index: findSourceImageIndex(receipt, files)
        }));
    }

    function findSourceImageIndex(receipt, files) {
        if (files.length === 1) return 0;
        const filename = receipt && receipt.source_filename;
        if (!filename) return null;
        // 連続撮影では同名ファイルになることがあるため、一意に決まる場合だけ採用する。
        const matches = files.flatMap((file, index) => (file.name === filename ? [index] : []));
        return matches.length === 1 ? matches[0] : null;
    }

    function extractAnalysisReceipts(payload) {
        const receipts = payload && Array.isArray(payload.receipts) ? payload.receipts : [];
        if (receipts.length > 0) return receipts;

        if (payload && Array.isArray(payload.images)) {
            return payload.images.flatMap(image => Array.isArray(image.receipts) ? image.receipts : []);
        }
        if (payload && payload.data) {
            if (Array.isArray(payload.data.receipts)) return payload.data.receipts;
            if (payload.data.store || payload.data.items) return [payload.data];
        }
        if (payload && (payload.store || payload.items)) return [payload];
        return receipts;
    }

    function animateProgress(fillEl, duration) {
        return new Promise(resolve => {
            const start = performance.now();
            function update(now) {
                const elapsed = now - start;
                const progress = Math.min(elapsed / duration, 1);
                fillEl.style.width = (progress * 100) + '%';
                if (progress < 1) requestAnimationFrame(update);
                else resolve();
            }
            requestAnimationFrame(update);
        });
    }

    // レビューフォーム表示
    function showReviewForm(result) {
        document.getElementById('review-store').value = (result && result.store) || '';
        document.getElementById('review-date').value = (result && result.date) || '';

        const confidence = Math.max(0, Math.min(100, Math.round(Number(result && result.confidence) * 100 || 0)));
        document.getElementById('confidence-fill-lg').style.width = confidence + '%';
        document.getElementById('confidence-pct').textContent = confidence + '%';

        const receiptTotal = Number(result && result.total);
        receiptTotalInput.value = Number.isFinite(receiptTotal) && receiptTotal > 0 ? String(Math.round(receiptTotal)) : '';

        reviewItems = (Array.isArray(result && result.items) ? result.items : []).map((item, i) => ({ ...item, id: i }));
        updateReviewBatchStatus();
        renderReviewSource(result);
        renderReviewItems();
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;
        const itemsScroll = document.querySelector('.review-items-scroll');
        if (itemsScroll) itemsScroll.scrollLeft = 0;
    }

    // ===== 確認ステップの元画像 =====
    function setReviewImages(images) {
        clearReviewImages();
        reviewImages = images;
    }

    function clearReviewImages() {
        imageLightbox.close();
        reviewImages.forEach(image => URL.revokeObjectURL(image.previewUrl));
        reviewImages = [];
        reviewSourceMessage = '';
        activeReviewImageIndex = 0;
        reviewSourceImage.removeAttribute('src');
        reviewSourceThumbs.innerHTML = '';
    }

    // PC幅では画像と品目フォームを横並びにするため、画像がある確認ステップだけモーダルを広げる。
    function updateReviewLayoutMode() {
        const hasSource = currentStep === 3 && !reviewSource.hidden;
        modalDialog.classList.toggle('has-review-source', hasSource);
        const collapsible = mobileLayoutQuery.matches;
        reviewSource.classList.toggle('is-collapsed', collapsible && reviewSourceCollapsed);
        reviewSourceToggle.disabled = !collapsible;
        reviewSourceToggle.setAttribute('aria-expanded', String(!collapsible || !reviewSourceCollapsed));
    }

    function getLinkedImageIndex(result) {
        const index = result ? result.source_image_index : null;
        return Number.isInteger(index) && reviewImages[index] ? index : null;
    }

    function renderReviewSource(result) {
        const hasImages = reviewImages.length > 0;
        reviewSource.hidden = !hasImages && !reviewSourceMessage;
        updateReviewLayoutMode();
        reviewSourceOpen.hidden = !hasImages;
        reviewSourceEmpty.hidden = hasImages || !reviewSourceMessage;
        reviewSourceEmpty.textContent = hasImages ? '' : reviewSourceMessage;
        if (!hasImages) {
            reviewSourceCaption.textContent = '';
            reviewSourceNote.hidden = true;
            reviewSource.classList.remove('has-thumbs');
            reviewSourceThumbs.hidden = true;
            return;
        }
        const linkedIndex = getLinkedImageIndex(result);
        showReviewImage(linkedIndex ?? 0);
    }

    function showReviewImage(index) {
        const image = reviewImages[index];
        if (!image) return;
        const result = reviewQueue[currentReviewIndex];
        const linkedIndex = getLinkedImageIndex(result);
        const total = reviewImages.length;
        activeReviewImageIndex = index;
        reviewSourceImage.src = image.previewUrl;
        reviewSourceImage.alt = total > 1 ? `解析した画像 ${index + 1}枚目（${image.name}）` : `解析した画像（${image.name}）`;
        reviewSourceCaption.textContent = total > 1 ? `画像 ${index + 1} / ${total}` : image.name;

        let note = '';
        if (linkedIndex === null && total > 1) {
            note = 'どの画像から読み取ったか特定できませんでした。下の一覧で画像を切り替えて照合してください。';
        } else if (linkedIndex !== null && linkedIndex !== index) {
            note = `このレシートの読み取り元は画像 ${linkedIndex + 1} です。`;
        } else if (linkedIndex !== null) {
            const sameImage = reviewQueue.filter(receipt => getLinkedImageIndex(receipt) === linkedIndex);
            if (sameImage.length > 1) {
                note = `この画像から${sameImage.length}件のレシートを検出しました。いま確認しているのは${sameImage.indexOf(result) + 1}件目です。`;
            }
        }
        reviewSourceNote.textContent = note;
        reviewSourceNote.hidden = !note;

        reviewSource.classList.toggle('has-thumbs', total > 1);
        reviewSourceThumbs.hidden = total <= 1;
        reviewSourceThumbs.innerHTML = total <= 1 ? '' : reviewImages.map((entry, entryIndex) => {
            const isLinked = entryIndex === linkedIndex;
            const label = `画像 ${entryIndex + 1}を表示${isLinked ? '（このレシートの読み取り元）' : ''}`;
            return `
                <button type="button" class="review-source-thumb${entryIndex === index ? ' is-active' : ''}${isLinked ? ' is-linked' : ''}"
                    data-review-image="${entryIndex}" aria-pressed="${entryIndex === index}" aria-label="${escapeHtml(label)}">
                    <img src="${escapeHtml(entry.previewUrl)}" alt="">
                    <span class="review-source-thumb-index">${entryIndex + 1}</span>
                    ${isLinked ? '<span class="review-source-thumb-badge">読取元</span>' : ''}
                </button>`;
        }).join('');
    }

    // 保存済みレシートの編集時は、非公開ストレージの画像を認証付きで取得して表示する。
    async function loadStoredReceiptImage(receipt) {
        if (!receipt || !receipt.id || !receipt.image_storage?.object_name) return;
        const requestId = ++storedImageRequestId;
        reviewSourceMessage = '保存されたレシート画像を読み込み中...';
        renderReviewSource(reviewQueue[currentReviewIndex]);
        try {
            const response = await window.KakeiboShared.request(`/receipts/${encodeURIComponent(receipt.id)}/image`);
            if (!response.ok) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(payload.detail || 'レシート画像を読み込めませんでした。');
            }
            const blob = await response.blob();
            if (requestId !== storedImageRequestId) return;
            setReviewImages([{ previewUrl: URL.createObjectURL(blob), name: receipt.source_filename || '保存画像' }]);
            reviewQueue.forEach(entry => { entry.source_image_index = 0; });
        } catch (error) {
            if (requestId !== storedImageRequestId) return;
            reviewSourceMessage = error instanceof Error ? error.message : 'レシート画像を読み込めませんでした。';
        }
        renderReviewSource(reviewQueue[currentReviewIndex]);
    }

    reviewSourceThumbs.addEventListener('click', event => {
        const button = event.target.closest('[data-review-image]');
        if (button) showReviewImage(Number(button.dataset.reviewImage));
    });
    reviewSourceOpen.addEventListener('click', () => {
        const image = reviewImages[activeReviewImageIndex];
        if (image) imageLightbox.open(image.previewUrl, reviewSourceCaption.textContent);
    });
    reviewSourceToggle.addEventListener('click', () => {
        if (!mobileLayoutQuery.matches) return;
        reviewSourceCollapsed = !reviewSourceCollapsed;
        updateReviewLayoutMode();
    });
    mobileLayoutQuery.addEventListener?.('change', updateReviewLayoutMode);
    reviewFooterDiff.addEventListener('click', () => {
        reviewTotalBar.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    function updateReviewBatchStatus() {
        const status = document.getElementById('review-batch-status');
        if (!status || reviewQueue.length <= 1) {
            if (status) status.hidden = true;
            cancelBtn.textContent = '破棄する';
            return;
        }
        status.hidden = false;
        status.textContent = `${currentReviewIndex + 1} / ${reviewQueue.length} 件目を確認中`;
        cancelBtn.textContent = '残りを破棄';
    }

    // レビュー品目テーブル描画
    function renderReviewItems() {
        const tbody = document.getElementById('review-items-body');

        tbody.innerHTML = reviewItems.map((item, index) => `
            <tr data-index="${index}">
                <td data-label="品名"><input type="text" value="${escapeHtml(item.name)}" class="review-item-name" data-index="${index}"></td>
                <td class="col-price" data-label="単価"><input type="number" value="${item.price}" class="review-item-price" data-index="${index}" min="0"></td>
                <td class="col-qty" data-label="数量"><input type="number" value="${item.quantity}" class="review-item-qty" data-index="${index}" min="1"></td>
                <td class="col-category" data-label="カテゴリ">
                    <select class="review-item-category" data-index="${index}">
                        ${[...new Set([...categoryNames(), item.category].filter(Boolean))].map(name =>
                            `<option value="${escapeHtml(name)}" ${name === item.category ? 'selected' : ''}>${escapeHtml(name)}</option>`
                        ).join('')}
                    </select>
                </td>
                <td class="col-subtotal" data-label="小計">${formatCurrency(getItemLineTotal(item))}</td>
                <td class="col-action"><button class="btn-danger review-item-delete" data-index="${index}" type="button" title="削除" aria-label="品目を削除">✕</button></td>
            </tr>
        `).join('');

        // イベントリスナー
        tbody.querySelectorAll('.review-item-name').forEach(input => {
            input.addEventListener('input', (e) => {
                reviewItems[e.target.dataset.index].name = e.target.value;
            });
        });

        tbody.querySelectorAll('.review-item-price').forEach(input => {
            input.addEventListener('input', (e) => {
                const item = reviewItems[e.target.dataset.index];
                item.price = parseInt(e.target.value) || 0;
                item.line_total = item.price * (item.quantity || 1);
                updateReviewTotals();
            });
        });

        tbody.querySelectorAll('.review-item-qty').forEach(input => {
            input.addEventListener('input', (e) => {
                const item = reviewItems[e.target.dataset.index];
                item.quantity = parseInt(e.target.value) || 1;
                item.line_total = (item.price || 0) * item.quantity;
                updateReviewTotals();
            });
        });

        tbody.querySelectorAll('.review-item-category').forEach(select => {
            select.addEventListener('change', (e) => {
                reviewItems[e.target.dataset.index].category = e.target.value;
            });
        });

        tbody.querySelectorAll('.review-item-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const index = parseInt(e.target.dataset.index);
                reviewItems.splice(index, 1);
                renderReviewItems();
            });
        });

        updateReviewTotals();
    }

    // 合計更新
    function updateReviewTotals() {
        document.querySelectorAll('#review-items-body tr').forEach((tr, index) => {
            if (reviewItems[index]) {
                const subtotal = getItemLineTotal(reviewItems[index]);
                tr.querySelector('.col-subtotal').textContent = formatCurrency(subtotal);
            }
        });

        const total = reviewItems.reduce((s, item) => s + getItemLineTotal(item), 0);
        document.getElementById('review-total').textContent = formatCurrency(total);
        updateReviewTotalCheck(total);
    }

    // 品目の合計とレシート記載の合計を照合し、差額があれば本文とフッターの両方で知らせる。
    function updateReviewTotalCheck(itemsTotal) {
        const rawReceiptTotal = receiptTotalInput.value.trim();
        const receiptTotal = rawReceiptTotal === '' ? NaN : Math.round(Number(rawReceiptTotal));
        const hasReceiptTotal = Number.isFinite(receiptTotal) && receiptTotal > 0;
        const diff = hasReceiptTotal ? itemsTotal - receiptTotal : 0;
        const isMismatch = hasReceiptTotal && diff !== 0;
        reviewTotalBar.classList.toggle('is-mismatch', isMismatch);
        reviewTotalBar.classList.toggle('is-match', hasReceiptTotal && !isMismatch);
        reviewTotalDiff.hidden = !isMismatch;
        reviewFooterDiff.hidden = !isMismatch || currentStep !== 3;
        if (!isMismatch) return;

        const amount = formatCurrency(Math.abs(diff));
        document.getElementById('review-total-diff-amount').textContent = `差額 ${diff > 0 ? '+' : '−'}${amount}`;
        document.getElementById('review-total-diff-text').textContent = diff > 0
            ? `品目の合計がレシートより${amount}多くなっています。重複した品目や単価・数量を画像と見比べてください。`
            : `品目の合計がレシートより${amount}少なくなっています。読み取り漏れの品目や値引き・税額を画像と見比べてください。`;
        reviewFooterDiff.textContent = `⚠ レシート合計と${amount}の差額`;
    }

    receiptTotalInput.addEventListener('input', () => {
        updateReviewTotalCheck(reviewItems.reduce((sum, item) => sum + getItemLineTotal(item), 0));
    });

    // 品目追加
    addItemBtn.addEventListener('click', () => {
        reviewItems.push({
            id: reviewItems.length,
            name: '',
            price: 0,
            quantity: 1,
            category: categoryNames()[0] || 'その他'
        });
        renderReviewItems();
        const lastInput = document.querySelector('#review-items-body tr:last-child .review-item-name');
        if (lastInput) lastInput.focus();
    });

    // 承認して選択中の家計簿へ登録
    approveBtn.addEventListener('click', async () => {
        const store = document.getElementById('review-store').value.trim();
        const date = document.getElementById('review-date').value;

        if (!store) {
            showToast('店舗名を入力してください', '⚠️');
            return;
        }
        if (reviewItems.length === 0) {
            showToast('品目を1つ以上追加してください', '⚠️');
            return;
        }

        const total = reviewItems.reduce((sum, item) => sum + getItemLineTotal(item), 0);
        const receipt = {
            date: date || new Date().toISOString(),
            store,
            source_filename: reviewQueue[currentReviewIndex]?.source_filename || '',
            image_storage: reviewQueue[currentReviewIndex]?.image_storage || null,
            items: reviewItems.map(item => ({
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                category: item.category,
                line_total: getItemLineTotal(item)
            })),
            total,
            confidence: parseFloat(document.getElementById('confidence-pct').textContent) / 100 || 0.9,
            status: 'validated'
        };

        approveBtn.disabled = true;
        approveBtn.textContent = editingReceiptId ? '更新中...' : '登録中...';
        try {
            if (editingReceiptId) {
                const payload = await window.KakeiboShared.requestJson(`/receipts/${encodeURIComponent(editingReceiptId)}`, {
                    method: 'PUT',
                    body: JSON.stringify(receipt)
                });
                const saved = normalizePersistedReceipt(payload.receipt, 0);
                const existingIndex = appData.receipts.findIndex(item => String(item.id) === String(editingReceiptId));
                if (existingIndex >= 0) appData.receipts.splice(existingIndex, 1, saved);
                else appData.receipts.push(saved);
                lastSharedSyncAt = Date.now();
                editingReceiptId = null;
                closeModal();
                updateStorageStatus();
                showToast(`${store}のレシートを更新しました`);
                renderCurrentPage();
                return;
            }

            const payload = await window.KakeiboShared.requestJson('/receipts', {
                method: 'POST',
                body: JSON.stringify(receipt)
            });
            const saved = normalizePersistedReceipt(payload.receipt, appData.receipts.length);
            appData.receipts.push(saved);
            lastSharedSyncAt = Date.now();
            updateStorageStatus();
            registeredReceiptCount += 1;
            if (currentReviewIndex < reviewQueue.length - 1) {
                currentReviewIndex += 1;
                showReviewForm(reviewQueue[currentReviewIndex]);
                approveBtn.disabled = false;
                approveBtn.textContent = '承認して登録';
                showToast(`${store}のレシートを登録しました。次のレシートを確認してください`);
                return;
            }

            const totalRegistered = registeredReceiptCount;
            closeModal();
            showToast(`${totalRegistered}件のレシートを登録しました`);
            const firstDate = parseDate(receipt.date);
            if (isValidDate(firstDate) && !isSameMonth(firstDate, currentMonth)) setMonth(firstDate);
            else renderCurrentPage();
        } catch (error) {
            console.error('共有レシートの保存に失敗しました。', error);
            showToast(error instanceof Error ? error.message : '共有レシートを保存できませんでした', '⚠️');
            approveBtn.disabled = false;
            approveBtn.textContent = editingReceiptId ? '更新を保存' : '承認して登録';
        }
    });

    // モーダルリセット
    function resetModal() {
        analysisRunId += 1;
        storedImageRequestId += 1;
        clearReviewImages();
        reviewSource.hidden = true;
        goToStep(1);
        clearSelectedFiles();
        reviewItems = [];
        editingReceiptId = null;
        approveBtn.textContent = '承認して登録';
        approveBtn.disabled = false;
        cancelBtn.disabled = false;
        reviewQueue = [];
        currentReviewIndex = 0;
        registeredReceiptCount = 0;
        document.getElementById('review-items-body').innerHTML = '';
        document.getElementById('review-store').value = '';
        document.getElementById('review-date').value = '';
        document.getElementById('review-total').textContent = '¥0';
        receiptTotalInput.value = '';
        updateReviewTotalCheck(0);
        document.getElementById('confidence-fill-lg').style.width = '0%';
        document.getElementById('confidence-pct').textContent = '--%';
        const batchStatus = document.getElementById('review-batch-status');
        if (batchStatus) batchStatus.hidden = true;
        cancelBtn.textContent = 'キャンセル';
        [document.getElementById('ocr-progress'), document.getElementById('parse-progress'), document.getElementById('classify-progress')].forEach(progress => {
            progress.classList.remove('is-indeterminate');
            progress.style.width = '0%';
        });
    }

    window.openReceiptEditor = function(receipt) {
        if (!receipt) return;
        clearSelectedFiles();
        clearReviewImages();
        const draft = {
            ...receipt,
            items: (receipt.items || []).map(item => ({ ...item }))
        };
        editingReceiptId = receipt.id;
        reviewQueue = [draft];
        currentReviewIndex = 0;
        registeredReceiptCount = 0;
        if (!modal.classList.contains('active')) openOverlay(modal);
        goToStep(3);
        document.getElementById('modal-title').textContent = 'レシートを編集';
        approveBtn.textContent = '更新を保存';
        showReviewForm(draft);
        loadStoredReceiptImage(draft);
    };

    // スマホの記録シートから、撮影・写真選択を直接開く。
    window.KakeiboUpload = {
        open: openUploadModal,
        openCamera() {
            openUploadModal();
            cameraInput.value = '';
            cameraInput.click();
        },
        openGallery() {
            openUploadModal();
            galleryInput.value = '';
            galleryInput.click();
        },
        openLightbox: (src, label) => imageLightbox.open(src, label)
    };
}


// ===== 画面全体のクリック操作 =====
function initGlobalActions() {
    document.addEventListener('click', event => {
        const record = event.target.closest('[data-action="open-record"]');
        if (record) {
            event.preventDefault();
            // スマホ、またはAI読み取りが上限で使えないときは、手入力も選べるシートを出す。
            if (window.matchMedia('(max-width: 899px)').matches || uploadBlocked()) openRecordSheet();
            else window.KakeiboUpload?.open();
            return;
        }
        const entryButton = event.target.closest('[data-entry-id]');
        if (entryButton) {
            openEntryDetails(findEntry(entryButton.dataset.entryId));
            return;
        }
        const itemButton = event.target.closest('[data-item-name]');
        if (itemButton && !itemButton.closest('#detail-modal')) {
            openItemDetail(itemButton.dataset.itemName);
            return;
        }
        const settingsLink = event.target.closest('[data-open-settings]');
        if (settingsLink) {
            navigateTo('settings');
            requestAnimationFrame(() => document.getElementById(`settings-${settingsLink.dataset.openSettings}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
            return;
        }
        const categoryBar = event.target.closest('[data-history-category]');
        if (categoryBar) {
            historyFilter = 'all';
            document.getElementById('receipt-search').value = '';
            navigateTo('receipts');
            const select = document.getElementById('history-category-filter');
            fillCategorySelect(select, { includeUnknown: [categoryBar.dataset.historyCategory] });
            select.value = categoryBar.dataset.historyCategory;
            renderHistory();
            return;
        }
        const historyFilterButton = event.target.closest('[data-history-filter]');
        if (historyFilterButton) {
            historyFilter = historyFilterButton.dataset.historyFilter;
            renderHistory();
            return;
        }
        const pendingButton = event.target.closest('[data-record-recurring]');
        if (pendingButton) {
            const expense = window.KakeiboSettings.get().recurring.find(item => item.id === pendingButton.dataset.recordRecurring);
            if (expense) openManualEntry({ recurring: expense, date: pendingButton.dataset.recordDate });
            return;
        }
        const pageLink = event.target.closest('[data-page-link]');
        if (pageLink) {
            event.preventDefault();
            if (pageLink.dataset.analysisTab) analysisTab = pageLink.dataset.analysisTab;
            navigateTo(pageLink.dataset.pageLink);
            refreshSharedDataIfStale();
        }
    });

    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', event => {
            event.preventDefault();
            navigateTo(item.dataset.page);
            refreshSharedDataIfStale();
        });
    });
    window.addEventListener('hashchange', () => {
        const page = pageFromHash();
        if (page && page !== currentPage) navigateTo(page, { updateHash: false });
    });
}

let renderQueued = false;
function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        renderCurrentPage();
    });
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
    clearLegacyLocalData();

    window.addEventListener('kakeibo:authenticated', () => {
        navigateTo(currentPage, { updateHash: false });
        loadSharedData({ force: true });
    });
    window.addEventListener('kakeibo:signed-out', clearInMemoryData);
    window.addEventListener('kakeibo:settings-changed', () => {
        updateSyncBanner();
        queueRender();
    });
    window.addEventListener('focus', refreshSharedDataIfStale);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshSharedDataIfStale();
    });
    // 端末のテーマが変わったらグラフの色を描き直す。
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        if (currentThemeChoice() === 'auto') queueRender();
    });
    // 画面幅が変わってスマホ表示とPC表示が切り替わったときも描き直す。
    window.matchMedia('(max-width: 899px)').addEventListener?.('change', queueRender);

    initGlobalActions();
    initMonthSelector();
    initHistoryControls();
    initAnalysisControls();
    initSettingsControls();
    initDetailModal();
    initManualEntry();
    initRecordSheet();
    initUploadModal();

    navigateTo(pageFromHash() || 'dashboard', { updateHash: true });
    updateStorageStatus();

    if (!window.KakeiboAuth?.enabled || window.KakeiboAuth.getToken()) {
        loadSharedData({ force: true });
    }
});
