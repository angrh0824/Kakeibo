(() => {
    'use strict';

    // ログイン状態は端末に残し、次回以降はGoogleの自動ログイン（One Tap / FedCM）で通過させる。
    // GoogleのIDトークンは約1時間で期限が切れるため、期限の少し前に裏で更新する。
    const TOKEN_KEY = 'kakeibo.googleIdToken.v1';
    const USER_KEY = 'kakeibo.googleUser.v2';
    const HOUSEHOLD_KEY = 'kakeibo.activeHousehold.v1';
    const LAST_LOGIN_KEY = 'kakeibo.lastLogin.v1';
    const REFRESH_BEFORE_MS = 5 * 60 * 1000;
    const AUTO_SIGN_IN_WAIT_MS = 4500;
    const clientId = String(window.KAKEIBO_GOOGLE_CLIENT_ID || '').trim();
    const enabled = clientId.length > 0;
    let googleInitialized = false;
    let googleButtonRendered = false;
    let currentUser = null;
    let authViewportFrame = 0;
    let refreshTimer = 0;
    let autoSignInTimer = 0;
    let autoSignInActive = false;

    // ===== 端末への保存（使えない環境でも動作は続ける） =====
    function read(key) {
        try {
            return localStorage.getItem(key) || sessionStorage.getItem(key) || '';
        } catch (_) {
            return '';
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, value);
            sessionStorage.removeItem(key);
        } catch (_) {
            try { sessionStorage.setItem(key, value); } catch (__) { /* 保存できなくても今回の表示は続ける */ }
        }
    }

    function remove(key) {
        try { localStorage.removeItem(key); } catch (_) { /* noop */ }
        try { sessionStorage.removeItem(key); } catch (_) { /* noop */ }
    }

    function getApiBaseUrl() {
        const configuredBase = String(window.KAKEIBO_API_BASE_URL || '').trim();
        const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        const isHttpOrigin = /^https?:$/.test(window.location.protocol);
        const fallback = isHttpOrigin && !isLocalHost ? window.location.origin : 'http://localhost:8000';
        return String(configuredBase || fallback).replace(/\/+$/, '');
    }

    function decodePayload(token) {
        try {
            const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
            return JSON.parse(decodeURIComponent(Array.from(atob(padded), char => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join('')));
        } catch (_) {
            return null;
        }
    }

    function tokenExpiresAt(token) {
        const payload = token ? decodePayload(token) : null;
        return payload && payload.exp ? payload.exp * 1000 : 0;
    }

    function getToken() {
        const token = read(TOKEN_KEY);
        if (!token || tokenExpiresAt(token) <= Date.now() + 30000) {
            if (token) remove(TOKEN_KEY);
            return '';
        }
        return token;
    }

    function lastLogin() {
        try {
            const value = JSON.parse(read(LAST_LOGIN_KEY) || 'null');
            return value && value.email ? value : null;
        } catch (_) {
            return null;
        }
    }

    function getHouseholdId() {
        try {
            return String(localStorage.getItem(HOUSEHOLD_KEY) || currentUser?.household?.id || '').trim();
        } catch (_) {
            return String(currentUser?.household?.id || '').trim();
        }
    }

    function normalizeDetail(detail, fallback) {
        if (typeof detail === 'string' && detail) return detail;
        if (detail && typeof detail === 'object' && detail.message) return String(detail.message);
        return fallback;
    }

    function setSidebarUser(user) {
        const name = document.getElementById('signed-in-user-name');
        const email = document.getElementById('signed-in-user-email');
        const avatar = document.getElementById('signed-in-user-avatar');
        const household = document.getElementById('active-household-name');
        const signOut = document.getElementById('btn-sign-out');
        if (name) name.textContent = user?.name || 'ユーザー';
        if (email) email.textContent = user?.email || '';
        if (household) household.textContent = user?.household?.name || '家計簿を選択';
        if (avatar) {
            avatar.textContent = (user?.name || user?.email || '家').trim().charAt(0).toUpperCase();
            if (user?.picture) {
                avatar.style.backgroundImage = `url("${String(user.picture).replace(/["\\]/g, '')}")`;
                avatar.classList.add('has-image');
            } else {
                avatar.style.backgroundImage = '';
                avatar.classList.remove('has-image');
            }
        }
        if (signOut) signOut.hidden = !enabled || !user;
    }

    function setError(message = '') {
        const error = document.getElementById('auth-error');
        if (!error) return;
        error.textContent = message;
        error.hidden = !message;
    }

    // 自動ログインを試している間の表示。失敗したらボタンでのログインに切り替える。
    function setAutoStatus(message = '') {
        const status = document.getElementById('auth-auto-status');
        const card = document.querySelector('.auth-card');
        if (status) {
            status.textContent = message;
            status.hidden = !message;
        }
        card?.classList.toggle('is-auto-signing-in', Boolean(message));
    }

    function syncAuthViewport() {
        const gate = document.getElementById('auth-gate');
        const viewport = window.visualViewport;
        if (!gate || !viewport) return;
        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));
        if (!Number.isFinite(width) || !Number.isFinite(height)) return;
        gate.style.setProperty('--auth-viewport-left', `${Math.round(viewport.offsetLeft || 0)}px`);
        gate.style.setProperty('--auth-viewport-top', `${Math.round(viewport.offsetTop || 0)}px`);
        gate.style.setProperty('--auth-viewport-width', `${width}px`);
        gate.style.setProperty('--auth-viewport-height', `${height}px`);
        gate.classList.add('auth-visual-viewport');
    }

    function requestAuthViewportSync() {
        if (authViewportFrame) return;
        authViewportFrame = window.requestAnimationFrame(() => {
            authViewportFrame = 0;
            syncAuthViewport();
        });
    }

    function initializeAuthViewport() {
        syncAuthViewport();
        window.addEventListener('resize', requestAuthViewportSync, { passive: true });
        window.addEventListener('orientationchange', requestAuthViewportSync, { passive: true });
        window.visualViewport?.addEventListener('resize', requestAuthViewportSync, { passive: true });
        window.visualViewport?.addEventListener('scroll', requestAuthViewportSync, { passive: true });
    }

    function showGate(message = '') {
        document.body.classList.add('auth-required');
        document.body.classList.remove('authenticated', 'auth-pending');
        const gate = document.getElementById('auth-gate');
        if (gate) gate.setAttribute('aria-hidden', 'false');
        requestAuthViewportSync();
        setError(message);
        renderGoogleButton();
    }

    function hideGate(user) {
        document.body.classList.remove('auth-required', 'auth-pending');
        document.body.classList.add('authenticated');
        const gate = document.getElementById('auth-gate');
        if (gate) gate.setAttribute('aria-hidden', 'true');
        setSidebarUser(user);
        setError('');
        setAutoStatus('');
    }

    function clearSession() {
        remove(TOKEN_KEY);
        remove(USER_KEY);
        window.clearTimeout(refreshTimer);
        currentUser = null;
        setSidebarUser(null);
    }

    function applyAuthPayload(payload) {
        const user = {
            ...(payload.user || {}),
            household: payload.household || null,
            households: Array.isArray(payload.households) ? payload.households : [],
        };
        currentUser = user;
        try {
            if (user.household?.id) localStorage.setItem(HOUSEHOLD_KEY, user.household.id);
        } catch (_) { /* noop */ }
        write(USER_KEY, JSON.stringify(user));
        if (user.email) write(LAST_LOGIN_KEY, JSON.stringify({ email: user.email, at: Date.now() }));
        return user;
    }

    async function validateToken(token, householdId = getHouseholdId()) {
        const headers = { Authorization: `Bearer ${token}` };
        if (householdId) headers['X-Household-ID'] = householdId;
        const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, { headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.authenticated || !payload.user) {
            const error = new Error(normalizeDetail(payload.detail, 'このGoogleアカウントではログインできません。'));
            error.status = response.status;
            throw error;
        }
        return applyAuthPayload(payload);
    }

    // 期限の5分前に、画面を止めずに新しいトークンを受け取る。
    function scheduleRefresh(token) {
        window.clearTimeout(refreshTimer);
        const wait = tokenExpiresAt(token) - Date.now() - REFRESH_BEFORE_MS;
        refreshTimer = window.setTimeout(silentRefresh, Math.max(10000, wait));
    }

    async function silentRefresh() {
        if (!enabled || !currentUser) return;
        try {
            const googleIdentity = await waitForGoogleIdentity();
            initializeGoogle(googleIdentity);
            googleIdentity.prompt();
        } catch (error) {
            console.warn('ログインの自動更新を開始できませんでした。', error);
        }
    }

    async function handleCredentialResponse(response) {
        const token = String(response?.credential || '');
        window.clearTimeout(autoSignInTimer);
        autoSignInActive = false;
        if (!token) {
            setAutoStatus('');
            showGate('Googleから認証情報を受け取れませんでした。');
            return;
        }
        const previousSubject = currentUser?.subject || '';
        if (!document.body.classList.contains('authenticated')) setError('ログインと利用権限を確認しています…');
        try {
            const user = await validateToken(token);
            write(TOKEN_KEY, token);
            scheduleRefresh(token);
            const refreshedSameUser = previousSubject && previousSubject === user.subject && document.body.classList.contains('authenticated');
            hideGate(user);
            // 裏での更新なら画面はそのまま。初回ログインやアカウント変更のときだけ読み込み直す。
            if (!refreshedSameUser) window.dispatchEvent(new CustomEvent('kakeibo:authenticated', { detail: user }));
        } catch (error) {
            clearSession();
            setAutoStatus('');
            showGate(error instanceof Error ? error.message : 'ログインを確認できませんでした。');
        }
    }

    function waitForGoogleIdentity() {
        return new Promise((resolve, reject) => {
            if (window.google?.accounts?.id) {
                resolve(window.google.accounts.id);
                return;
            }
            let attempts = 0;
            const timer = window.setInterval(() => {
                attempts += 1;
                if (window.google?.accounts?.id) {
                    window.clearInterval(timer);
                    resolve(window.google.accounts.id);
                } else if (attempts >= 100) {
                    window.clearInterval(timer);
                    reject(new Error('Googleログインを読み込めませんでした。通信状態をご確認ください。'));
                }
            }, 100);
        });
    }

    function initializeGoogle(googleIdentity) {
        if (googleInitialized) return;
        const hint = lastLogin()?.email;
        googleIdentity.initialize({
            client_id: clientId,
            callback: handleCredentialResponse,
            // 前回と同じアカウントなら、確認なしでそのまま通過させる。
            auto_select: true,
            cancel_on_tap_outside: false,
            use_fedcm_for_prompt: true,
            itp_support: true,
            context: 'signin',
            ...(hint ? { login_hint: hint } : {}),
        });
        googleInitialized = true;
    }

    function googleButtonWidth(container) {
        const visualWidth = Math.floor(
            window.visualViewport?.width
            || document.documentElement.clientWidth
            || window.innerWidth
            || 320
        );
        const containerWidth = Math.floor(
            container.getBoundingClientRect().width
            || container.clientWidth
            || visualWidth - 40
        );
        return Math.min(320, Math.max(200, Math.min(containerWidth, visualWidth - 40)));
    }

    async function renderGoogleButton() {
        if (!enabled || googleButtonRendered) return;
        const container = document.getElementById('google-signin-button');
        if (!container) return;
        try {
            const googleIdentity = await waitForGoogleIdentity();
            initializeGoogle(googleIdentity);
            // 幅を測る前にレイアウトを待つ。描画が止まっている環境でも固まらないよう短い時間で打ち切る。
            await Promise.race([
                new Promise(resolve => window.requestAnimationFrame(resolve)),
                new Promise(resolve => window.setTimeout(resolve, 150))
            ]);
            googleIdentity.renderButton(container, {
                type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with',
                width: googleButtonWidth(container),
                locale: 'ja',
            });
            googleButtonRendered = true;
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Googleログインを読み込めませんでした。');
        }
    }

    // 端末のGoogleアカウントで自動ログインを試す。前回ログインした人は確認なしで通過し、
    // 初めての人や確認が必要な場合は「○○として続行」の1タップ表示か、ボタンでのログインになる。
    async function tryAutoSignIn() {
        if (!enabled || autoSignInActive) return;
        autoSignInActive = true;
        const previous = lastLogin();
        if (previous) setAutoStatus(`${previous.email} でログインしています…`);
        window.clearTimeout(autoSignInTimer);
        autoSignInTimer = window.setTimeout(() => {
            autoSignInActive = false;
            setAutoStatus('');
        }, AUTO_SIGN_IN_WAIT_MS);
        try {
            const googleIdentity = await waitForGoogleIdentity();
            initializeGoogle(googleIdentity);
            googleIdentity.prompt(notification => {
                const skipped = notification?.isNotDisplayed?.() || notification?.isSkippedMoment?.() || notification?.isDismissedMoment?.();
                if (skipped && !document.body.classList.contains('authenticated')) {
                    window.clearTimeout(autoSignInTimer);
                    autoSignInActive = false;
                    setAutoStatus('');
                }
            });
        } catch (error) {
            window.clearTimeout(autoSignInTimer);
            autoSignInActive = false;
            setAutoStatus('');
            setError(error instanceof Error ? error.message : 'Googleログインを読み込めませんでした。');
        }
    }

    async function selectHousehold(householdId) {
        const token = getToken();
        if (!token) throw new Error('もう一度ログインしてください。');
        const user = await validateToken(token, String(householdId || ''));
        hideGate(user);
        window.dispatchEvent(new CustomEvent('kakeibo:household-changed', { detail: user }));
        return user;
    }

    // アプリに戻ってきたとき、期限が近ければ先に更新しておく。
    function refreshIfNeeded() {
        if (!enabled || document.hidden || !currentUser) return;
        const token = read(TOKEN_KEY);
        if (!token || tokenExpiresAt(token) - Date.now() < REFRESH_BEFORE_MS) silentRefresh();
    }

    async function initialize() {
        initializeAuthViewport();
        document.getElementById('btn-sign-out')?.addEventListener('click', () => {
            clearSession();
            remove(LAST_LOGIN_KEY);
            // ログアウトした直後に自動でまたログインしないようにする。
            window.google?.accounts?.id?.disableAutoSelect();
            window.dispatchEvent(new CustomEvent('kakeibo:signed-out'));
            showGate('ログアウトしました。');
        });
        document.addEventListener('visibilitychange', refreshIfNeeded);
        window.addEventListener('focus', refreshIfNeeded);
        if (!enabled) {
            document.body.classList.remove('auth-pending', 'auth-required');
            setSidebarUser(null);
            return;
        }
        const token = getToken();
        if (!token) {
            showGate();
            tryAutoSignIn();
            return;
        }
        try {
            const user = await validateToken(token);
            scheduleRefresh(token);
            hideGate(user);
            window.dispatchEvent(new CustomEvent('kakeibo:authenticated', { detail: user }));
        } catch (error) {
            if (!error?.status) {
                // 電波が弱いだけならログイン状態は消さず、開き直したときにそのまま使う。
                showGate('通信できませんでした。電波の良い場所でもう一度開いてください。');
                return;
            }
            clearSession();
            showGate(error.status === 401 ? '' : (error instanceof Error ? error.message : 'ログインの有効期限が切れました。'));
            if (error.status === 401) tryAutoSignIn();
        }
    }

    window.KakeiboAuth = {
        enabled,
        getToken,
        getUser: () => currentUser,
        getHouseholdId,
        selectHousehold,
        getAuthorizationHeaders() {
            const token = getToken();
            if (!token) return {};
            const headers = { Authorization: `Bearer ${token}` };
            const householdId = getHouseholdId();
            if (householdId) headers['X-Household-ID'] = householdId;
            return headers;
        },
        handleUnauthorized(message = 'ログインの有効期限が切れました。もう一度ログインしてください。') {
            const expired = !getToken();
            clearSession();
            // 期限切れなら、まず自動ログインで静かに戻す。権限がない場合は理由を表示する。
            showGate(expired ? '' : normalizeDetail(message, 'このGoogleアカウントでは利用できません。'));
            if (expired) tryAutoSignIn();
        }
    };

    document.addEventListener('DOMContentLoaded', initialize);
})();
