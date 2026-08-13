const LEGACY_STORAGE_KEY = 'kakeibo.appData.v1';
const SHARED_SYNC_STALE_MS = 15000;

// ===== アプリデータ（永続保存対応） =====
const appData = {
    receipts: [],
    categories: [
        { name: '食費', color: '#D1AD67' },
        { name: '日用品', color: '#68D9C1' },
        { name: '衛生用品', color: '#F2C674' },
        { name: '交際費', color: '#F28B92' },
        { name: 'その他', color: '#8893A5' }
    ]
};

// ===== 状態管理 =====
let currentPage = 'dashboard';
let currentMonth = new Date();
let charts = {};
let reviewItems = [];
let lastSharedSyncAt = 0;
let sharedSyncPromise = null;
let detailImageObjectUrl = '';

if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#AEB5C3';
    Chart.defaults.font.family = "Inter, Noto Sans JP, sans-serif";
    Chart.defaults.font.size = 11;
}

// ===== ユーティリティ =====
function formatCurrency(amount) {
    return '¥' + amount.toLocaleString('ja-JP');
}

function getItemLineTotal(item) {
    const quantity = Number(item?.quantity) || 1;
    const rawLineTotal = item?.line_total;
    const explicitLineTotal = rawLineTotal === null || rawLineTotal === undefined || rawLineTotal === '' ? NaN : Number(rawLineTotal);
    if (Number.isFinite(explicitLineTotal)) return explicitLineTotal;
    return (Number(item?.price) || 0) * quantity;
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return '-';
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}/${mm}/${dd}`;
}
function getStatusBadge(status) {
    const labels = { 'validated': '検証済み', 'review': '要確認', 'extracted': '抽出済み' };
    return `<span class="status-badge status-${status}">${labels[status] || status}</span>`;
}

function generateId() {
    return Date.now() + Math.random().toString(36).substr(2, 9);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
}

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
        name: String(item.name || '未分類商品'),
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
        store: String(receipt.store || '店舗未設定'),
        items,
        total,
        confidence: Math.min(1, Math.max(0, Number(receipt.confidence) || 0)),
        status: receipt.status || 'validated'
    };
}

function makeDataSnapshot() {
    return {
        schemaVersion: 2,
        source: 'google-cloud-firestore',
        exportedAt: new Date().toISOString(),
        receipts: appData.receipts,
        categories: appData.categories
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

function updateStorageStatus(message = '') {
    const status = document.getElementById('storage-status');
    if (!status) return;
    if (message) {
        status.textContent = message;
        return;
    }
    if (!lastSharedSyncAt) {
        status.textContent = 'Google Cloud共有データを読み込み中...';
        return;
    }
    const savedAt = new Date(lastSharedSyncAt).toLocaleString('ja-JP');
    const householdName = window.KakeiboAuth?.getUser?.()?.household?.name || '選択中の家計簿';
    status.textContent = `${householdName}：${appData.receipts.length}件 / 最終同期 ${savedAt}`;
}

function renderCurrentPage() {
    navigateTo(currentPage);
}

async function loadSharedData({ announce = false, force = false } = {}) {
    if (!window.KakeiboShared) return false;
    if (window.KakeiboAuth?.enabled && !window.KakeiboAuth.getToken()) return false;
    if (sharedSyncPromise) return sharedSyncPromise;

    updateStorageStatus('Google Cloud共有データを同期中...');
    sharedSyncPromise = (async () => {
        try {
            const payload = await window.KakeiboShared.requestJson('/receipts');
            if (!applySharedData(payload)) throw new Error('共有データの形式が不正です。');
            clearLegacyLocalData();
            lastSharedSyncAt = Date.now();
            updateStorageStatus();
            renderCurrentPage();
            if (announce) showToast(`${appData.receipts.length}件の家計簿Dataを同期しました`, '☁️');
            return true;
        } catch (error) {
            console.error('共有データの同期に失敗しました。', error);
            updateStorageStatus('共有データを同期できませんでした');
            if (announce) showToast(error instanceof Error ? error.message : '共有データを同期できませんでした', '⚠️');
            return false;
        } finally {
            sharedSyncPromise = null;
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
    renderCurrentPage();
    updateStorageStatus('ログインすると選択中の家計簿を読み込みます');
}

function downloadDataBackup() {
    const blob = new Blob([JSON.stringify(makeDataSnapshot(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `kakeibo-cloud-backup-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('家計簿Dataのバックアップを書き出しました', '✓');
}

function initDataSafety() {
    clearLegacyLocalData();
    document.getElementById('btn-export-data')?.addEventListener('click', downloadDataBackup);
    document.getElementById('btn-sync-data')?.addEventListener('click', () => loadSharedData({ announce: true, force: true }));
    updateStorageStatus();
}
function closeDetailModal() {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    if (detailImageObjectUrl) {
        URL.revokeObjectURL(detailImageObjectUrl);
        detailImageObjectUrl = '';
    }
}

function showDetailModal(title, bodyHtml, onOpen) {
    const modal = document.getElementById('detail-modal');
    const titleEl = document.getElementById('detail-modal-title');
    const bodyEl = document.getElementById('detail-modal-body');
    if (!modal || !titleEl || !bodyEl) return;

    titleEl.textContent = title;
    bodyEl.innerHTML = bodyHtml;
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    if (onOpen) onOpen(bodyEl);
}

function initDetailModal() {
    const modal = document.getElementById('detail-modal');
    const closeBtn = document.getElementById('detail-modal-close');
    const footerBtn = document.getElementById('detail-modal-footer-close');
    if (!modal) return;

    closeBtn?.addEventListener('click', closeDetailModal);
    footerBtn?.addEventListener('click', closeDetailModal);
    modal.addEventListener('click', event => {
        if (event.target === modal) closeDetailModal();
    });
}

function openReceiptDetails(receipt) {
    const items = Array.isArray(receipt.items) ? receipt.items : [];
    const rows = items.length > 0
        ? items.map(item => `
            <tr>
                <td>${escapeHtml(item.name)}</td>
                <td>${item.quantity || 1}</td>
                <td>${formatCurrency(Number(item.price) || 0)}</td>
                <td>${formatCurrency(getItemLineTotal(item))}</td>
            </tr>
        `).join('')
        : '<tr><td colspan="4">購入品目がありません</td></tr>';
    const hasImage = Boolean(receipt.image_storage?.object_name);
    const imagePanel = hasImage ? `
        <div class="detail-section-title">レシート画像</div>
        <div class="receipt-image-viewer">
            <div class="receipt-image-loading" data-receipt-image-loading>非公開画像を読み込み中...</div>
            <img data-receipt-image alt="${escapeHtml(receipt.store || 'レシート')}のレシート画像" hidden>
        </div>
    ` : `
        <div class="detail-section-title">レシート画像</div>
        <div class="receipt-image-empty">このレシートには保存画像がありません</div>
    `;

    showDetailModal(`${receipt.store || 'レシート'}の詳細`, `
        <div class="detail-meta-grid">
            <div class="detail-meta-card"><div class="detail-meta-label">店舗</div><div class="detail-meta-value">${escapeHtml(receipt.store)}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">購入日時</div><div class="detail-meta-value">${escapeHtml(formatDate(receipt.date))}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">合計金額</div><div class="detail-meta-value">${formatCurrency(Number(receipt.total) || 0)}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">品目数</div><div class="detail-meta-value">${items.length}点</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">信頼度</div><div class="detail-meta-value">${Math.round(Math.max(0, Math.min(1, Number(receipt.confidence) || 0)) * 100)}%</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">ステータス</div><div class="detail-meta-value">${getStatusBadge(receipt.status)}</div></div>
        </div>
        ${imagePanel}
        <div class="detail-section-title">購入品目（${items.length}点）</div>
        <table class="detail-items-table">
            <thead><tr><th>品名</th><th>数量</th><th>単価</th><th>小計</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `, async body => {
        if (!hasImage) return;
        const loading = body.querySelector('[data-receipt-image-loading]');
        const image = body.querySelector('[data-receipt-image]');
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
    });
}

function openItemDetails(item) {
    const occurrences = Array.isArray(item.occurrences) ? [...item.occurrences] : [];
    occurrences.sort((a, b) => new Date(b.date) - new Date(a.date));
    const history = occurrences.length > 0
        ? occurrences.map(entry => `
            <div class="detail-history-row">
                <span><strong>${escapeHtml(entry.store || '-')}</strong><br><span class="muted">${escapeHtml(formatDate(entry.date))}</span></span>
                <span>${formatCurrency(Number(entry.price) || 0)} × ${entry.quantity || 1}</span>
            </div>
        `).join('')
        : '<div class="detail-history-row">購入履歴がありません</div>';

    showDetailModal(`${item.name}の商品詳細`, `
        <div class="detail-meta-grid">
            <div class="detail-meta-card"><div class="detail-meta-label">カテゴリ</div><div class="detail-meta-value">${escapeHtml(item.category)}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">平均価格</div><div class="detail-meta-value">${formatCurrency(Number(item.avgPrice) || 0)}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">購入回数</div><div class="detail-meta-value">${item.count || 0}回</div></div>
        </div>
        <div class="detail-section-title">購入履歴</div>
        <div class="detail-history-list">${history}</div>
    `);
}

function openItemEditor(item) {
    const categoryOptions = appData.categories.map(category => `
        <option value="${escapeHtml(category.name)}" ${category.name === item.category ? 'selected' : ''}>${escapeHtml(category.name)}</option>
    `).join('');

    showDetailModal('商品マスタを編集', `
        <form class="detail-edit-form" id="item-edit-form">
            <div class="form-group">
                <label for="detail-item-name">商品名</label>
                <input class="form-input" id="detail-item-name" name="name" value="${escapeHtml(item.name)}" required>
            </div>
            <div class="form-group">
                <label for="detail-item-category">カテゴリ</label>
                <select class="form-input" id="detail-item-category" name="category">${categoryOptions}</select>
            </div>
            <div class="form-actions"><button class="btn btn-primary" type="submit">家計簿Dataへ保存</button></div>
        </form>
    `, body => {
        body.querySelector('#item-edit-form')?.addEventListener('submit', async event => {
            event.preventDefault();
            const form = event.currentTarget;
            const submitButton = form.querySelector('button[type="submit"]');
            const name = form.elements.name.value.trim();
            const category = form.elements.category.value;
            if (!name) {
                showToast('商品名を入力してください', '⚠️');
                return;
            }

            submitButton.disabled = true;
            submitButton.textContent = '保存中...';
            try {
                await window.KakeiboShared.requestJson('/items/master', {
                    method: 'PATCH',
                    body: JSON.stringify({ old_name: item.name, new_name: name, category })
                });
                await loadSharedData({ force: true });
                closeDetailModal();
                showToast(`${name}の商品情報を選択中の家計簿へ更新しました`);
                navigateTo('items');
            } catch (error) {
                console.error('商品マスタ更新に失敗しました。', error);
                showToast(error instanceof Error ? error.message : '商品マスタを更新できませんでした', '⚠️');
                submitButton.disabled = false;
                submitButton.textContent = '家計簿Dataへ保存';
            }
        });
    });
}

function openItemTrend(itemName) {
    navigateTo('trends');
    const select = document.getElementById('trend-item-select');
    if (!select) return;
    select.value = itemName;
    select.dispatchEvent(new Event('change'));
}
// ===== Empty State レンダラー =====
function renderEmptyState(container, icon, title, description, showCTA = true) {
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon">${icon}</div>
            <h4 class="empty-state-title">${title}</h4>
            <p class="empty-state-desc">${description}</p>
            ${showCTA ? '<button class="btn btn-primary empty-state-cta" data-empty-cta>📷 レシートを撮影して始める</button>' : ''}
        </div>
    `;
    if (showCTA) {
        const ctaBtn = container.querySelector('[data-empty-cta]');
        if (ctaBtn) {
            ctaBtn.addEventListener('click', () => {
                document.getElementById('btn-upload').click();
            });
        }
    }
}

// ===== トースト通知 =====
function showToast(message, icon = '✅') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span>${message}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => {
        toast.classList.add('show');
    });
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 500);
    }, 3500);
}

// ===== カウンターアニメーション =====
function animateCounter(element, targetValue, suffix = '', prefix = '') {
    const duration = 800;
    const start = performance.now();
    function update(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const currentValue = Math.round(targetValue * eased);
        element.textContent = prefix + currentValue.toLocaleString('ja-JP') + suffix;
        if (progress < 1) requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
}

// ===== ページナビゲーション =====
function navigateTo(page) {
    currentPage = page;

    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });

    document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('active', p.id === `page-${page}`);
    });

    const titles = {
        'dashboard': ['ダッシュボード', '支出サマリー'],
        'receipts': ['レシート一覧', '全レシートの管理'],
        'items': ['商品マスタ', '名寄せされた商品の管理'],
        'trends': ['価格推移', '商品の価格変動をトラッキング'],
        'settings': ['設定', 'アプリの設定']
    };
    document.getElementById('page-title').textContent = titles[page][0];
    document.getElementById('page-subtitle').textContent = titles[page][1];

    closeSidebar();

    if (page === 'dashboard') initDashboard();
    if (page === 'receipts') initReceiptsPage();
    if (page === 'items') initItemsPage();
    if (page === 'trends') initTrendsPage();
    if (page === 'settings') initSettingsPage();
}

// ===== ハンバーガーメニュー =====
function initHamburger() {
    const btn = document.getElementById('hamburger-btn');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');

    btn.addEventListener('click', () => {
        const isOpen = sidebar.classList.toggle('open');
        overlay.classList.toggle('active', isOpen);
        btn.classList.toggle('active', isOpen);
    });

    overlay.addEventListener('click', closeSidebar);
}

function closeSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    const btn = document.getElementById('hamburger-btn');
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    btn.classList.remove('active');
}

// ===== 月別レシート取得 =====
function getMonthReceipts() {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    return appData.receipts.filter(r => {
        const d = new Date(r.date);
        return d.getFullYear() === year && d.getMonth() === month;
    });
}

// ===== ダッシュボード =====
function initDashboard() {
    const monthReceipts = getMonthReceipts();
    const totalSpent = monthReceipts.reduce((s, r) => s + r.total, 0);
    const totalItems = monthReceipts.reduce((s, r) => s + r.items.length, 0);

    const kpiTotal = document.getElementById('kpi-total');
    const kpiReceipts = document.getElementById('kpi-receipts');
    const kpiItems = document.getElementById('kpi-items');
    const kpiInflation = document.getElementById('kpi-inflation');

    if (monthReceipts.length > 0) {
        animateCounter(kpiTotal, totalSpent, '', '¥');
        animateCounter(kpiReceipts, monthReceipts.length, '枚');
        animateCounter(kpiItems, totalItems, '点');
        kpiInflation.textContent = '--';
        document.getElementById('kpi-total-change').textContent = '今月の合計';
        document.getElementById('kpi-total-change').className = 'kpi-change';
    } else {
        kpiTotal.textContent = '¥0';
        kpiReceipts.textContent = '0枚';
        kpiItems.textContent = '0点';
        kpiInflation.textContent = '--';
        document.getElementById('kpi-total-change').textContent = 'データなし';
    }

    // カテゴリ別支出チャート
    const categoryContainer = document.getElementById('category-chart-container');
    if (monthReceipts.length === 0) {
        categoryContainer.classList.add('is-empty');
        const existingCanvas = document.getElementById('category-chart');
        if (existingCanvas) existingCanvas.style.display = 'none';
        if (!categoryContainer.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            categoryContainer.insertBefore(wrapper, categoryContainer.firstChild);
            renderEmptyState(wrapper, '📊', 'カテゴリデータなし', 'レシートを登録するとカテゴリ別支出が表示されます', false);
        }
    } else {
        categoryContainer.classList.remove('is-empty');
        const es = categoryContainer.querySelector('.empty-state');
        if (es) es.parentElement.remove();
        const canvas = document.getElementById('category-chart');
        canvas.style.display = 'block';

        const catTotals = {};
        monthReceipts.forEach(r => {
            r.items.forEach(item => {
                const cat = item.category || 'その他';
                catTotals[cat] = (catTotals[cat] || 0) + getItemLineTotal(item);
            });
        });

        const catNames = Object.keys(catTotals);
        const catAmounts = catNames.map(n => catTotals[n]);
        const catColors = catNames.map(n => {
            const found = appData.categories.find(c => c.name === n);
            return found ? found.color : '#8893A5';
        });

        if (charts.category) charts.category.destroy();
        charts.category = new Chart(document.getElementById('category-chart'), {
            type: 'doughnut',
            data: {
                labels: catNames,
                datasets: [{
                    data: catAmounts,
                    backgroundColor: catColors,
                    borderWidth: 3,
                    borderColor: '#fff',
                    hoverBorderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '65%',
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, usePointStyle: true, font: { family: 'Inter', size: 13 } }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(9,14,22,0.94)',
                        padding: 12,
                        titleFont: { family: 'Inter', size: 13 },
                        bodyFont: { family: 'Inter', size: 13 },
                        callbacks: {
                            label: (ctx) => {
                                const total = catAmounts.reduce((s, a) => s + a, 0);
                                const pct = ((ctx.parsed / total) * 100).toFixed(1);
                                return ` ${ctx.label}: ${formatCurrency(ctx.parsed)} (${pct}%)`;
                            }
                        }
                    }
                }
            }
        });
    }

    // 月次支出推移チャート
    const monthlyContainer = document.getElementById('monthly-chart-container');
    if (appData.receipts.length === 0) {
        const existingCanvas = document.getElementById('monthly-chart');
        if (existingCanvas) existingCanvas.style.display = 'none';
        if (!monthlyContainer.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            monthlyContainer.insertBefore(wrapper, monthlyContainer.firstChild);
            renderEmptyState(wrapper, '📈', '月次データなし', 'データが蓄積されると支出推移が表示されます', false);
        }
    } else {
        const es = monthlyContainer.querySelector('.empty-state');
        if (es) es.parentElement.remove();
        document.getElementById('monthly-chart').style.display = 'block';

        const months = [];
        for (let i = 5; i >= 0; i--) {
            const d = new Date(currentMonth);
            d.setMonth(d.getMonth() - i);
            const yr = d.getFullYear();
            const mo = d.getMonth();
            const mr = appData.receipts.filter(r => {
                const rd = new Date(r.date);
                return rd.getFullYear() === yr && rd.getMonth() === mo;
            });
            months.push({
                label: `${mo + 1}月`,
                total: mr.reduce((s, r) => s + r.total, 0)
            });
        }

        if (charts.monthly) charts.monthly.destroy();
        charts.monthly = new Chart(document.getElementById('monthly-chart'), {
            type: 'bar',
            data: {
                labels: months.map(m => m.label),
                datasets: [{
                    label: '支出',
                    data: months.map(m => m.total),
                    backgroundColor: 'rgba(209, 173, 103, 0.72)',
                    hoverBackgroundColor: 'rgba(209, 173, 103, 0.94)',
                    borderRadius: 8,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(9,14,22,0.94)',
                        padding: 12,
                        titleFont: { family: 'Inter' },
                        bodyFont: { family: 'Inter' },
                        callbacks: { label: (ctx) => ` ${formatCurrency(ctx.parsed.y)}` }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(209,173,103,0.10)' },
                        ticks: { font: { family: 'Inter', size: 12 }, callback: (v) => '¥' + (v / 1000) + 'k' }
                    },
                    x: { grid: { display: false }, ticks: { font: { family: 'Inter', size: 12 } } }
                }
            }
        });
    }

    // 最近のレシート
    const recentContainer = document.getElementById('recent-receipts-container');
    const tbody = document.querySelector('#recent-receipts-table tbody');
    if (appData.receipts.length === 0) {
        document.getElementById('recent-receipts-table').style.display = 'none';
        if (!recentContainer.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            recentContainer.appendChild(wrapper);
            renderEmptyState(wrapper, '🧾', 'レシートがありません', '「レシートを撮影」ボタンから最初のレシートを登録しましょう', true);
        }
    } else {
        document.getElementById('recent-receipts-table').style.display = 'table';
        const esWrapper = recentContainer.querySelector('.empty-state');
        if (esWrapper) esWrapper.closest('div:not(#recent-receipts-container)').remove();

        const sorted = [...appData.receipts].sort((a, b) => new Date(b.date) - new Date(a.date));
        tbody.innerHTML = sorted.slice(0, 5).map(r => `
            <tr>
                <td class="recent-col-date">${formatDate(r.date)}</td>
                <td class="recent-col-store">${escapeHtml(r.store)}</td>
                <td class="recent-col-items">${r.items.length}点</td>
                <td class="recent-col-total">${formatCurrency(r.total)}</td>
                <td class="recent-col-status">${getStatusBadge(r.status)}</td>
            </tr>
        `).join('');
    }
}

// ===== レシート一覧ページ =====
function renderReceiptsTable(receipts) {
    const tbody = document.querySelector('#receipts-table tbody');
    tbody.innerHTML = receipts.map(r => `
        <tr>
            <td class="receipt-col-date">${formatDate(r.date)}</td>
            <td class="receipt-col-store">${escapeHtml(r.store)}</td>
            <td class="receipt-col-items">${r.items.length}点</td>
            <td class="receipt-col-total">${formatCurrency(r.total)}</td>
            <td class="receipt-col-confidence">
                <div class="confidence-bar">
                    <div class="confidence-fill" style="width:${r.confidence * 100}%"></div>
                </div>
            </td>
            <td class="receipt-col-status">${getStatusBadge(r.status)}</td>
            <td class="receipt-col-action">
                <button class="btn btn-icon" data-receipt-action="detail" data-receipt-id="${escapeHtml(r.id)}" title="詳細">👁️</button>
                <button class="btn btn-icon" data-receipt-action="edit" data-receipt-id="${escapeHtml(r.id)}" title="編集">✏️</button>
            </td>
        </tr>
    `).join('');
    tbody.querySelectorAll('[data-receipt-action]').forEach(button => {
        button.addEventListener('click', () => {
            const receipt = appData.receipts.find(item => String(item.id) === button.dataset.receiptId);
            if (!receipt) return;
            if (button.dataset.receiptAction === 'detail') openReceiptDetails(receipt);
            if (button.dataset.receiptAction === 'edit' && typeof window.openReceiptEditor === 'function') {
                window.openReceiptEditor(receipt);
            }
        });
    });

}

function initReceiptsPage() {
    const container = document.getElementById('receipts-container');
    const table = document.getElementById('receipts-table');
    const monthReceipts = getMonthReceipts();
    const monthLabel = `${currentMonth.getFullYear()}年${currentMonth.getMonth() + 1}月`;

    if (monthReceipts.length === 0) {
        table.style.display = 'none';
        table.querySelector('tbody').innerHTML = '';
        const existingEmpty = container.querySelector('.empty-state');
        if (existingEmpty) {
            const wrapper = existingEmpty.parentElement;
            if (wrapper) wrapper.remove();
        }
        const wrapper = document.createElement('div');
        container.appendChild(wrapper);
        const hasAnyReceipts = appData.receipts.length > 0;
        renderEmptyState(
            wrapper,
            '🗓️',
            `${monthLabel}のレシートはありません`,
            hasAnyReceipts ? '上の月セレクターで別の月を選択してください' : '「レシートを撮影」からレシートを登録してください',
            !hasAnyReceipts
        );
        return;
    }

    table.style.display = 'table';
    const esWrapper = container.querySelector('.empty-state');
    if (esWrapper) {
        const wrapper = esWrapper.parentElement;
        if (wrapper) wrapper.remove();
    }

    const searchInput = document.getElementById('receipt-search');
    const filterSelect = document.getElementById('receipt-filter');
    const newSearch = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearch, searchInput);
    const newFilter = filterSelect.cloneNode(true);
    filterSelect.parentNode.replaceChild(newFilter, filterSelect);

    function applyFilters() {
        const query = document.getElementById('receipt-search').value.toLowerCase();
        const statusFilter = document.getElementById('receipt-filter').value;
        let filtered = getMonthReceipts();
        if (query) filtered = filtered.filter(r => r.store.toLowerCase().includes(query));
        if (statusFilter !== 'all') filtered = filtered.filter(r => r.status === statusFilter);
        renderReceiptsTable(filtered);
    }

    document.getElementById('receipt-search').addEventListener('input', applyFilters);
    document.getElementById('receipt-filter').addEventListener('change', applyFilters);
    applyFilters();
}
// ===== 商品マスタページ =====
function getUniqueItems() {
    const itemMap = {};
    appData.receipts.forEach(r => {
        r.items.forEach(item => {
            const key = item.name;
            if (!itemMap[key]) {
                itemMap[key] = { name: item.name, category: item.category, prices: [], count: 0, aliases: 1, occurrences: [] };
            }
            itemMap[key].prices.push(item.price);
            itemMap[key].count++;
            itemMap[key].occurrences.push({ receiptId: r.id, date: r.date, store: r.store, price: item.price, quantity: item.quantity || 1 });
        });
    });
    return Object.values(itemMap).map(item => ({
        ...item,
        avgPrice: Math.round(item.prices.reduce((s, p) => s + p, 0) / item.prices.length)
    }));
}

function renderItemsTable(items) {
    const tbody = document.querySelector('#items-table tbody');
    tbody.innerHTML = items.map((item, index) => `
        <tr>
            <td>${item.name}</td>
            <td>${item.category}</td>
            <td>${item.aliases}件</td>
            <td>${formatCurrency(item.avgPrice)}</td>
            <td>${item.count}回</td>
            <td>
                <button class="btn btn-icon" data-item-action="detail" data-item-index="${index}" title="詳細">👁️</button>
                <button class="btn btn-icon" data-item-action="edit" data-item-index="${index}" title="編集">✏️</button>
                <button class="btn btn-icon" data-item-action="trend" data-item-index="${index}" title="価格推移">📈</button>
            </td>
        </tr>
    `).join('');
    tbody.querySelectorAll('[data-item-action]').forEach(button => {
        button.addEventListener('click', () => {
            const item = items[Number(button.dataset.itemIndex)];
            if (!item) return;
            if (button.dataset.itemAction === 'detail') openItemDetails(item);
            if (button.dataset.itemAction === 'edit') openItemEditor(item);
            if (button.dataset.itemAction === 'trend') openItemTrend(item.name);
        });
    });
}

function initItemsPage() {
    const container = document.getElementById('items-container');
    const items = getUniqueItems();

    if (items.length === 0) {
        document.getElementById('items-table').style.display = 'none';
        if (!container.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            container.appendChild(wrapper);
            renderEmptyState(wrapper, '🏷️', '商品データなし', 'レシートを登録すると商品マスタが自動生成されます', true);
        }
        return;
    }

    document.getElementById('items-table').style.display = 'table';
    const esWrapper = container.querySelector('.empty-state');
    if (esWrapper) esWrapper.closest('div:not(#items-container)').remove();

    renderItemsTable(items);

    const searchInput = document.getElementById('item-search');
    const catFilter = document.getElementById('item-category-filter');
    const newSearch = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearch, searchInput);
    const newCat = catFilter.cloneNode(true);
    catFilter.parentNode.replaceChild(newCat, catFilter);

    function applyFilters() {
        const query = document.getElementById('item-search').value.toLowerCase();
        const category = document.getElementById('item-category-filter').value;
        let filtered = items;
        if (query) filtered = filtered.filter(i => i.name.toLowerCase().includes(query));
        if (category !== 'all') filtered = filtered.filter(i => i.category === category);
        renderItemsTable(filtered);
    }

    document.getElementById('item-search').addEventListener('input', applyFilters);
    document.getElementById('item-category-filter').addEventListener('change', applyFilters);
}

// ===== 価格推移ページ =====
function initTrendsPage() {
    const container = document.getElementById('trends-chart-container');
    const select = document.getElementById('trend-item-select');
    const items = getUniqueItems();

    if (items.length === 0) {
        document.getElementById('price-trend-chart').style.display = 'none';
        if (!container.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            container.insertBefore(wrapper, container.firstChild);
            renderEmptyState(wrapper, '📉', '価格データなし', 'レシートを登録すると価格推移が表示されます', true);
        }
        document.getElementById('trend-stats').innerHTML = '';
        return;
    }

    document.getElementById('price-trend-chart').style.display = 'block';
    const es = container.querySelector('.empty-state');
    if (es) es.parentElement.remove();

    select.innerHTML = '<option value="">商品を選択...</option>' +
        items.map(item => `<option value="${item.name}">${item.name}</option>`).join('');

    const newSelect = select.cloneNode(true);
    select.parentNode.replaceChild(newSelect, select);

    document.getElementById('trend-item-select').addEventListener('change', (e) => {
        const itemName = e.target.value;
        if (!itemName) return;

        const pricesByMonth = {};
        appData.receipts.forEach(r => {
            r.items.forEach(item => {
                if (item.name === itemName) {
                    const d = new Date(r.date);
                    const key = `${d.getFullYear()}-${d.getMonth()}`;
                    const label = `${d.getMonth() + 1}月`;
                    if (!pricesByMonth[key]) pricesByMonth[key] = { label, prices: [], sortKey: d.getTime() };
                    pricesByMonth[key].prices.push(item.price);
                }
            });
        });

        const sorted = Object.values(pricesByMonth).sort((a, b) => a.sortKey - b.sortKey);
        const labels = sorted.map(s => s.label);
        const avgPrices = sorted.map(s => Math.round(s.prices.reduce((a, b) => a + b, 0) / s.prices.length));

        if (charts.trend) charts.trend.destroy();
        charts.trend = new Chart(document.getElementById('price-trend-chart'), {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: itemName,
                    data: avgPrices,
                    borderColor: '#D1AD67',
                    backgroundColor: 'rgba(209, 173, 103, 0.12)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 6,
                    pointBackgroundColor: '#D1AD67',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointHoverRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(9,14,22,0.94)',
                        padding: 12,
                        callbacks: { label: (ctx) => ` ${formatCurrency(ctx.parsed.y)}` }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        grid: { color: 'rgba(209,173,103,0.10)' },
                        ticks: { font: { family: 'Inter' }, callback: (v) => '¥' + v }
                    },
                    x: { grid: { display: false }, ticks: { font: { family: 'Inter' } } }
                }
            }
        });

        if (avgPrices.length > 0) {
            const first = avgPrices[0];
            const last = avgPrices[avgPrices.length - 1];
            const change = ((last - first) / first * 100).toFixed(1);
            const avg = Math.round(avgPrices.reduce((s, p) => s + p, 0) / avgPrices.length);
            const min = Math.min(...avgPrices);
            const max = Math.max(...avgPrices);

            document.getElementById('trend-stats').innerHTML = `
                <div class="trend-stat">
                    <div class="label">現在価格</div>
                    <div class="value">${formatCurrency(last)}</div>
                </div>
                <div class="trend-stat">
                    <div class="label">変動率</div>
                    <div class="value" style="color:${change >= 0 ? '#F28B92' : '#62D8AD'}">
                        ${change >= 0 ? '+' : ''}${change}%
                    </div>
                </div>
                <div class="trend-stat">
                    <div class="label">平均価格</div>
                    <div class="value">${formatCurrency(avg)}</div>
                </div>
                <div class="trend-stat">
                    <div class="label">価格帯</div>
                    <div class="value">${formatCurrency(min)} - ${formatCurrency(max)}</div>
                </div>
            `;
        }
    });
}

// ===== 設定ページ =====
function initSettingsPage() {
    document.getElementById('category-settings').innerHTML =
        appData.categories.map(cat => `
            <div class="settings-item">
                <span class="category-name">${cat.name}</span>
                <div class="category-color" style="background:${cat.color}"></div>
            </div>
        `).join('');

    const slider = document.getElementById('accuracy-slider');
    const sliderValue = document.getElementById('accuracy-value');
    if (slider && sliderValue) {
        const newSlider = slider.cloneNode(true);
        slider.parentNode.replaceChild(newSlider, slider);
        document.getElementById('accuracy-slider').addEventListener('input', (e) => {
            document.getElementById('accuracy-value').textContent = e.target.value;
        });
    }
    window.KakeiboAccess?.load();
}

// ===== 月セレクター =====
function initMonthSelector() {
    const monthLabel = document.getElementById('current-month');

    function updateMonth() {
        monthLabel.textContent = `${currentMonth.getFullYear()}年${currentMonth.getMonth() + 1}月`;
        if (currentPage === 'dashboard') initDashboard();
        if (currentPage === 'receipts') initReceiptsPage();
    }

    document.getElementById('prev-month').addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() - 1);
        updateMonth();
    });

    document.getElementById('next-month').addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() + 1);
        updateMonth();
    });

    updateMonth();
}

// ===== Human-in-the-Loop: アップロード & レビューモーダル =====
function initUploadModal() {
    const modal = document.getElementById('receipt-modal');
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const closeBtn = document.getElementById('close-modal');
    const cancelBtn = document.getElementById('btn-modal-cancel');
    const approveBtn = document.getElementById('btn-modal-approve');
    const addItemBtn = document.getElementById('btn-add-item');

    let currentStep = 1;
    let editingReceiptId = null;
    let reviewQueue = [];
    let currentReviewIndex = 0;
    let registeredReceiptCount = 0;
    reviewItems = [];

    // モーダルを開く
    document.getElementById('btn-upload').addEventListener('click', () => {
        modal.classList.add('active');
        goToStep(1);
    });

    // モーダルを閉じる
    function closeModal() {
        modal.classList.remove('active');
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
            showToast(`${removed.store || 'レシート'}のレシートを家計簿Dataから破棄しました`, '✓');
            navigateTo('receipts');
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

        approveBtn.style.display = step === 3 ? 'inline-flex' : 'none';
        cancelBtn.textContent = step === 3 ? '破棄する' : 'キャンセル';
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;
    }

    // ファイル選択
    document.getElementById('btn-select-file').addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
    });

    uploadZone.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleUpload(e.target.files);
        }
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
            handleUpload(e.dataTransfer.files);
        }
    });

    // アップロード処理 → ステップ2
    function handleUpload(files) {
        const selectedFiles = Array.from(files).filter(file => !file.type || file.type.startsWith("image/"));
        if (selectedFiles.length === 0) {
            showToast("画像ファイルを選択してください", "⚠️");
            return;
        }
        if (selectedFiles.length > 10) {
            showToast("一度に選択できる画像は10枚までです", "⚠️");
            return;
        }

        goToStep(2);
        analyzeFiles(selectedFiles);
    }

    // 実画像解析。APIへの送信は進捗演出より先に開始し、不要な待機を作らない。
    async function analyzeFiles(files) {
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

            reviewQueue = resultData;
            currentReviewIndex = 0;
            registeredReceiptCount = 0;
            goToStep(3);
            showReviewForm(reviewQueue[currentReviewIndex]);
        } catch (e) {
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
                fileInput.value = '';
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

        const resultData = normalizeAnalysisResults(resJson);
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

    function normalizeAnalysisResults(payload) {
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

        reviewItems = (Array.isArray(result && result.items) ? result.items : []).map((item, i) => ({ ...item, id: i }));
        updateReviewBatchStatus();
        renderReviewItems();
        const modalBody = modal.querySelector('.modal-body');
        if (modalBody) modalBody.scrollTop = 0;
        const itemsScroll = document.querySelector('.review-items-scroll');
        if (itemsScroll) itemsScroll.scrollLeft = 0;
    }

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
                        ${appData.categories.map(c =>
                            `<option value="${c.name}" ${c.name === item.category ? 'selected' : ''}>${c.name}</option>`
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
    }

    // 品目追加
    addItemBtn.addEventListener('click', () => {
        reviewItems.push({
            id: reviewItems.length,
            name: '',
            price: 0,
            quantity: 1,
            category: '食費'
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
                showToast(`${store}のレシートを選択中の家計簿へ更新しました`);
                navigateTo('receipts');
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
                approveBtn.textContent = '✓ 承認して登録';
                showToast(`${store}のレシートを共有登録しました。次のレシートを確認してください`);
                return;
            }

            const totalRegistered = registeredReceiptCount;
            closeModal();
            showToast(`${totalRegistered}件のレシートを選択中の家計簿へ登録しました`);
            navigateTo(currentPage);
        } catch (error) {
            console.error('共有レシートの保存に失敗しました。', error);
            showToast(error instanceof Error ? error.message : '共有レシートを保存できませんでした', '⚠️');
            approveBtn.disabled = false;
            approveBtn.textContent = editingReceiptId ? '✓ 更新を保存' : '✓ 承認して登録';
        }
    });

    // モーダルリセット
    function resetModal() {
        goToStep(1);
        fileInput.value = '';
        reviewItems = [];
        editingReceiptId = null;
        approveBtn.textContent = '✓ 承認して登録';
        approveBtn.disabled = false;
        cancelBtn.disabled = false;
        reviewQueue = [];
        currentReviewIndex = 0;
        registeredReceiptCount = 0;
        document.getElementById('review-items-body').innerHTML = '';
        document.getElementById('review-store').value = '';
        document.getElementById('review-date').value = '';
        document.getElementById('review-total').textContent = '¥0';
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
        const draft = {
            ...receipt,
            items: (receipt.items || []).map(item => ({ ...item }))
        };
        editingReceiptId = receipt.id;
        reviewQueue = [draft];
        currentReviewIndex = 0;
        registeredReceiptCount = 0;
        modal.classList.add('active');
        goToStep(3);
        document.getElementById('modal-title').textContent = 'レシートを編集';
        approveBtn.textContent = '✓ 更新を保存';
        showReviewForm(draft);
    };
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
    initDataSafety();

    window.addEventListener('kakeibo:authenticated', () => loadSharedData({ force: true }));
    window.addEventListener('kakeibo:signed-out', clearInMemoryData);
    window.addEventListener('focus', refreshSharedDataIfStale);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) refreshSharedDataIfStale();
    });

    // ナビゲーション
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (event) => {
            event.preventDefault();
            navigateTo(item.dataset.page);
            refreshSharedDataIfStale();
        });
    });

    // ページリンク
    document.querySelectorAll('[data-page-link]').forEach(link => {
        link.addEventListener('click', (event) => {
            event.preventDefault();
            navigateTo(link.dataset.pageLink);
            refreshSharedDataIfStale();
        });
    });

    initHamburger();
    initDashboard();
    initDetailModal();
    initUploadModal();
    initMonthSelector();

    if (!window.KakeiboAuth?.enabled || window.KakeiboAuth.getToken()) {
        loadSharedData({ force: true });
    }
});
