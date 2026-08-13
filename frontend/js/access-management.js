(() => {
    'use strict';

    let initialized = false;

    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function notify(message, icon = '✓') {
        if (typeof window.showToast === 'function') window.showToast(message, icon);
    }

    function empty(message) {
        return `<p class="settings-help">${esc(message)}</p>`;
    }

    function updateAdminBadge(count) {
        const total = Math.max(0, Number(count) || 0);
        const badge = document.getElementById('admin-request-count');
        const navBadge = document.getElementById('admin-nav-request-count');
        if (badge) {
            badge.textContent = `${total} PENDING`;
            badge.classList.toggle('has-pending', total > 0);
        }
        if (navBadge) {
            navBadge.textContent = String(total);
            navBadge.hidden = total === 0;
        }
    }

    function renderMembers(payload) {
        const container = document.getElementById('household-members-list');
        if (!container) return;
        const authUser = window.KakeiboAuth?.getUser?.() || {};
        const isOwner = authUser.household?.role === 'owner';
        const members = Array.isArray(payload.members) ? payload.members : [];
        const invitations = Array.isArray(payload.invitations) ? payload.invitations : [];
        const memberHtml = members.map(member => {
            const canRemove = isOwner && member.role !== 'owner' && member.subject !== authUser.subject;
            return `
                <div class="access-item">
                    <div class="access-item-main">
                        <div class="access-item-name">${esc(member.name || member.email)}<span class="access-role">${member.role === 'owner' ? 'OWNER' : 'MEMBER'}</span></div>
                        <div class="access-item-meta">${esc(member.email)} · ${member.status === 'active' ? '利用中' : esc(member.status)}</div>
                    </div>
                    ${canRemove ? `<div class="access-item-actions"><button class="btn btn-secondary" type="button" data-remove-member="${esc(member.subject)}">メンバー解除</button></div>` : ''}
                </div>`;
        }).join('');
        const inviteHtml = invitations.map(invitation => `
            <div class="access-item">
                <div class="access-item-main">
                    <div class="access-item-name">${esc(invitation.email)}<span class="access-role">INVITED</span></div>
                    <div class="access-item-meta">初回ログイン・管理者承認待ち</div>
                </div>
                ${isOwner ? `<div class="access-item-actions"><button class="btn btn-secondary" type="button" data-cancel-invitation="${esc(invitation.id)}">招待取消</button></div>` : ''}
            </div>`).join('');
        container.innerHTML = memberHtml + inviteHtml || empty('メンバー情報がありません。');
    }

    async function loadHousehold() {
        const user = window.KakeiboAuth?.getUser?.();
        if (!user) return;
        const selector = document.getElementById('household-selector');
        const badge = document.getElementById('household-role-badge');
        const inviteForm = document.getElementById('household-invite-form');
        if (selector) {
            selector.innerHTML = (user.households || []).map(household =>
                `<option value="${esc(household.id)}" ${household.id === user.household?.id ? 'selected' : ''}>${esc(household.name)}${household.role === 'owner' ? '（オーナー）' : ''}</option>`
            ).join('');
        }
        if (badge) badge.textContent = user.household?.role === 'owner' ? 'OWNER' : 'MEMBER';
        if (inviteForm) inviteForm.hidden = user.household?.role !== 'owner';
        try {
            renderMembers(await window.KakeiboShared.requestJson('/household/members'));
        } catch (error) {
            const container = document.getElementById('household-members-list');
            if (container) container.innerHTML = empty(error instanceof Error ? error.message : 'メンバーを読み込めませんでした。');
        }
    }

    function renderAdmin(requestPayload, userPayload) {
        const requests = Array.isArray(requestPayload.requests) ? requestPayload.requests : [];
        const users = Array.isArray(userPayload.users) ? userPayload.users : [];
        const current = window.KakeiboAuth?.getUser?.() || {};
        updateAdminBadge(requests.length);
        const requestContainer = document.getElementById('admin-signup-requests');
        if (requestContainer) {
            requestContainer.innerHTML = requests.map(request => `
                <div class="access-item">
                    <div class="access-item-main">
                        <div class="access-item-name">${esc(request.name || request.email)}</div>
                        <div class="access-item-meta">${esc(request.email)} · 初回利用申請</div>
                    </div>
                    <div class="access-item-actions"><button class="btn btn-primary" type="button" data-approve-user="${esc(request.subject)}">承認する</button></div>
                </div>`).join('') || empty('承認待ちの申請はありません。');
        }
        const userContainer = document.getElementById('admin-user-list');
        if (userContainer) {
            userContainer.innerHTML = users.map(account => {
                const isSelf = account.subject === current.subject;
                const isBanned = account.status === 'banned';
                const action = isSelf ? '' : isBanned
                    ? `<button class="btn btn-secondary" type="button" data-unban-user="${esc(account.subject)}">BAN解除</button>`
                    : `<button class="btn btn-secondary" type="button" data-ban-user="${esc(account.subject)}">BAN</button>`;
                return `
                    <div class="access-item">
                        <div class="access-item-main">
                            <div class="access-item-name ${isBanned ? 'access-status-banned' : ''}">${esc(account.name || account.email)}${account.is_admin ? '<span class="access-role">ADMIN</span>' : ''}</div>
                            <div class="access-item-meta">${esc(account.email)} · ${isBanned ? '利用停止' : account.status === 'active' ? '利用中' : '承認待ち'} · ${account.household_count}家計簿</div>
                        </div>
                        ${action ? `<div class="access-item-actions">${action}</div>` : ''}
                    </div>`;
            }).join('') || empty('利用アカウントがありません。');
        }
    }

    async function loadAdmin({ announce = false } = {}) {
        const user = window.KakeiboAuth?.getUser?.();
        const card = document.getElementById('platform-admin-card');
        if (!user?.is_admin) {
            if (card) card.hidden = true;
            updateAdminBadge(0);
            return;
        }
        if (card) card.hidden = false;
        try {
            const [requests, users] = await Promise.all([
                window.KakeiboShared.requestJson('/admin/signup-requests'),
                window.KakeiboShared.requestJson('/admin/users')
            ]);
            renderAdmin(requests, users);
            if (announce && requests.count > 0) notify(`${requests.count}件の新しい利用申請があります`, '🔔');
        } catch (error) {
            console.error('管理者通知を確認できませんでした。', error);
        }
    }

    async function load() {
        await Promise.all([loadHousehold(), loadAdmin()]);
    }

    function initialize() {
        if (initialized) return;
        initialized = true;
        document.getElementById('household-selector')?.addEventListener('change', async event => {
            event.target.disabled = true;
            try {
                await window.KakeiboAuth.selectHousehold(event.target.value);
                notify('表示する家計簿を切り替えました');
            } catch (error) {
                notify(error instanceof Error ? error.message : '家計簿を切り替えられませんでした', '⚠️');
            } finally {
                event.target.disabled = false;
            }
        });
        document.getElementById('household-invite-form')?.addEventListener('submit', async event => {
            event.preventDefault();
            const input = document.getElementById('household-invite-email');
            const button = event.currentTarget.querySelector('button[type="submit"]');
            button.disabled = true;
            try {
                await window.KakeiboShared.requestJson('/household/invitations', {
                    method: 'POST', body: JSON.stringify({ email: input.value })
                });
                input.value = '';
                await loadHousehold();
                notify('家計簿への招待を登録しました', '✉️');
            } catch (error) {
                notify(error instanceof Error ? error.message : '招待を登録できませんでした', '⚠️');
            } finally {
                button.disabled = false;
            }
        });
        document.getElementById('household-members-list')?.addEventListener('click', async event => {
            const removeButton = event.target.closest('[data-remove-member]');
            const cancelButton = event.target.closest('[data-cancel-invitation]');
            if (!removeButton && !cancelButton) return;
            if (!window.confirm(removeButton ? 'このメンバーを家計簿から解除しますか？' : 'この招待を取り消しますか？')) return;
            const path = removeButton
                ? `/household/members/${encodeURIComponent(removeButton.dataset.removeMember)}`
                : `/household/invitations/${encodeURIComponent(cancelButton.dataset.cancelInvitation)}`;
            try {
                await window.KakeiboShared.requestJson(path, { method: 'DELETE' });
                await loadHousehold();
                notify('アクセス設定を更新しました');
            } catch (error) {
                notify(error instanceof Error ? error.message : 'アクセス設定を更新できませんでした', '⚠️');
            }
        });
        document.getElementById('platform-admin-card')?.addEventListener('click', async event => {
            const approve = event.target.closest('[data-approve-user]');
            const ban = event.target.closest('[data-ban-user]');
            const unban = event.target.closest('[data-unban-user]');
            if (!approve && !ban && !unban) return;
            const subject = approve?.dataset.approveUser || ban?.dataset.banUser || unban?.dataset.unbanUser;
            const action = approve ? 'approve' : ban ? 'ban' : 'unban';
            if (ban && !window.confirm('このアカウントを直ちに利用停止（BAN）しますか？')) return;
            const path = action === 'approve'
                ? `/admin/signup-requests/${encodeURIComponent(subject)}/approve`
                : `/admin/users/${encodeURIComponent(subject)}/${action}`;
            event.target.disabled = true;
            try {
                await window.KakeiboShared.requestJson(path, { method: 'POST' });
                await loadAdmin();
                notify(action === 'approve' ? '利用申請を承認しました' : action === 'ban' ? 'アカウントをBANしました' : 'BANを解除しました');
            } catch (error) {
                notify(error instanceof Error ? error.message : '管理者操作を完了できませんでした', '⚠️');
            } finally {
                event.target.disabled = false;
            }
        });
    }

    window.KakeiboAccess = { load, loadAdmin };
    document.addEventListener('DOMContentLoaded', initialize);
    window.addEventListener('kakeibo:authenticated', () => loadAdmin({ announce: true }));
    window.addEventListener('kakeibo:household-changed', () => {
        if (typeof window.clearInMemoryData === 'function') window.clearInMemoryData();
        if (typeof window.loadSharedData === 'function') window.loadSharedData({ force: true });
        load();
    });
    window.addEventListener('kakeibo:signed-out', () => updateAdminBadge(0));
})();
