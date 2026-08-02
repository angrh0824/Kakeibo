// ===== モックデータ =====
const mockData = {
    kpi: {
        total: 45230,
        receipts: 23,
        items: 156,
        inflation: 3.2
    },
    categories: [
        { name: '食費', amount: 18500, color: '#4F46E5' },
        { name: '日用品', amount: 8200, color: '#10B981' },
        { name: '衛生用品', amount: 4500, color: '#F59E0B' },
        { name: '交際費', amount: 9800, color: '#EF4444' },
        { name: 'その他', amount: 4230, color: '#6B7280' }
    ],
    monthly: [
        { month: '3月', amount: 38200 },
        { month: '4月', amount: 41500 },
        { month: '5月', amount: 39800 },
        { month: '6月', amount: 43200 },
        { month: '7月', amount: 40400 },
        { month: '8月', amount: 45230 }
    ],
    receipts: [
        { id: 1, date: '2026-08-01', store: 'マルエイストア', items: 4, total: 1184, confidence: 0.95, status: 'validated' },
        { id: 2, date: '2026-08-01', store: 'セブンイレブン秋葉原駅前店', items: 3, total: 908, confidence: 0.92, status: 'validated' },
        { id: 3, date: '2026-08-01', store: 'サンドラッグ上野店', items: 3, total: 1326, confidence: 0.88, status: 'review' },
        { id: 4, date: '2026-07-31', store: 'イトーヨーカドー', items: 8, total: 5230, confidence: 0.97, status: 'validated' },
        { id: 5, date: '2026-07-30', store: 'マツモトキヨシ', items: 5, total: 2840, confidence: 0.91, status: 'validated' },
        { id: 6, date: '2026-07-29', store: '業務スーパー', items: 12, total: 6840, confidence: 0.85, status: 'review' },
        { id: 7, date: '2026-07-28', store: 'ローソン', items: 2, total: 640, confidence: 0.98, status: 'validated' },
        { id: 8, date: '2026-07-27', store: '西友', items: 6, total: 3890, confidence: 0.94, status: 'validated' },
        { id: 9, date: '2026-07-26', store: 'ドン・キホーテ', items: 4, total: 2150, confidence: 0.89, status: 'validated' },
        { id: 10, date: '2026-07-25', store: 'まいばすけっと', items: 3, total: 980, confidence: 0.96, status: 'validated' }
    ],
    items: [
        { id: 1, name: 'コカ・コーラ 500ml PET', category: '食費', aliases: 3, avgPrice: 158, count: 12 },
        { id: 2, name: 'トイレットペーパー 12R', category: '日用品', aliases: 2, avgPrice: 398, count: 8 },
        { id: 3, name: '牛乳 1L', category: '食費', aliases: 2, avgPrice: 228, count: 15 },
        { id: 4, name: 'シャンプー詰替', category: '日用品', aliases: 2, avgPrice: 448, count: 5 },
        { id: 5, name: 'マスク 30枚', category: '衛生用品', aliases: 2, avgPrice: 580, count: 4 },
        { id: 6, name: '食パン(6枚切)', category: '食費', aliases: 1, avgPrice: 298, count: 10 },
        { id: 7, name: '歯ブラシ 3本組', category: '衛生用品', aliases: 1, avgPrice: 298, count: 3 },
        { id: 8, name: '弁当 幕の内', category: '交際費', aliases: 1, avgPrice: 598, count: 6 }
    ],
    priceTrends: {
        'コカ・コーラ 500ml PET': [
            { month: '3月', price: 150 },
            { month: '4月', price: 152 },
            { month: '5月', price: 155 },
            { month: '6月', price: 158 },
            { month: '7月', price: 160 },
            { month: '8月', price: 165 }
        ],
        'トイレットペーパー 12R': [
            { month: '3月', price: 380 },
            { month: '4月', price: 385 },
            { month: '5月', price: 390 },
            { month: '6月', price: 395 },
            { month: '7月', price: 398 },
            { month: '8月', price: 410 }
        ],
        '牛乳 1L': [
            { month: '3月', price: 218 },
            { month: '4月', price: 220 },
            { month: '5月', price: 222 },
            { month: '6月', price: 225 },
            { month: '7月', price: 228 },
            { month: '8月', price: 235 }
        ]
    }
};

// ===== 状態管理 =====
let currentPage = 'dashboard';
let currentMonth = new Date(2026, 7, 1); // 2026年8月
let charts = {};

// ===== ユーティリティ =====
function formatCurrency(amount) {
    return '¥' + amount.toLocaleString('ja-JP');
}

function formatDate(dateStr) {
    const d = new Date(dateStr);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function getStatusBadge(status) {
    const labels = {
        'validated': '検証済み',
        'review': '要確認',
        'extracted': '抽出済み'
    };
    return `<span class="status-badge status-${status}">${labels[status] || status}</span>`;
}

// ===== ページナビゲーション =====
function navigateTo(page) {
    currentPage = page;
    
    // サイドバーのアクティブ状態を更新
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === page);
    });
    
    // ページ表示を切り替え
    document.querySelectorAll('.page').forEach(p => {
        p.classList.toggle('active', p.id === `page-${page}`);
    });
    
    // タイトル更新
    const titles = {
        'dashboard': ['ダッシュボード', '2026年8月の支出サマリー'],
        'receipts': ['レシート一覧', '全レシートの管理'],
        'items': ['商品マスタ', '名寄せされた商品の管理'],
        'trends': ['価格推移', '商品の価格変動をトラッキング'],
        'settings': ['設定', 'アプリの設定']
    };
    document.getElementById('page-title').textContent = titles[page][0];
    document.getElementById('page-subtitle').textContent = titles[page][1];
    
    // ページごとの初期化
    if (page === 'dashboard') initDashboard();
    if (page === 'receipts') initReceiptsPage();
    if (page === 'items') initItemsPage();
    if (page === 'trends') initTrendsPage();
    if (page === 'settings') initSettingsPage();
}

// ===== ダッシュボード =====
function initDashboard() {
    // KPI更新
    document.getElementById('kpi-total').textContent = formatCurrency(mockData.kpi.total);
    document.getElementById('kpi-receipts').textContent = mockData.kpi.receipts + '枚';
    document.getElementById('kpi-items').textContent = mockData.kpi.items + '点';
    document.getElementById('kpi-inflation').textContent = '+' + mockData.kpi.inflation + '%';
    
    // カテゴリ別支出チャート
    if (charts.category) charts.category.destroy();
    charts.category = new Chart(document.getElementById('category-chart'), {
        type: 'doughnut',
        data: {
            labels: mockData.categories.map(c => c.name),
            datasets: [{
                data: mockData.categories.map(c => c.amount),
                backgroundColor: mockData.categories.map(c => c.color),
                borderWidth: 2,
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { padding: 16, usePointStyle: true }
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const total = mockData.categories.reduce((s, c) => s + c.amount, 0);
                            const pct = ((ctx.parsed / total) * 100).toFixed(1);
                            return ` ${ctx.label}: ${formatCurrency(ctx.parsed)} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
    
    // 月次支出推移チャート
    if (charts.monthly) charts.monthly.destroy();
    charts.monthly = new Chart(document.getElementById('monthly-chart'), {
        type: 'bar',
        data: {
            labels: mockData.monthly.map(m => m.month),
            datasets: [{
                label: '支出',
                data: mockData.monthly.map(m => m.amount),
                backgroundColor: '#4F46E5',
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => ` ${formatCurrency(ctx.parsed.y)}`
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: (value) => '¥' + (value / 1000) + 'k'
                    }
                }
            }
        }
    });
    
    // 最近のレシート
    const tbody = document.querySelector('#recent-receipts-table tbody');
    tbody.innerHTML = mockData.receipts.slice(0, 5).map(r => `
        <tr>
            <td>${formatDate(r.date)}</td>
            <td>${r.store}</td>
            <td>${r.items}点</td>
            <td>${formatCurrency(r.total)}</td>
            <td>${getStatusBadge(r.status)}</td>
        </tr>
    `).join('');
}

// ===== レシート一覧ページ =====
function initReceiptsPage() {
    const tbody = document.querySelector('#receipts-table tbody');
    tbody.innerHTML = mockData.receipts.map(r => `
        <tr>
            <td>${formatDate(r.date)}</td>
            <td>${r.store}</td>
            <td>${r.items}点</td>
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
    
    // 検索フィルタ
    document.getElementById('receipt-search').addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = mockData.receipts.filter(r => 
            r.store.toLowerCase().includes(query)
        );
        tbody.innerHTML = filtered.map(r => `
            <tr>
                <td>${formatDate(r.date)}</td>
                <td>${r.store}</td>
                <td>${r.items}点</td>
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
    });
}

// ===== 商品マスタページ =====
function initItemsPage() {
    const tbody = document.querySelector('#items-table tbody');
    tbody.innerHTML = mockData.items.map(item => `
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
    
    // カテゴリフィルタ
    document.getElementById('item-category-filter').addEventListener('change', (e) => {
        const category = e.target.value;
        const filtered = category === 'all' 
            ? mockData.items 
            : mockData.items.filter(i => i.category === category);
        tbody.innerHTML = filtered.map(item => `
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
    });
}

// ===== 価格推移ページ =====
function initTrendsPage() {
    // 商品セレクトを初期化
    const select = document.getElementById('trend-item-select');
    select.innerHTML = '<option value="">商品を選択...</option>' + 
        Object.keys(mockData.priceTrends).map(name => 
            `<option value="${name}">${name}</option>`
        ).join('');
    
    select.addEventListener('change', (e) => {
        const itemName = e.target.value;
        if (!itemName) return;
        
        const trend = mockData.priceTrends[itemName];
        
        // チャート描画
        if (charts.trend) charts.trend.destroy();
        charts.trend = new Chart(document.getElementById('price-trend-chart'), {
            type: 'line',
            data: {
                labels: trend.map(t => t.month),
                datasets: [{
                    label: itemName,
                    data: trend.map(t => t.price),
                    borderColor: '#4F46E5',
                    backgroundColor: 'rgba(79, 70, 229, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 6,
                    pointBackgroundColor: '#4F46E5'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => ` ${formatCurrency(ctx.parsed.y)}`
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: false,
                        ticks: {
                            callback: (value) => '¥' + value
                        }
                    }
                }
            }
        });
        
        // 統計表示
        const prices = trend.map(t => t.price);
        const first = prices[0];
        const last = prices[prices.length - 1];
        const change = ((last - first) / first * 100).toFixed(1);
        const avg = prices.reduce((s, p) => s + p, 0) / prices.length;
        const min = Math.min(...prices);
        const max = Math.max(...prices);
        
        document.getElementById('trend-stats').innerHTML = `
            <div class="trend-stat">
                <div class="label">現在価格</div>
                <div class="value">${formatCurrency(last)}</div>
            </div>
            <div class="trend-stat">
                <div class="label">変動率</div>
                <div class="value" style="color:${change >= 0 ? '#EF4444' : '#10B981'}">
                    ${change >= 0 ? '+' : ''}${change}%
                </div>
            </div>
            <div class="trend-stat">
                <div class="label">平均価格</div>
                <div class="value">${formatCurrency(Math.round(avg))}</div>
            </div>
            <div class="trend-stat">
                <div class="label">価格帯</div>
                <div class="value">${formatCurrency(min)} - ${formatCurrency(max)}</div>
            </div>
        `;
    });
}

// ===== 設定ページ =====
function initSettingsPage() {
    const categoryColors = {
        '食費': '#4F46E5',
        '日用品': '#10B981',
        '衛生用品': '#F59E0B',
        '交際費': '#EF4444',
        'その他': '#6B7280'
    };
    
    document.getElementById('category-settings').innerHTML = 
        Object.entries(categoryColors).map(([name, color]) => `
            <div class="settings-item">
                <span class="category-name">${name}</span>
                <div class="category-color" style="background:${color}"></div>
            </div>
        `).join('');
    
    // スライダー表示更新
    document.querySelector('.slider').addEventListener('input', (e) => {
        document.querySelector('.slider-value').textContent = e.target.value;
    });
}

// ===== アップロードモーダル =====
function initUploadModal() {
    const modal = document.getElementById('upload-modal');
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    
    // モーダルを開く
    document.getElementById('btn-upload').addEventListener('click', () => {
        modal.classList.add('active');
    });
    
    // モーダルを閉じる
    document.getElementById('close-modal').addEventListener('click', () => {
        modal.classList.remove('active');
        resetUploadUI();
    });
    
    // 背景クリックで閉じる
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.remove('active');
            resetUploadUI();
        }
    });
    
    // ファイル選択
    document.getElementById('btn-select-file').addEventListener('click', () => {
        fileInput.click();
    });
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFiles(e.target.files);
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
        handleFiles(e.dataTransfer.files);
    });
    
    function handleFiles(files) {
        // アップロードUIに切り替え
        uploadZone.style.display = 'none';
        document.getElementById('upload-progress').style.display = 'block';
        
        // プログレスバーをシミュレート
        let progress = 0;
        const fill = document.getElementById('progress-fill');
        const text = document.getElementById('progress-text');
        
        const interval = setInterval(() => {
            progress += Math.random() * 15;
            if (progress >= 100) {
                progress = 100;
                clearInterval(interval);
                showResult(files.length);
            }
            fill.style.width = progress + '%';
            text.textContent = `解析中... ${Math.round(progress)}%`;
        }, 200);
    }
    
    function showResult(fileCount) {
        document.getElementById('upload-progress').style.display = 'none';
        document.getElementById('upload-result').style.display = 'block';
        document.getElementById('result-text').textContent = 
            `${fileCount}枚の画像の解析が完了しました`;
        document.getElementById('result-details').innerHTML = `
            <p>📷 検出レシート: ${fileCount * 2}枚</p>
            <p>🏷️ 抽出品目: ${fileCount * 8}点</p>
            <p>✅ 名寄せ完了: ${fileCount * 7}点</p>
            <p>⚠️ 要確認: ${fileCount}点</p>
        `;
    }
    
    function resetUploadUI() {
        uploadZone.style.display = 'block';
        document.getElementById('upload-progress').style.display = 'none';
        document.getElementById('upload-result').style.display = 'none';
        document.getElementById('progress-fill').style.width = '0%';
        fileInput.value = '';
    }
}

// ===== 月セレクター =====
function initMonthSelector() {
    const monthLabel = document.getElementById('current-month');
    
    function updateMonth() {
        monthLabel.textContent = 
            `${currentMonth.getFullYear()}年${currentMonth.getMonth() + 1}月`;
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
    initDashboard();
    initUploadModal();
    initMonthSelector();
});