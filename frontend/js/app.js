const STORAGE_KEY = 'kakeibo.appData.v1';
const STORAGE_FORMAT_VERSION = 1;

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

function makePersistenceEnvelope() {
    return {
        schemaVersion: STORAGE_FORMAT_VERSION,
        updatedAt: new Date().toISOString(),
        receipts: appData.receipts,
        categories: appData.categories
    };
}

function applyPersistedData(candidate) {
    const source = Array.isArray(candidate) ? { receipts: candidate } : candidate;
    if (!source || !Array.isArray(source.receipts)) return false;
    const receipts = source.receipts.map(normalizePersistedReceipt).filter(Boolean);
    const categories = Array.isArray(source.categories)
        ? source.categories.filter(category => category && category.name).map(category => ({
            name: String(category.name),
            color: String(category.color || '#8893A5')
        }))
        : [];

    appData.receipts.splice(0, appData.receipts.length, ...receipts);
    if (categories.length > 0) appData.categories.splice(0, appData.categories.length, ...categories);
    return true;
}

function updateStorageStatus() {
    const status = document.getElementById('storage-status');
    if (!status) return;
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) {
            status.textContent = '自動保存はまだありません';
            return;
        }
        const envelope = JSON.parse(raw);
        const savedAt = envelope.updatedAt ? new Date(envelope.updatedAt).toLocaleString('ja-JP') : '時刻不明';
        status.textContent = `この端末に自動保存済み：${appData.receipts.length}件 / ${savedAt}`;
    } catch (error) {
        status.textContent = '保存状態を確認できません';
    }
}

function loadPersistedData() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        return applyPersistedData(parsed);
    } catch (error) {
        console.warn('保存済みデータを読み込めませんでした。現在のデータは変更していません。', error);
        return false;
    }
}

function savePersistedData() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(makePersistenceEnvelope()));
        updateStorageStatus();
        return true;
    } catch (error) {
        console.error('データの自動保存に失敗しました。', error);
        showToast('自動保存に失敗しました。バックアップを書き出してください', '⚠️');
        return false;
    }
}

function downloadDataBackup() {
    const blob = new Blob([JSON.stringify(makePersistenceEnvelope(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `kakeibo-backup-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showToast('バックアップを書き出しました', '✓');
}

function initDataSafety() {
    const exportButton = document.getElementById('btn-export-data');
    const importButton = document.getElementById('btn-import-data');
    const importInput = document.getElementById('data-import-input');
    exportButton?.addEventListener('click', downloadDataBackup);
    importButton?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const imported = JSON.parse(await file.text());
            if (!Array.isArray(imported?.receipts)) throw new Error('バックアップ形式が不正です');
            const count = imported.receipts.length;
            if (!window.confirm(`${count}件のレシートで現在のDataを置き換えます。続行しますか？`)) return;
            localStorage.setItem(`${STORAGE_KEY}.pre-import`, JSON.stringify(makePersistenceEnvelope()));
            if (!applyPersistedData(imported)) throw new Error('データを復元できませんでした');
            savePersistedData();
            navigateTo(currentPage);
            showToast(`${appData.receipts.length}件のDataを復元しました`, '✓');
        } catch (error) {
            console.error('バックアップの復元に失敗しました。', error);
            showToast('バックアップを復元できませんでした', '⚠️');
        } finally {
            event.target.value = '';
        }
    });
    updateStorageStatus();
}
function closeDetailModal() {
    const modal = document.getElementById('detail-modal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
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

    showDetailModal(`${receipt.store || 'レシート'}の詳細`, `
        <div class="detail-meta-grid">
            <div class="detail-meta-card"><div class="detail-meta-label">店舗</div><div class="detail-meta-value">${escapeHtml(receipt.store)}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">購入日時</div><div class="detail-meta-value">${escapeHtml(formatDate(receipt.date))}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">合計金額</div><div class="detail-meta-value">${formatCurrency(Number(receipt.total) || 0)}</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">品目数</div><div class="detail-meta-value">${items.length}点</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">信頼度</div><div class="detail-meta-value">${Math.round(Math.max(0, Math.min(1, Number(receipt.confidence) || 0)) * 100)}%</div></div>
            <div class="detail-meta-card"><div class="detail-meta-label">ステータス</div><div class="detail-meta-value">${getStatusBadge(receipt.status)}</div></div>
        </div>
        <div class="detail-section-title">購入品目（${items.length}点）</div>
        <table class="detail-items-table">
            <thead><tr><th>品名</th><th>数量</th><th>単価</th><th>小計</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `);
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
            <div class="form-actions"><button class="btn btn-primary" type="submit">保存</button></div>
        </form>
    `, body => {
        body.querySelector('#item-edit-form')?.addEventListener('submit', event => {
            event.preventDefault();
            const form = event.currentTarget;
            const name = form.elements.name.value.trim();
            const category = form.elements.category.value;
            if (!name) {
                showToast('商品名を入力してください', '⚠️');
                return;
            }

            appData.receipts.forEach(receipt => receipt.items.forEach(receiptItem => {
                if (receiptItem.name === item.name) {
                    receiptItem.name = name;
                    receiptItem.category = category;
                }
            }));
            savePersistedData();
            closeDetailModal();
            showToast(`${name}の商品情報を更新しました`);
            navigateTo('items');
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

    function discardEditingReceipt() {
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
        appData.receipts.splice(index, 1);
        savePersistedData();
        closeModal();
        showToast(`${removed.store || '\u30ec\u30b7\u30fc\u30c8'}\u306e\u30ec\u30b7\u30fc\u30c8\u3092\u7834\u68c4\u3057\u307e\u3057\u305f`, '\u2713');
        navigateTo('receipts');
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

    // 実画像解析
    function analyzeFiles(files) {
        const status = document.getElementById('analysis-status');
        const ocrProgress = document.getElementById('ocr-progress');
        const parseProgress = document.getElementById('parse-progress');
        const classifyProgress = document.getElementById('classify-progress');
        const ocrStep = document.getElementById('a-step-ocr');
        const parseStep = document.getElementById('a-step-parse');
        const classifyStep = document.getElementById('a-step-classify');

        status.classList.remove('error');
        [ocrProgress, parseProgress, classifyProgress].forEach(p => p.style.width = '0%');
        [ocrStep, parseStep, classifyStep].forEach(s => {
            s.classList.remove('active', 'completed');
            s.querySelector('.a-step-status').textContent = '待機中';
        });

        // Step 1: OCR
        ocrStep.classList.add('active');
        ocrStep.querySelector('.a-step-status').textContent = '処理中...';
        status.textContent = 'OCR文字認識を実行中...';
        animateProgress(ocrProgress, 1000, async () => {
            ocrStep.classList.remove('active');
            ocrStep.classList.add('completed');
            ocrStep.querySelector('.a-step-status').textContent = '完了 ✓';

            // Step 2: Parse
            parseStep.classList.add('active');
            parseStep.querySelector('.a-step-status').textContent = '処理中...';
            status.textContent = 'AI構造化解析中...';
            animateProgress(parseProgress, 1000, async () => {
                parseStep.classList.remove('active');
                parseStep.classList.add('completed');
                parseStep.querySelector('.a-step-status').textContent = '完了 ✓';

                // Step 3: Classify
                classifyStep.classList.add('active');
                classifyStep.querySelector('.a-step-status').textContent = '処理中...';
                status.textContent = 'カテゴリ分類中...';

                // バックエンドAPIで実画像を解析する。API障害時にテストデータへは切り替えない。
                let resultData;
                try {
                    const formData = new FormData();
                    files.forEach(file => formData.append('files', file));
                    const res = await fetch(getReceiptAnalyzeUrl(), {
                        method: 'POST',
                        body: formData
                    });
                    const resJson = await res.json().catch(() => ({}));
                    if (!res.ok) {
                        throw new Error(resJson.detail || `解析APIエラー (${res.status})`);
                    }
                    if (!resJson.success) throw new Error(resJson.detail || '解析APIが失敗しました');
                    resultData = normalizeAnalysisResults(resJson);
                    if (resultData.length === 0) throw new Error('画像からレシートを検出できませんでした');
                } catch (e) {
                    const message = e instanceof Error ? e.message : '画像解析に失敗しました';
                    console.error('実画像解析に失敗しました:', e);
                    [ocrStep, parseStep, classifyStep].forEach(step => {
                        step.classList.remove('active');
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
                    return;
                }

                animateProgress(classifyProgress, 600, () => {
                    classifyStep.classList.remove('active');
                    classifyStep.classList.add('completed');
                    classifyStep.querySelector('.a-step-status').textContent = '完了 ✓';
                    status.textContent = '解析完了！';

                    setTimeout(() => {
                        reviewQueue = resultData;
                        currentReviewIndex = 0;
                        registeredReceiptCount = 0;
                        goToStep(3);
                        showReviewForm(reviewQueue[currentReviewIndex]);
                    }, 400);
                });
            });
        });
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

    function animateProgress(fillEl, duration, callback) {
        const start = performance.now();
        function update(now) {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            fillEl.style.width = (progress * 100) + '%';
            if (progress < 1) {
                requestAnimationFrame(update);
            } else {
                if (callback) callback();
            }
        }
        requestAnimationFrame(update);
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
                <td><input type="text" value="${item.name}" class="review-item-name" data-index="${index}"></td>
                <td class="col-price"><input type="number" value="${item.price}" class="review-item-price" data-index="${index}" min="0"></td>
                <td class="col-qty"><input type="number" value="${item.quantity}" class="review-item-qty" data-index="${index}" min="1"></td>
                <td class="col-category">
                    <select class="review-item-category" data-index="${index}">
                        ${appData.categories.map(c =>
                            `<option value="${c.name}" ${c.name === item.category ? 'selected' : ''}>${c.name}</option>`
                        ).join('')}
                    </select>
                </td>
                <td class="col-subtotal">${formatCurrency(getItemLineTotal(item))}</td>
                <td class="col-action"><button class="btn-danger review-item-delete" data-index="${index}" type="button" title="削除">✕</button></td>
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

    // 承認して登録
    approveBtn.addEventListener('click', () => {
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

        const total = reviewItems.reduce((s, item) => s + getItemLineTotal(item), 0);

        const receipt = {
            id: editingReceiptId || generateId(),
            date: date || new Date().toISOString(),
            store: store,
            source_filename: reviewQueue[currentReviewIndex]?.source_filename || '',
            image_storage: reviewQueue[currentReviewIndex]?.image_storage || null,
            items: reviewItems.map(item => ({
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                category: item.category,
                line_total: getItemLineTotal(item)
            })),
            total: total,
            confidence: parseFloat(document.getElementById('confidence-pct').textContent) / 100 || 0.9,
            status: 'validated'
        };

        if (editingReceiptId) {
            const existing = appData.receipts.find(item => String(item.id) === String(editingReceiptId));
            if (existing) Object.assign(existing, receipt);
            else appData.receipts.push(receipt);
            savePersistedData();
            editingReceiptId = null;
            closeModal();
            showToast(`${store}のレシートを更新しました`);
            navigateTo('receipts');
            return;
        }

        appData.receipts.push(receipt);
        savePersistedData();
        registeredReceiptCount += 1;
        if (currentReviewIndex < reviewQueue.length - 1) {
            currentReviewIndex += 1;
            showReviewForm(reviewQueue[currentReviewIndex]);
            showToast(`${store}のレシートを登録しました。次のレシートを確認してください`);
            return;
        }

        const totalRegistered = registeredReceiptCount;
        closeModal();
        showToast(`${totalRegistered}件のレシートを登録しました`);
        navigateTo(currentPage);
    });

    // モーダルリセット
    function resetModal() {
        goToStep(1);
        fileInput.value = '';
        reviewItems = [];
        editingReceiptId = null;
        approveBtn.textContent = '✓ 承認して登録';
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
        [document.getElementById('ocr-progress'), document.getElementById('parse-progress'), document.getElementById('classify-progress')].forEach(p => p.style.width = '0%');
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
    loadPersistedData();
    initDataSafety();
    window.addEventListener('pagehide', savePersistedData);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) savePersistedData();
    });

    // ナビゲーション
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(item.dataset.page);
        });
    });

    // ページリンク
    document.querySelectorAll('[data-page-link]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            navigateTo(link.dataset.pageLink);
        });
    });

    // 初期化
    initHamburger();
    initDashboard();
    initDetailModal();
    initUploadModal();
    initMonthSelector();
});