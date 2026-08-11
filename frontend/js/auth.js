(() => {
    'use strict';

    const TOKEN_KEY = 'kakeibo.googleIdToken.v1';
    const USER_KEY = 'kakeibo.googleUser.v1';
    const clientId = String(window.KAKEIBO_GOOGLE_CLIENT_ID || '').trim();
    const enabled = clientId.length > 0;
    let googleButtonRendered = false;

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

    function getToken() {
        const token = sessionStorage.getItem(TOKEN_KEY) || '';
        const payload = token ? decodePayload(token) : null;
        if (!payload || !payload.exp || payload.exp * 1000 <= Date.now() + 30000) {
            sessionStorage.removeItem(TOKEN_KEY);
            sessionStorage.removeItem(USER_KEY);
            return '';
        }
        return token;
    }

    function setSidebarUser(user) {
        const name = document.getElementById('signed-in-user-name');
        const email = document.getElementById('signed-in-user-email');
        const avatar = document.getElementById('signed-in-user-avatar');
        const signOut = document.getElementById('btn-sign-out');
        if (name) name.textContent = user?.name || '家族ユーザー';
        if (email) email.textContent = user?.email || '';
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

    function showGate(message = '') {
        document.body.classList.add('auth-required');
        document.body.classList.remove('authenticated', 'auth-pending');
        const gate = document.getElementById('auth-gate');
        if (gate) gate.setAttribute('aria-hidden', 'false');
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
    }

    function clearSession() {
        sessionStorage.removeItem(TOKEN_KEY);
        sessionStorage.removeItem(USER_KEY);
        setSidebarUser(null);
    }

    async function validateToken(token) {
        const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.authenticated || !payload.user) {
            throw new Error(payload.detail || 'このGoogleアカウントではログインできません。');
        }
        return payload.user;
    }

    async function handleCredentialResponse(response) {
        const token = String(response?.credential || '');
        if (!token) {
            showGate('Googleから認証情報を受け取れませんでした。');
            return;
        }
        setError('ログインを確認しています…');
        try {
            const user = await validateToken(token);
            sessionStorage.setItem(TOKEN_KEY, token);
            sessionStorage.setItem(USER_KEY, JSON.stringify(user));
            hideGate(user);
            window.dispatchEvent(new CustomEvent('kakeibo:authenticated', { detail: user }));
        } catch (error) {
            clearSession();
            showGate(error instanceof Error ? error.message : 'ログインを確認できませんでした。');
        }
    }

    function waitForGoogleIdentity() {
        return new Promise((resolve, reject) => {
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

    async function renderGoogleButton() {
        if (!enabled || googleButtonRendered) return;
        const container = document.getElementById('google-signin-button');
        if (!container) return;
        try {
            const googleIdentity = await waitForGoogleIdentity();
            googleIdentity.initialize({
                client_id: clientId,
                callback: handleCredentialResponse,
                auto_select: false,
                cancel_on_tap_outside: false,
            });
            googleIdentity.renderButton(container, {
                type: 'standard',
                theme: 'filled_black',
                size: 'large',
                shape: 'pill',
                text: 'signin_with',
                width: Math.min(320, Math.max(240, container.clientWidth || 280)),
                locale: 'ja',
            });
            googleButtonRendered = true;
        } catch (error) {
            setError(error instanceof Error ? error.message : 'Googleログインを読み込めませんでした。');
        }
    }

    async function initialize() {
        const signOut = document.getElementById('btn-sign-out');
        signOut?.addEventListener('click', () => {
            clearSession();
            window.google?.accounts?.id?.disableAutoSelect();
            window.dispatchEvent(new CustomEvent('kakeibo:signed-out'));
            showGate('ログアウトしました。');
        });

        if (!enabled) {
            document.body.classList.remove('auth-pending', 'auth-required');
            setSidebarUser(null);
            return;
        }

        const token = getToken();
        if (!token) {
            showGate();
            return;
        }

        try {
            const user = await validateToken(token);
            hideGate(user);
            window.dispatchEvent(new CustomEvent('kakeibo:authenticated', { detail: user }));
        } catch (_) {
            clearSession();
            showGate('ログインの有効期限が切れました。もう一度ログインしてください。');
        }
    }

    window.KakeiboAuth = {
        enabled,
        getToken,
        getAuthorizationHeaders() {
            const token = getToken();
            return token ? { Authorization: `Bearer ${token}` } : {};
        },
        handleUnauthorized(message = 'ログインの有効期限が切れました。もう一度ログインしてください。') {
            clearSession();
            showGate(message);
        }
    };

    document.addEventListener('DOMContentLoaded', initialize);
})();