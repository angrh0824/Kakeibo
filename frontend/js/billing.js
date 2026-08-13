(() => {
    'use strict';

    let initialized = false;
    let payPayQrObjectUrl = '';

    const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));

    function currentMonth() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    function yen(value, detailed = false) {
        const amount = Number(value) || 0;
        const decimals = detailed && Math.abs(amount) < 100 ? 2 : 0;
        return new Intl.NumberFormat('ja-JP', {
            style: 'currency', currency: 'JPY',
            minimumFractionDigits: decimals, maximumFractionDigits: decimals,
        }).format(amount);
    }

    function bytes(value) {
        const size = Math.max(0, Number(value) || 0);
        if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }

    function text(id, value) {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    }

    function notify(message, icon = '✓') {
        if (typeof window.showToast === 'function') window.showToast(message, icon);
    }

    function resetUploadButton() {
        const button = document.getElementById('btn-upload');
        if (!button) return;
        button.disabled = false;
        button.removeAttribute('data-billing-blocked');
        button.title = '';
    }

    async function loadPayPayQr(configured) {
        const image = document.getElementById('paypay-qr-image');
        const empty = document.getElementById('paypay-qr-empty');
        if (!image || !empty) return;
        if (payPayQrObjectUrl) {
            URL.revokeObjectURL(payPayQrObjectUrl);
            payPayQrObjectUrl = '';
        }
        image.hidden = true;
        image.removeAttribute('src');
        empty.hidden = false;
        if (!configured) {
            empty.textContent = '加盟店QRは管理者が登録後に表示されます。';
            return;
        }
        try {
            const response = await window.KakeiboShared.request('/billing/payment-qr');
            if (!response.ok) throw new Error('加盟店QRを読み込めませんでした。');
            payPayQrObjectUrl = URL.createObjectURL(await response.blob());
            image.src = payPayQrObjectUrl;
            image.hidden = false;
            empty.hidden = true;
        } catch (error) {
            empty.textContent = error instanceof Error ? error.message : 'QRコードを読み込めませんでした。';
        }
    }

    function renderOwner(payload) {
        const card = document.getElementById('household-billing-card');
        if (!card) return;
        card.hidden = false;
        const costs = payload.costs || {};
        const components = costs.components_jpy || {};
        const usage = payload.usage || {};
        text('billing-payment-amount', yen(costs.payment_amount_jpy));
        text('billing-base-cost', yen(costs.estimated_cost_jpy, true));
        text('billing-service-fee', yen(costs.service_fee_jpy, true));
        text('billing-cost-ai', yen(components.ai, true));
        text('billing-cost-run', yen(components.cloud_run, true));
        text('billing-cost-firestore', yen(components.firestore, true));
        text('billing-cost-storage', yen(components.storage, true));
        text('billing-estimate-note', payload.estimate_note || '利用料金は概算です。');
        text('paypay-recipient', `${payload.payment?.recipient || '管理者'} 宛て`);

        const limit = Number(costs.monthly_limit_jpy) || 0;
        text('billing-limit-label', limit ? `月額上限 ${yen(limit)}` : '月額上限なし');
        text('billing-limit-remaining', limit ? `残り ${yen(costs.remaining_jpy)}` : '管理者による上限なし');
        const progress = document.getElementById('billing-limit-progress');
        if (progress) progress.style.width = `${Math.min(100, Math.max(0, Number(costs.used_percent) || 0))}%`;
        card.dataset.status = costs.status || 'ok';
        const message = costs.status === 'blocked'
            ? '上限に達したため、新しいAI解析は停止中です。既存データは閲覧できます。'
            : costs.status === 'warning'
                ? '上限の80%を超えています。使いすぎにご注意ください。'
                : `上限の${Number(costs.used_percent || 0).toFixed(1)}%を利用しています。`;
        text('billing-limit-message', message);

        const chips = document.getElementById('billing-usage-chips');
        if (chips) chips.innerHTML = [
            `${usage.ai_requests || 0}回のAI解析`,
            `${Number(usage.total_tokens || 0).toLocaleString('ja-JP')} tokens`,
            `${usage.receipts_detected || 0}枚検出`,
            `画像 ${bytes(usage.storage_bytes_current)}`,
        ].map(label => `<span>${esc(label)}</span>`).join('');

        const selectedPeriod = document.getElementById('billing-period')?.value || currentMonth();
        const upload = document.getElementById('btn-upload');
        if (upload) resetUploadButton();
        if (upload && selectedPeriod === currentMonth()) {
            upload.disabled = costs.can_analyze === false;
            if (upload.disabled) {
                upload.dataset.billingBlocked = 'true';
                upload.title = '今月の利用上限に達しています';
            } else {
                upload.removeAttribute('data-billing-blocked');
                upload.title = '';
            }
        }
        loadPayPayQr(Boolean(payload.payment?.qr_configured));
    }

    async function loadOwner() {
        const user = window.KakeiboAuth?.getUser?.();
        const card = document.getElementById('household-billing-card');
        resetUploadButton();
        if (!user || user.household?.role !== 'owner') {
            if (card) card.hidden = true;
            return;
        }
        const period = document.getElementById('billing-period')?.value || currentMonth();
        try {
            renderOwner(await window.KakeiboShared.requestJson(`/billing/summary?period=${encodeURIComponent(period)}`));
        } catch (error) {
            if (card) card.hidden = false;
            text('billing-limit-message', error instanceof Error ? error.message : '料金情報を読み込めませんでした。');
        }
    }

    function renderAdmin(payload) {
        text('admin-billing-base-total', yen(payload.total_estimated_cost_jpy, true));
        text('admin-billing-payment-total', yen(payload.total_payment_amount_jpy));
        const container = document.getElementById('admin-billing-list');
        if (!container) return;
        const households = Array.isArray(payload.households) ? payload.households : [];
        container.innerHTML = households.map(summary => {
            const household = summary.household || {};
            const costs = summary.costs || {};
            const usage = summary.usage || {};
            return `
                <div class="admin-billing-item" data-status="${esc(costs.status || 'ok')}">
                    <div class="admin-billing-main">
                        <strong>${esc(household.name || '家計簿')}</strong>
                        <span>${esc(household.owner_email || 'オーナー未設定')} · AI ${usage.ai_requests || 0}回</span>
                    </div>
                    <div class="admin-billing-money">
                        <small>原価 ${yen(costs.estimated_cost_jpy, true)}</small>
                        <strong>${yen(costs.payment_amount_jpy)}</strong>
                    </div>
                    <div class="admin-limit-control">
                        <label>月額上限</label>
                        <input class="form-input" type="number" min="0" max="1000000" step="100" value="${Number(costs.monthly_limit_jpy) || 0}" data-limit-input="${esc(household.id)}">
                        <button class="btn btn-secondary" type="button" data-save-limit="${esc(household.id)}">保存</button>
                    </div>
                </div>`;
        }).join('') || '<p class="settings-help">家計簿がありません。</p>';
    }

    async function loadAdmin() {
        const user = window.KakeiboAuth?.getUser?.();
        const card = document.getElementById('platform-billing-card');
        if (!user?.is_admin) {
            if (card) card.hidden = true;
            return;
        }
        if (card) card.hidden = false;
        const period = document.getElementById('admin-billing-period')?.value || currentMonth();
        try {
            renderAdmin(await window.KakeiboShared.requestJson(`/admin/billing/households?period=${encodeURIComponent(period)}`));
        } catch (error) {
            const container = document.getElementById('admin-billing-list');
            if (container) container.innerHTML = `<p class="settings-help">${esc(error instanceof Error ? error.message : '料金一覧を読み込めませんでした。')}</p>`;
        }
    }

    async function load() {
        await Promise.all([loadOwner(), loadAdmin()]);
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        const month = currentMonth();
        const ownerPeriod = document.getElementById('billing-period');
        const adminPeriod = document.getElementById('admin-billing-period');
        if (ownerPeriod) ownerPeriod.value = month;
        if (adminPeriod) adminPeriod.value = month;
        ownerPeriod?.addEventListener('change', loadOwner);
        adminPeriod?.addEventListener('change', loadAdmin);
        document.querySelector('[data-page="settings"]')?.addEventListener('click', load);

        document.getElementById('admin-billing-list')?.addEventListener('click', async event => {
            const button = event.target.closest('[data-save-limit]');
            if (!button) return;
            const householdId = button.dataset.saveLimit;
            const input = document.querySelector(`[data-limit-input="${CSS.escape(householdId)}"]`);
            button.disabled = true;
            try {
                await window.KakeiboShared.requestJson(`/admin/billing/households/${encodeURIComponent(householdId)}`, {
                    method: 'PATCH', body: JSON.stringify({ monthly_limit_jpy: Number(input?.value) || 0 }),
                });
                await load();
                notify('月額上限を更新しました');
            } catch (error) {
                notify(error instanceof Error ? error.message : '月額上限を更新できませんでした。', '⚠️');
            } finally {
                button.disabled = false;
            }
        });

        document.getElementById('billing-qr-upload-form')?.addEventListener('submit', async event => {
            event.preventDefault();
            const input = document.getElementById('billing-qr-file');
            const file = input?.files?.[0];
            if (!file) {
                notify('PayPay加盟店QR画像を選択してください。', '⚠️');
                return;
            }
            const button = event.currentTarget.querySelector('button[type="submit"]');
            const form = new FormData();
            form.append('file', file);
            button.disabled = true;
            try {
                await window.KakeiboShared.requestJson('/admin/billing/payment-qr', { method: 'POST', body: form });
                input.value = '';
                await loadOwner();
                notify('PayPay加盟店QRを非公開保存しました');
            } catch (error) {
                notify(error instanceof Error ? error.message : '加盟店QRを保存できませんでした。', '⚠️');
            } finally {
                button.disabled = false;
            }
        });

        if (window.KakeiboAuth?.getUser?.()) load();
    }

    window.KakeiboBilling = { load, loadOwner, loadAdmin };
    document.addEventListener('DOMContentLoaded', initialize);
    window.addEventListener('kakeibo:authenticated', load);
    window.addEventListener('kakeibo:household-changed', load);
    window.addEventListener('kakeibo:signed-out', () => {
        document.getElementById('household-billing-card')?.setAttribute('hidden', '');
        document.getElementById('platform-billing-card')?.setAttribute('hidden', '');
        resetUploadButton();
    });
})();
