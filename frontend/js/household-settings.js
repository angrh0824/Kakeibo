// 家計簿ごとの設定（カテゴリ・予算・固定費）と、それに基づく計算。
// サーバーが設定APIに未対応（404/405）の場合は、この端末に保存して動作を続ける。
(() => {
    'use strict';

    const FALLBACK_CATEGORY = 'その他';
    const COLOR_SLOTS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'gray'];
    const DEFAULT_CATEGORIES = [
        { name: '食費', color: 'c1', budget: 0 },
        { name: '日用品', color: 'c2', budget: 0 },
        { name: '衛生用品', color: 'c3', budget: 0 },
        { name: '交際費', color: 'c4', budget: 0 },
        { name: '住居・光熱', color: 'c5', budget: 0 },
        { name: '通信・サブスク', color: 'c7', budget: 0 },
        { name: FALLBACK_CATEGORY, color: 'gray', budget: 0 }
    ];
    const LOCAL_KEY_PREFIX = 'kakeibo.settings.v1.';

    let current = normalize({ categories: DEFAULT_CATEGORIES, monthly_budget: 0, recurring: [] });
    let mode = 'default'; // default | server | local
    let loadPromise = null;

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function toInt(value, fallback = 0) {
        const number = Math.round(Number(value));
        return Number.isFinite(number) ? number : fallback;
    }

    function isMonthKey(value) {
        return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
    }

    function monthKeyOf(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    }

    // サーバー側の検証と同じ規則で整える。壊れた値があっても画面は動かし続ける。
    function normalize(raw) {
        const source = raw && typeof raw === 'object' ? raw : {};
        const seen = new Set();
        const categories = [];
        (Array.isArray(source.categories) ? source.categories : DEFAULT_CATEGORIES).forEach(category => {
            const name = String(category?.name || '').trim().slice(0, 40);
            if (!name || seen.has(name)) return;
            seen.add(name);
            categories.push({
                name,
                color: COLOR_SLOTS.includes(category?.color) ? category.color : 'gray',
                budget: Math.max(0, toInt(category?.budget))
            });
        });
        if (!seen.has(FALLBACK_CATEGORY)) {
            categories.push({ name: FALLBACK_CATEGORY, color: 'gray', budget: 0 });
            seen.add(FALLBACK_CATEGORY);
        }
        const ids = new Set();
        const recurring = [];
        (Array.isArray(source.recurring) ? source.recurring : []).forEach(expense => {
            const id = String(expense?.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
            const name = String(expense?.name || '').trim().slice(0, 100);
            if (!id || !name || ids.has(id)) return;
            ids.add(id);
            const startMonth = isMonthKey(expense.start_month) ? expense.start_month : monthKeyOf(new Date());
            const endMonth = isMonthKey(expense.end_month) && expense.end_month >= startMonth ? expense.end_month : '';
            recurring.push({
                id,
                name,
                amount: Math.max(0, toInt(expense.amount)),
                category: seen.has(expense.category) ? expense.category : FALLBACK_CATEGORY,
                day: Math.min(31, Math.max(1, toInt(expense.day, 1))),
                start_month: startMonth,
                end_month: endMonth,
                memo: String(expense.memo || '').trim().slice(0, 200)
            });
        });
        return {
            categories,
            monthly_budget: Math.max(0, toInt(source.monthly_budget)),
            recurring,
            is_default: Boolean(source.is_default),
            updated_at: source.updated_at || null,
            updated_by: source.updated_by || null
        };
    }

    function payloadOf(settings) {
        return {
            categories: settings.categories.map(({ name, color, budget }) => ({ name, color, budget })),
            monthly_budget: settings.monthly_budget,
            recurring: settings.recurring.map(expense => ({ ...expense }))
        };
    }

    function householdKey() {
        const id = window.KakeiboAuth?.getHouseholdId?.() || 'local';
        return LOCAL_KEY_PREFIX + id;
    }

    function readLocal() {
        try {
            const stored = localStorage.getItem(householdKey());
            return stored ? JSON.parse(stored) : null;
        } catch (_) {
            return null;
        }
    }

    function writeLocal(settings) {
        try {
            localStorage.setItem(householdKey(), JSON.stringify(payloadOf(settings)));
            return true;
        } catch (_) {
            return false;
        }
    }

    function announce() {
        window.dispatchEvent(new CustomEvent('kakeibo:settings-changed', { detail: { settings: get(), mode } }));
    }

    function isUnsupported(status) {
        return status === 404 || status === 405;
    }

    async function load({ force = false } = {}) {
        if (loadPromise && !force) return loadPromise;
        loadPromise = (async () => {
            if (!window.KakeiboShared) return current;
            try {
                const response = await window.KakeiboShared.request('/household/settings');
                if (isUnsupported(response.status)) {
                    const local = readLocal();
                    current = normalize(local || { categories: DEFAULT_CATEGORIES, is_default: true });
                    mode = 'local';
                } else {
                    const payload = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(payload.detail || `設定を読み込めませんでした (${response.status})`);
                    current = normalize(payload.settings);
                    mode = 'server';
                }
            } catch (error) {
                console.warn('家計簿の設定を読み込めませんでした。', error);
                const local = readLocal();
                if (local) current = normalize(local);
                if (mode === 'default') mode = local ? 'local' : 'default';
            } finally {
                loadPromise = null;
            }
            announce();
            return current;
        })();
        return loadPromise;
    }

    async function save(next) {
        const normalized = normalize(next);
        if (mode === 'local' || mode === 'default') {
            const response = await window.KakeiboShared?.request('/household/settings', {
                method: 'PUT',
                body: JSON.stringify(payloadOf(normalized))
            }).catch(() => null);
            if (response && response.ok) {
                const payload = await response.json().catch(() => ({}));
                current = normalize(payload.settings || normalized);
                mode = 'server';
                announce();
                return current;
            }
            if (response && !isUnsupported(response.status)) {
                const payload = await response.json().catch(() => ({}));
                throw new Error(detailText(payload.detail) || '設定を保存できませんでした。');
            }
            current = normalized;
            mode = 'local';
            writeLocal(current);
            announce();
            return current;
        }
        const payload = await window.KakeiboShared.requestJson('/household/settings', {
            method: 'PUT',
            body: JSON.stringify(payloadOf(normalized))
        });
        current = normalize(payload.settings || normalized);
        announce();
        return current;
    }

    function detailText(detail) {
        if (typeof detail === 'string') return detail;
        if (Array.isArray(detail) && detail.length) {
            const message = String(detail[0]?.msg || '');
            return message.replace(/^Value error,\s*/, '');
        }
        return '';
    }

    // カテゴリ名の変更、または別カテゴリへの統合。記録の品目もまとめて変更する。
    async function reassignCategory(fromName, toName, receipts = []) {
        if (mode === 'server') {
            const payload = await window.KakeiboShared.requestJson('/household/categories/reassign', {
                method: 'POST',
                body: JSON.stringify({ from_name: fromName, to_name: toName })
            }).catch(error => { throw new Error(error instanceof Error ? error.message : 'カテゴリを変更できませんでした。'); });
            current = normalize(payload.settings);
            announce();
            return { affected: Number(payload.affected_receipts) || 0 };
        }

        // サーバーが一括変更に未対応の場合は、該当する記録を1件ずつ更新する。
        let affected = 0;
        for (const receipt of receipts) {
            const items = Array.isArray(receipt.items) ? receipt.items : [];
            if (!items.some(item => item.category === fromName)) continue;
            const body = {
                date: receipt.date,
                store: receipt.store || '記録',
                source_filename: receipt.source_filename || '',
                image_storage: receipt.image_storage || null,
                items: items.map(item => ({
                    name: item.name || '品目',
                    price: Math.max(0, toInt(item.price)),
                    quantity: Math.max(1, toInt(item.quantity, 1)),
                    category: item.category === fromName ? toName : (item.category || FALLBACK_CATEGORY),
                    line_total: Math.max(0, toInt(item.line_total, toInt(item.price) * Math.max(1, toInt(item.quantity, 1))))
                })),
                total: toInt(receipt.total),
                confidence: Math.min(1, Math.max(0, Number(receipt.confidence) || 0)),
                status: receipt.status || 'validated',
                entry_type: receipt.entry_type || 'receipt',
                memo: receipt.memo || '',
                recurring_id: receipt.recurring_id || ''
            };
            await window.KakeiboShared.requestJson(`/receipts/${encodeURIComponent(receipt.id)}`, {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            affected += 1;
        }
        const next = clone(current);
        const names = next.categories.map(category => category.name);
        if (names.includes(toName)) {
            const source = next.categories.find(category => category.name === fromName);
            const target = next.categories.find(category => category.name === toName);
            if (source && target) target.budget += source.budget;
            next.categories = next.categories.filter(category => category.name !== fromName);
        } else {
            next.categories.forEach(category => { if (category.name === fromName) category.name = toName; });
        }
        next.recurring.forEach(expense => { if (expense.category === fromName) expense.category = toName; });
        await save(next);
        return { affected };
    }

    function get() {
        return clone(current);
    }

    function categories() {
        return current.categories.map(category => ({ ...category }));
    }

    function categoryNames() {
        return current.categories.map(category => category.name);
    }

    function colorSlot(name) {
        const found = current.categories.find(category => category.name === name);
        return found ? found.color : 'gray';
    }

    function colorVar(name) {
        return `var(--${colorSlot(name)})`;
    }

    function nextColorSlot() {
        const used = new Set(current.categories.map(category => category.color));
        return COLOR_SLOTS.find(slot => slot !== 'gray' && !used.has(slot)) || 'gray';
    }

    // 月の予算。未設定ならカテゴリ予算の合計を使う。
    function monthlyBudget() {
        if (current.monthly_budget > 0) return current.monthly_budget;
        return current.categories.reduce((sum, category) => sum + category.budget, 0);
    }

    function recurringId() {
        return `rc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }

    function linkedRecurringId(receipt) {
        if (receipt?.recurring_id) return String(receipt.recurring_id);
        const source = String(receipt?.source_filename || '');
        return source.startsWith('recurring:') ? source.slice('recurring:'.length) : '';
    }

    function isActiveIn(expense, monthKey) {
        if (expense.start_month > monthKey) return false;
        return !expense.end_month || expense.end_month >= monthKey;
    }

    // 指定月の固定費。実際の記録があればそれを優先し、なければ予定として計上する。
    // 金額が0（毎月入力）のものは pending として返す。
    function recurringForMonth(year, monthIndex, monthReceipts = []) {
        const monthKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
        const recorded = new Set(monthReceipts.map(linkedRecurringId).filter(Boolean));
        const lastDay = new Date(year, monthIndex + 1, 0).getDate();
        const entries = [];
        const pending = [];
        current.recurring.forEach(expense => {
            if (!isActiveIn(expense, monthKey) || recorded.has(expense.id)) return;
            const date = new Date(year, monthIndex, Math.min(expense.day, lastDay), 12, 0, 0);
            if (expense.amount > 0) {
                entries.push({
                    id: `recurring:${expense.id}:${monthKey}`,
                    virtual: true,
                    entry_type: 'recurring',
                    recurring_id: expense.id,
                    status: 'recurring',
                    store: expense.name,
                    memo: expense.memo,
                    date: localIso(date),
                    total: expense.amount,
                    confidence: 1,
                    items: [{ name: expense.name, price: expense.amount, quantity: 1, category: expense.category, line_total: expense.amount }]
                });
            } else {
                pending.push({ expense, date });
            }
        });
        return { entries, pending };
    }

    function localIso(date) {
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
    }

    window.KakeiboSettings = {
        FALLBACK_CATEGORY,
        COLOR_SLOTS,
        load,
        save,
        reassignCategory,
        get,
        categories,
        categoryNames,
        colorSlot,
        colorVar,
        nextColorSlot,
        monthlyBudget,
        recurringForMonth,
        linkedRecurringId,
        recurringId,
        localIso,
        mode: () => mode,
        reset() {
            current = normalize({ categories: DEFAULT_CATEGORIES, monthly_budget: 0, recurring: [] });
            mode = 'default';
            announce();
        }
    };
})();
