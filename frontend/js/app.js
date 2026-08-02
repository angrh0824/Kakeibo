// ===== アプリデータ（空の初期状態） =====
const appData = {
    receipts: [],
    categories: [
        { name: '食費', color: '#6C5CE7' },
        { name: '日用品', color: '#00CEC9' },
        { name: '衛生用品', color: '#FDCB6E' },
        { name: '交際費', color: '#FF7675' },
        { name: 'その他', color: '#A5A3B5' }
    ]
};

// ===== 状態管理 =====
let currentPage = 'dashboard';
let currentMonth = new Date();
let charts = {};
let reviewItems = [];

// ===== ユーティリティ =====
function formatCurrency(amount) {
    return '¥' + amount.toLocaleString('ja-JP');
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function getStatusBadge(status) {
    const labels = { 'validated': '検証済み', 'review': '要確認', 'extracted': '抽出済み' };
    return `<span class="status-badge status-${status}">${labels[status] || status}</span>`;
}

function generateId() {
    return Date.now() + Math.random().toString(36).substr(2, 9);
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
        const existingCanvas = document.getElementById('category-chart');
        if (existingCanvas) existingCanvas.style.display = 'none';
        if (!categoryContainer.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            categoryContainer.insertBefore(wrapper, categoryContainer.firstChild);
            renderEmptyState(wrapper, '📊', 'カテゴリデータなし', 'レシートを登録するとカテゴリ別支出が表示されます', false);
        }
    } else {
        const es = categoryContainer.querySelector('.empty-state');
        if (es) es.parentElement.remove();
        const canvas = document.getElementById('category-chart');
        canvas.style.display = 'block';

        const catTotals = {};
        monthReceipts.forEach(r => {
            r.items.forEach(item => {
                const cat = item.category || 'その他';
                catTotals[cat] = (catTotals[cat] || 0) + (item.price * (item.quantity || 1));
            });
        });

        const catNames = Object.keys(catTotals);
        const catAmounts = catNames.map(n => catTotals[n]);
        const catColors = catNames.map(n => {
            const found = appData.categories.find(c => c.name === n);
            return found ? found.color : '#A5A3B5';
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
                        backgroundColor: 'rgba(45,43,61,0.9)',
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
                    backgroundColor: 'rgba(108, 92, 231, 0.7)',
                    hoverBackgroundColor: 'rgba(108, 92, 231, 0.9)',
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
                        backgroundColor: 'rgba(45,43,61,0.9)',
                        padding: 12,
                        titleFont: { family: 'Inter' },
                        bodyFont: { family: 'Inter' },
                        callbacks: { label: (ctx) => ` ${formatCurrency(ctx.parsed.y)}` }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(108,92,231,0.06)' },
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
                <td>${formatDate(r.date)}</td>
                <td>${r.store}</td>
                <td>${r.items.length}点</td>
                <td>${formatCurrency(r.total)}</td>
                <td>${getStatusBadge(r.status)}</td>
            </tr>
        `).join('');
    }
}

// ===== レシート一覧ページ =====
function renderReceiptsTable(receipts) {
    const tbody = document.querySelector('#receipts-table tbody');
    tbody.innerHTML = receipts.map(r => `
        <tr>
            <td>${formatDate(r.date)}</td>
            <td>${r.store}</td>
            <td>${r.items.length}点</td>
            <td>${formatCurrency(r.total)}</td>
            <td>
                <div class="confidence-bar">
                    <div class="confidence-fill" style="width:${r.confidence * 100}%"></div>
                </div>
            </td>
            <td>${getStatusBadge(r.status)}</td>
            <td>
                <button class="btn btn-icon" title="詳細">👁️</button>
                <button class="btn btn-icon" title="編集">✏️</button>
            </td>
        </tr>
    `).join('');
}

function initReceiptsPage() {
    const container = document.getElementById('receipts-container');

    if (appData.receipts.length === 0) {
        document.getElementById('receipts-table').style.display = 'none';
        if (!container.querySelector('.empty-state')) {
            const wrapper = document.createElement('div');
            container.appendChild(wrapper);
            renderEmptyState(wrapper, '🧾', 'レシートがありません', '「レシートを撮影」ボタンでレシートを登録しましょう', true);
        }
        return;
    }

    document.getElementById('receipts-table').style.display = 'table';
    const esWrapper = container.querySelector('.empty-state');
    if (esWrapper) esWrapper.closest('div:not(#receipts-container)').remove();

    renderReceiptsTable(appData.receipts);

    const searchInput = document.getElementById('receipt-search');
    const filterSelect = document.getElementById('receipt-filter');
    const newSearch = searchInput.cloneNode(true);
    searchInput.parentNode.replaceChild(newSearch, searchInput);
    const newFilter = filterSelect.cloneNode(true);
    filterSelect.parentNode.replaceChild(newFilter, filterSelect);

    function applyFilters() {
        const query = document.getElementById('receipt-search').value.toLowerCase();
        const statusFilter = document.getElementById('receipt-filter').value;
        let filtered = appData.receipts;
        if (query) filtered = filtered.filter(r => r.store.toLowerCase().includes(query));
        if (statusFilter !== 'all') filtered = filtered.filter(r => r.status === statusFilter);
        renderReceiptsTable(filtered);
    }

    document.getElementById('receipt-search').addEventListener('input', applyFilters);
    document.getElementById('receipt-filter').addEventListener('change', applyFilters);
}

// ===== 商品マスタページ =====
function getUniqueItems() {
    const itemMap = {};
    appData.receipts.forEach(r => {
        r.items.forEach(item => {
            const key = item.name;
            if (!itemMap[key]) {
                itemMap[key] = { name: item.name, category: item.category, prices: [], count: 0, aliases: 1 };
            }
            itemMap[key].prices.push(item.price);
            itemMap[key].count++;
        });
    });
    return Object.values(itemMap).map(item => ({
        ...item,
        avgPrice: Math.round(item.prices.reduce((s, p) => s + p, 0) / item.prices.length)
    }));
}

function renderItemsTable(items) {
    const tbody = document.querySelector('#items-table tbody');
    tbody.innerHTML = items.map(item => `
        <tr>
            <td>${item.name}</td>
            <td>${item.category}</td>
            <td>${item.aliases}件</td>
            <td>${formatCurrency(item.avgPrice)}</td>
            <td>${item.count}回</td>
            <td>
                <button class="btn btn-icon" title="価格推移">📈</button>
                <button class="btn btn-icon" title="編集">✏️</button>
            </td>
        </tr>
    `).join('');
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
                    borderColor: '#6C5CE7',
                    backgroundColor: 'rgba(108, 92, 231, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 6,
                    pointBackgroundColor: '#6C5CE7',
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
                        backgroundColor: 'rgba(45,43,61,0.9)',
                        padding: 12,
                        callbacks: { label: (ctx) => ` ${formatCurrency(ctx.parsed.y)}` }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        grid: { color: 'rgba(108,92,231,0.06)' },
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
                    <div class="value" style="color:${change >= 0 ? '#FF7675' : '#00B894'}">
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
    cancelBtn.addEventListener('click', closeModal);
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
        goToStep(2);
        simulateAnalysis(files);
    }

    // AI解析シミュレーション
    function simulateAnalysis(files) {
        const status = document.getElementById('analysis-status');
        const ocrProgress = document.getElementById('ocr-progress');
        const parseProgress = document.getElementById('parse-progress');
        const classifyProgress = document.getElementById('classify-progress');
        const ocrStep = document.getElementById('a-step-ocr');
        const parseStep = document.getElementById('a-step-parse');
        const classifyStep = document.getElementById('a-step-classify');

        [ocrProgress, parseProgress, classifyProgress].forEach(p => p.style.width = '0%');
        [ocrStep, parseStep, classifyStep].forEach(s => {
            s.classList.remove('active', 'completed');
            s.querySelector('.a-step-status').textContent = '待機中';
        });

        // Step 1: OCR
        ocrStep.classList.add('active');
        ocrStep.querySelector('.a-step-status').textContent = '処理中...';
        status.textContent = 'OCR文字認識を実行中...';
        animateProgress(ocrProgress, 1200, () => {
            ocrStep.classList.remove('active');
            ocrStep.classList.add('completed');
            ocrStep.querySelector('.a-step-status').textContent = '完了 ✓';

            // Step 2: Parse
            parseStep.classList.add('active');
            parseStep.querySelector('.a-step-status').textContent = '処理中...';
            status.textContent = 'AI構造化解析中...';
            animateProgress(parseProgress, 1200, () => {
                parseStep.classList.remove('active');
                parseStep.classList.add('completed');
                parseStep.querySelector('.a-step-status').textContent = '完了 ✓';

                // Step 3: Classify
                classifyStep.classList.add('active');
                classifyStep.querySelector('.a-step-status').textContent = '処理中...';
                status.textContent = 'カテゴリ分類中...';
                animateProgress(classifyProgress, 800, () => {
                    classifyStep.classList.remove('active');
                    classifyStep.classList.add('completed');
                    classifyStep.querySelector('.a-step-status').textContent = '完了 ✓';
                    status.textContent = '解析完了！';

                    setTimeout(() => {
                        const result = generateSimulatedResult();
                        showReviewForm(result);
                        goToStep(3);
                    }, 500);
                });
            });
        });
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

    // シミュレート用AI解析結果生成
    function generateSimulatedResult() {
        const stores = ['セブンイレブン', 'ローソン', 'ファミリーマート', 'マルエイストア', 'イオン', 'サンドラッグ', '西友', 'まいばすけっと'];
        const foodItems = [
            { name: 'おにぎり 鮭', price: 160, category: '食費' },
            { name: 'サンドイッチ ミックス', price: 298, category: '食費' },
            { name: '緑茶 500ml', price: 150, category: '食費' },
            { name: 'コーヒー ブラック', price: 128, category: '食費' },
            { name: '牛乳 1L', price: 228, category: '食費' },
            { name: '食パン 6枚切', price: 168, category: '食費' },
            { name: 'バナナ 1房', price: 198, category: '食費' },
            { name: 'ヨーグルト 400g', price: 178, category: '食費' },
            { name: 'ティッシュ 5箱', price: 348, category: '日用品' },
            { name: 'ハンドソープ 詰替', price: 298, category: '衛生用品' },
        ];

        const numItems = 2 + Math.floor(Math.random() * 4);
        const selectedItems = [];
        const shuffled = [...foodItems].sort(() => Math.random() - 0.5);
        for (let i = 0; i < numItems && i < shuffled.length; i++) {
            selectedItems.push({
                name: shuffled[i].name,
                price: shuffled[i].price,
                quantity: 1,
                category: shuffled[i].category
            });
        }

        const total = selectedItems.reduce((s, item) => s + item.price * item.quantity, 0);

        return {
            store: stores[Math.floor(Math.random() * stores.length)],
            date: new Date().toISOString().slice(0, 16),
            items: selectedItems,
            total: total,
            confidence: 0.85 + Math.random() * 0.12
        };
    }

    // レビューフォーム表示
    function showReviewForm(result) {
        document.getElementById('review-store').value = result.store;
        document.getElementById('review-date').value = result.date;

        const confidence = Math.round(result.confidence * 100);
        document.getElementById('confidence-fill-lg').style.width = confidence + '%';
        document.getElementById('confidence-pct').textContent = confidence + '%';

        reviewItems = result.items.map((item, i) => ({ ...item, id: i }));
        renderReviewItems();
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
                <td class="col-subtotal">${formatCurrency(item.price * item.quantity)}</td>
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
                reviewItems[e.target.dataset.index].price = parseInt(e.target.value) || 0;
                updateReviewTotals();
            });
        });

        tbody.querySelectorAll('.review-item-qty').forEach(input => {
            input.addEventListener('input', (e) => {
                reviewItems[e.target.dataset.index].quantity = parseInt(e.target.value) || 1;
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
                const subtotal = reviewItems[index].price * reviewItems[index].quantity;
                tr.querySelector('.col-subtotal').textContent = formatCurrency(subtotal);
            }
        });

        const total = reviewItems.reduce((s, item) => s + (item.price * item.quantity), 0);
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

        const total = reviewItems.reduce((s, item) => s + (item.price * item.quantity), 0);

        const receipt = {
            id: generateId(),
            date: date || new Date().toISOString(),
            store: store,
            items: reviewItems.map(item => ({
                name: item.name,
                price: item.price,
                quantity: item.quantity,
                category: item.category
            })),
            total: total,
            confidence: parseFloat(document.getElementById('confidence-pct').textContent) / 100 || 0.9,
            status: 'validated'
        };

        appData.receipts.push(receipt);

        closeModal();
        showToast(`${store}のレシートを登録しました`);
        navigateTo(currentPage);
    });

    // モーダルリセット
    function resetModal() {
        goToStep(1);
        fileInput.value = '';
        reviewItems = [];
        document.getElementById('review-items-body').innerHTML = '';
        document.getElementById('review-store').value = '';
        document.getElementById('review-date').value = '';
        document.getElementById('review-total').textContent = '¥0';
        document.getElementById('confidence-fill-lg').style.width = '0%';
        document.getElementById('confidence-pct').textContent = '--%';
        [document.getElementById('ocr-progress'), document.getElementById('parse-progress'), document.getElementById('classify-progress')].forEach(p => p.style.width = '0%');
    }
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
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
    initUploadModal();
    initMonthSelector();
});