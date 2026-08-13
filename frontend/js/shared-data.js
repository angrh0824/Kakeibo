(() => {
    'use strict';

    function getBaseUrl() {
        const configured = String(window.KAKEIBO_API_BASE_URL || '').trim();
        const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
        const isHttpOrigin = /^https?:$/.test(window.location.protocol);
        const fallback = isHttpOrigin && !isLocalHost ? window.location.origin : 'http://localhost:8000';
        return String(configured || fallback).replace(/\/+$/, '');
    }

    function detailMessage(detail, fallback) {
        if (typeof detail === 'string' && detail) return detail;
        if (detail && typeof detail === 'object' && detail.message) return String(detail.message);
        return fallback;
    }

    function makeUrl(path) {
        const normalized = String(path || '').startsWith('/') ? path : `/${path}`;
        return `${getBaseUrl()}/api${normalized}`;
    }

    async function request(path, options = {}) {
        const headers = new Headers(options.headers || {});
        const authHeaders = window.KakeiboAuth?.getAuthorizationHeaders?.() || {};
        Object.entries(authHeaders).forEach(([name, value]) => headers.set(name, value));

        if (window.KakeiboAuth?.enabled && !headers.has('Authorization')) {
            window.KakeiboAuth.handleUnauthorized();
            throw new Error('Googleログインが必要です。');
        }
        if (options.body && !(options.body instanceof FormData) && !(options.body instanceof Blob) && !headers.has('Content-Type')) {
            headers.set('Content-Type', 'application/json');
        }

        const response = await fetch(makeUrl(path), { ...options, headers });
        if (response.status === 401 || response.status === 403) {
            const payload = await response.clone().json().catch(() => ({}));
            window.KakeiboAuth?.handleUnauthorized?.(detailMessage(payload.detail, 'このGoogleアカウントでは利用できません。'));
        }
        return response;
    }

    async function requestJson(path, options = {}) {
        const response = await request(path, options);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(detailMessage(payload.detail, `共有データAPIエラー (${response.status})`));
        }
        return payload;
    }

    window.KakeiboShared = { getBaseUrl, makeUrl, request, requestJson };
})();
