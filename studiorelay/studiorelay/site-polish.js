(function () {
    'use strict';

    const SESSION_BADGE_ID = 'channa-tab-session-badge';
    const SESSION_BADGE_POS_KEY = 'dragonbmt-badge-pos';
    const SESSION_BADGE_TEXT = 'DragonBMT';
    const MODE_LABEL_TEXT = '30s · DragonBMT';
    const LEGACY_MODE_PATTERN = /^\s*(\d+)\s*s\s*\(\s*bypassed\s*\)\s*$/i;
    const ACTIVE_MODE_PATTERN = /^\s*(\d+)\s*s\s*(?:\(\s*kartar\s+mode\s*\)|·\s*DragonBMT|\(\s*DragonBMT\s*\))\s*$/i;
    const INLINE_LEGACY_MODE_PATTERN = /(\d+)\s*s\s*\(\s*(?:bypassed|kartar\s+mode)\s*\)/gi;
    const RELEVANT_MODE_TEXT = /bypassed|kartar\s+mode|dragonbmt/i;
    const DOWNLOAD_LABEL_TEXT = 'Fetch & Download done';
    const LEGACY_DOWNLOAD_PATTERN = /^\s*(?:.{0,6}\s*)?fetch\s*\d+\s*s\s*hd\s*video\s*$/iu;
    const ACTIVE_DOWNLOAD_PATTERN = /^\s*fetch\s*&\s*download\s*done\s*$/i;
    const COMPLETED_DOWNLOAD_PATTERN = /^\s*(?:✓|✅)?\s*downloaded!?\s*$/iu;
    const RELEVANT_DOWNLOAD_TEXT = /fetch|downloaded/i;

    function clampBadgePos(x, y, badge) {
        const width = badge.offsetWidth || 180;
        const height = badge.offsetHeight || 52;
        return {
            x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - width - 8)),
            y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height - 8)),
        };
    }

    function applyBadgePos(badge, x, y) {
        const next = clampBadgePos(x, y, badge);
        badge.style.setProperty('--dragonbmt-left', `${Math.round(next.x)}px`);
        badge.style.setProperty('--dragonbmt-top', `${Math.round(next.y)}px`);
        badge.classList.add('is-moved');
        return next;
    }

    function enableBadgeDrag(badge) {
        if (badge.dataset.dragonbmtDrag === '1') return;
        badge.dataset.dragonbmtDrag = '1';

        try {
            const saved = JSON.parse(localStorage.getItem(SESSION_BADGE_POS_KEY) || '');
            if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
                requestAnimationFrame(() => applyBadgePos(badge, saved.x, saved.y));
            }
        } catch {
            // ignore
        }

        let drag = null;
        badge.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            if (event.target.closest('button, a, input, select, textarea')) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = badge.getBoundingClientRect();
            drag = {
                pointerId: event.pointerId,
                dx: event.clientX - rect.left,
                dy: event.clientY - rect.top,
            };
            badge.classList.add('is-dragging');
            try {
                badge.setPointerCapture(event.pointerId);
            } catch {
                // ignore
            }
        });
        badge.addEventListener('pointermove', (event) => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            applyBadgePos(badge, event.clientX - drag.dx, event.clientY - drag.dy);
        });
        const endDrag = (event) => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            drag = null;
            badge.classList.remove('is-dragging');
            const rect = badge.getBoundingClientRect();
            try {
                localStorage.setItem(SESSION_BADGE_POS_KEY, JSON.stringify({ x: rect.left, y: rect.top }));
            } catch {
                // ignore
            }
        };
        badge.addEventListener('pointerup', endDrag);
        badge.addEventListener('pointercancel', endDrag);
    }

    function polishSessionBadge() {
        const badge = document.getElementById(SESSION_BADGE_ID);
        if (!badge) return;
        badge.classList.add('studio-relay-session-badge');
        badge.setAttribute('aria-label', 'DragonBMT — ép 30/60s, tải video không watermark. Kéo để đổi chỗ.');
        badge.setAttribute('title', 'DragonBMT — kéo để di chuyển');
        badge.removeAttribute('role');
        badge.removeAttribute('tabindex');
        const stale = /kartar/i.test(badge.textContent || '') || !badge.querySelector('.dragonbmt-chips');
        if (stale) {
            badge.innerHTML = (
                '<span class="dragonbmt-mark" aria-hidden="true">D</span>' +
                '<span class="dragonbmt-badge-copy">' +
                    '<strong>DragonBMT</strong>' +
                    '<span class="dragonbmt-chips">' +
                        '<em>30 / 60s</em>' +
                        '<em>Không watermark</em>' +
                    '</span>' +
                '</span>'
            );
        }
        enableBadgeDrag(badge);
    }

    function labelForDuration(duration) {
        return `${duration}s · DragonBMT`;
    }

    function findExactModeHost(start, pattern) {
        let current = start;
        for (let depth = 0; current && depth < 6; depth += 1) {
            const match = (current.textContent || '').match(pattern);
            if (match) return { element: current, duration: match[1] };
            current = current.parentElement;
        }
        return null;
    }

    function applyModeLabel(element, duration) {
        if (!(element instanceof Element)) return;
        const next = labelForDuration(duration);
        if (element.textContent.trim() !== next) element.textContent = next;
        element.classList.add('studio-relay-mode-pill');
        element.setAttribute('aria-label', next);
        element.setAttribute('title', next);
    }

    function polishModeTextNode(textNode) {
        if (!(textNode instanceof Text)) return;
        const parent = textNode.parentElement;
        if (!parent || parent.closest('script, style, textarea, input, [contenteditable="true"]')) return;

        const nearbyText = parent.textContent || '';
        if (!RELEVANT_MODE_TEXT.test(textNode.nodeValue || '') && !RELEVANT_MODE_TEXT.test(nearbyText)) return;

        const legacyHost = findExactModeHost(parent, LEGACY_MODE_PATTERN);
        if (legacyHost) {
            applyModeLabel(legacyHost.element, legacyHost.duration);
            return;
        }

        const activeHost = findExactModeHost(parent, ACTIVE_MODE_PATTERN);
        if (activeHost) {
            applyModeLabel(activeHost.element, activeHost.duration);
            return;
        }

        const source = textNode.nodeValue || '';
        let detectedDuration = null;
        const normalized = source.replace(INLINE_LEGACY_MODE_PATTERN, (_, duration) => {
            detectedDuration = duration;
            return labelForDuration(duration);
        });
        if (!detectedDuration) return;

        if (normalized !== source) textNode.nodeValue = normalized;
        const normalizedHost = findExactModeHost(parent, ACTIVE_MODE_PATTERN);
        applyModeLabel(normalizedHost ? normalizedHost.element : parent, detectedDuration);
    }

    function polishModeLabels(root) {
        if (root instanceof Text) {
            polishModeTextNode(root);
            return;
        }
        if (!(root instanceof Element) && root !== document) return;
        if (root instanceof Element && !RELEVANT_MODE_TEXT.test(root.textContent || '')) return;

        const scope = root === document ? document.documentElement : root;
        if (!scope) return;
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        textNodes.forEach(polishModeTextNode);
    }

    function findExactDownloadHost(start, pattern) {
        let current = start;
        for (let depth = 0; current && depth < 6; depth += 1) {
            if (pattern.test(current.textContent || '')) return current;
            current = current.parentElement;
        }
        return null;
    }

    function applyDownloadLabel(element) {
        if (!(element instanceof Element)) return;
        if (element.textContent.trim() !== DOWNLOAD_LABEL_TEXT) {
            element.textContent = DOWNLOAD_LABEL_TEXT;
        }
        element.classList.add('studio-relay-download-status');
        element.setAttribute('aria-label', DOWNLOAD_LABEL_TEXT);
        element.setAttribute('title', DOWNLOAD_LABEL_TEXT);
    }

    function polishDownloadTextNode(textNode) {
        if (!(textNode instanceof Text)) return;
        const parent = textNode.parentElement;
        if (!parent || parent.closest('script, style, textarea, input, [contenteditable="true"]')) return;

        const nearbyText = parent.textContent || '';
        if (!RELEVANT_DOWNLOAD_TEXT.test(textNode.nodeValue || '') && !RELEVANT_DOWNLOAD_TEXT.test(nearbyText)) return;

        const themedHost = parent.closest('.studio-relay-download-status');
        if (themedHost && COMPLETED_DOWNLOAD_PATTERN.test(themedHost.textContent || '')) {
            applyDownloadLabel(themedHost);
            return;
        }

        const legacyHost = findExactDownloadHost(parent, LEGACY_DOWNLOAD_PATTERN);
        if (legacyHost) {
            applyDownloadLabel(legacyHost);
            return;
        }

        const activeHost = findExactDownloadHost(parent, ACTIVE_DOWNLOAD_PATTERN);
        if (activeHost) applyDownloadLabel(activeHost);
    }

    function polishDownloadLabels(root) {
        if (root instanceof Text) {
            polishDownloadTextNode(root);
            return;
        }
        if (!(root instanceof Element) && root !== document) return;
        if (root instanceof Element && !RELEVANT_DOWNLOAD_TEXT.test(root.textContent || '')) return;

        const scope = root === document ? document.documentElement : root;
        if (!scope) return;
        const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        while (walker.nextNode()) textNodes.push(walker.currentNode);
        textNodes.forEach(polishDownloadTextNode);
    }

    function polishPage(root) {
        polishSessionBadge();
        polishModeLabels(root || document);
        polishDownloadLabels(root || document);
        polishPromptDockButtons(root || document);
    }

    function start() {
        polishPage(document);
        if (!document.documentElement) return;

        new MutationObserver((mutations) => {
            polishSessionBadge();
            mutations.forEach((mutation) => {
                if (mutation.type === 'characterData') {
                    polishModeTextNode(mutation.target);
                    polishDownloadTextNode(mutation.target);
                    return;
                }
                mutation.addedNodes.forEach((node) => {
                    polishModeLabels(node);
                    polishDownloadLabels(node);
                    polishPromptDockButtons(node);
                });
            });
        }).observe(document.documentElement, {
            childList: true,
            characterData: true,
            subtree: true
        });
    }

    function triggerFullClick(element) {
        if (!element || !(element instanceof Element)) return false;
        try {
            element.focus();
            const opts = { bubbles: true, cancelable: true, view: window };
            element.dispatchEvent(new PointerEvent('pointerdown', opts));
            element.dispatchEvent(new MouseEvent('mousedown', opts));
            element.dispatchEvent(new PointerEvent('pointerup', opts));
            element.dispatchEvent(new MouseEvent('mouseup', opts));
            element.dispatchEvent(new MouseEvent('click', opts));
            if (typeof element.click === 'function') {
                element.click();
            }
            return true;
        } catch (err) {
            console.error('[StudioRelay] Click error:', err);
            return false;
        }
    }

    function clickCreateVideoButton() {
        console.log('[StudioRelay] Searching for Create Video button on page...');

        const selectors = [
            '#channa-create-btn',
            '.studio-relay-create-btn',
            '#create-video-btn',
            '.create-video-btn',
            '#btn-create-video',
            'button[aria-label*="Create Video" i]',
            'button[title*="Create Video" i]',
            'button[aria-label*="Create video" i]',
            'button[title*="Create video" i]',
            'button[aria-label*="Generate" i]',
            'button[title*="Generate" i]',
            'button[type="submit"]',
            'form button[type="submit"]',
            'form button'
        ];

        for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn && btn.offsetWidth > 0 && btn.offsetHeight > 0) {
                console.log('[StudioRelay] Found button by selector:', sel, btn);
                return triggerFullClick(btn);
            }
        }

        const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], span[role="button"], input[type="button"], input[type="submit"]'));
        for (const candidate of candidates) {
            const txt = (candidate.textContent || candidate.value || '').trim();
            if (/create\s*video|generate\s*video|create|generate|hit\s*create|submit|send/i.test(txt)) {
                console.log('[StudioRelay] Found button by text:', txt, candidate);
                return triggerFullClick(candidate);
            }
        }

        const textareas = document.querySelectorAll('textarea, div[contenteditable="true"], input[type="text"]');
        for (const ta of textareas) {
            const parent = ta.closest('form, div, section');
            if (parent) {
                const btn = parent.querySelector('button, div[role="button"], svg');
                if (btn) {
                    const clickable = btn.closest('button, div[role="button"]') || btn;
                    console.log('[StudioRelay] Found prompt box button:', clickable);
                    return triggerFullClick(clickable);
                }
            }
        }

        console.warn('[StudioRelay] No Create Video button could be resolved automatically.');
        return false;
    }

    /* In-Page Interactive Click Syncing System */
    let isClickSyncArmed = false;
    let syncToastElement = null;
    let clickSyncCaptureHandler = null;

    function showSyncToast(message, duration) {
        if (!syncToastElement) {
            syncToastElement = document.createElement('div');
            syncToastElement.id = 'studio-relay-sync-toast';
            syncToastElement.style.cssText = `
                position: fixed !important;
                top: 16px !important;
                left: 50% !important;
                transform: translateX(-50%) !important;
                z-index: 2147483647 !important;
                padding: 9px 16px !important;
                border: 1px solid rgba(129, 140, 248, 0.45) !important;
                border-radius: 999px !important;
                background: rgba(17, 17, 19, 0.94) !important;
                color: #c7d2fe !important;
                font-family: Inter, ui-sans-serif, sans-serif !important;
                font-size: 11px !important;
                font-weight: 650 !important;
                box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 12px rgba(99, 102, 241, 0.3) !important;
                pointer-events: none !important;
                transition: opacity 200ms ease, transform 200ms ease !important;
            `;
            (document.body || document.documentElement).appendChild(syncToastElement);
        }
        syncToastElement.textContent = message;
        syncToastElement.style.opacity = '1';
        if (duration) {
            setTimeout(() => {
                if (syncToastElement) syncToastElement.style.opacity = '0';
            }, duration);
        }
    }

    function buildUniqueCssPath(el) {
        if (!el || !(el instanceof Element)) return '';
        if (el.id) return `#${CSS.escape(el.id)}`;
        const path = [];
        let current = el;
        while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && current !== document.documentElement) {
            let selector = current.tagName.toLowerCase();
            if (current.className && typeof current.className === 'string') {
                const classes = current.className.split(/\s+/).filter(c => c && !c.startsWith('studio-relay-') && !c.includes(':')).map(c => `.${CSS.escape(c)}`).join('');
                if (classes) selector += classes;
            }
            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
                if (siblings.length > 1) {
                    const index = siblings.indexOf(current) + 1;
                    selector += `:nth-of-type(${index})`;
                }
            }
            path.unshift(selector);
            current = current.parentElement;
            if (path.length >= 5) break;
        }
        return path.join(' > ');
    }

    function handleArmClickSync() {
        if (clickSyncCaptureHandler) {
            window.removeEventListener('click', clickSyncCaptureHandler, true);
            clickSyncCaptureHandler = null;
        }
        isClickSyncArmed = true;
        document.dispatchEvent(new CustomEvent('studio-relay:click-sync-state', {detail: {armed: true}}));
        showSyncToast('🎯 Click Sync Armed! Click ANY button on this page to mirror across ALL open Dola tabs.', 5000);

        const captureClick = (event) => {
            if (!isClickSyncArmed) return;

            if (event.target && event.target.closest && event.target.closest('#studio-relay-sync-toast, #channa-tab-session-badge, #studio-relay-page-overlays')) {
                return;
            }

            isClickSyncArmed = false;
            document.dispatchEvent(new CustomEvent('studio-relay:click-sync-state', {detail: {armed: false}}));
            const targetEl = event.target.closest('button, div[role="button"], a[role="button"], input[type="submit"], input[type="button"], a, svg') || event.target;

            const selector = buildUniqueCssPath(targetEl);
            const text = (targetEl.textContent || targetEl.value || '').trim().slice(0, 100);
            const ariaLabel = targetEl.getAttribute('aria-label') || '';
            const title = targetEl.getAttribute('title') || '';
            const tag = targetEl.tagName ? targetEl.tagName.toLowerCase() : '';
            const xRatio = window.innerWidth > 0 ? event.clientX / window.innerWidth : 0.5;
            const yRatio = window.innerHeight > 0 ? event.clientY / window.innerHeight : 0.5;

            const targetData = { selector, text, ariaLabel, title, tag, xRatio, yRatio };

            console.log('[StudioRelay] Captured target for multi-tab sync:', targetData);

            if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                chrome.runtime.sendMessage({ action: 'broadcast_mirrored_click', targetData }).catch(() => {});
            }

            showSyncToast('⚡ Click Mirrored across ALL Open Dola Tabs!', 2500);

            window.removeEventListener('click', captureClick, true);
            clickSyncCaptureHandler = null;
        };

        clickSyncCaptureHandler = captureClick;
        window.addEventListener('click', captureClick, true);
    }

    document.addEventListener('studio-relay:arm-click-sync', handleArmClickSync);

    function executeMirroredClick(targetData) {
        if (!targetData) return;
        console.log('[StudioRelay] Executing mirrored click:', targetData);

        let targetEl = null;

        if (targetData.selector) {
            try { targetEl = document.querySelector(targetData.selector); } catch (e) {}
        }

        if (!targetEl && targetData.text) {
            const candidates = Array.from(document.querySelectorAll('button, div[role="button"], a[role="button"], input[type="submit"], input[type="button"]'));
            for (const c of candidates) {
                const txt = (c.textContent || c.value || '').trim();
                if (txt && txt.toLowerCase() === targetData.text.toLowerCase()) {
                    targetEl = c;
                    break;
                }
            }
        }

        if (!targetEl && (targetData.ariaLabel || targetData.title)) {
            const attr = targetData.ariaLabel ? `[aria-label="${CSS.escape(targetData.ariaLabel)}"]` : `[title="${CSS.escape(targetData.title)}"]`;
            try { targetEl = document.querySelector(attr); } catch (e) {}
        }

        if (!targetEl && targetData.xRatio !== undefined && targetData.yRatio !== undefined) {
            const x = targetData.xRatio * window.innerWidth;
            const y = targetData.yRatio * window.innerHeight;
            const pointEl = document.elementFromPoint(x, y);
            if (pointEl) {
                targetEl = pointEl.closest('button, div[role="button"], a[role="button"], input, a') || pointEl;
            }
        }

        if (targetEl) {
            triggerFullClick(targetEl);
            showSyncToast('⚡ Click Mirrored from active tab!', 1800);
        } else {
            console.warn('[StudioRelay] Could not resolve mirrored target element');
        }
    }

    function pasteTextIntoDolaInput(text) {
        if (!text) return false;
        const target = document.querySelector('textarea, div[contenteditable="true"], input[type="text"]');
        if (!target) return false;

        try {
            target.focus();
            if (target.tagName.toLowerCase() === 'textarea' || target.tagName.toLowerCase() === 'input') {
                target.value = text;
            } else {
                target.textContent = text;
                target.innerText = text;
            }
            const opts = { bubbles: true, cancelable: true };
            target.dispatchEvent(new Event('input', opts));
            target.dispatchEvent(new Event('change', opts));
            target.dispatchEvent(new KeyboardEvent('keydown', opts));
            target.dispatchEvent(new KeyboardEvent('keyup', opts));
            return true;
        } catch (e) {
            return false;
        }
    }

    function polishPromptDockButtons(root) {
        const scope = (root instanceof Element || root === document) ? root : document;
        const buttons = scope.querySelectorAll('button');
        buttons.forEach((btn) => {
            const txt = (btn.textContent || '').trim();
            if (/next\s*prompt|→\s*next/i.test(txt) && !btn.dataset.pasteAllBound) {
                btn.dataset.pasteAllBound = 'true';
                btn.textContent = '⚡ Paste All Tabs';
                btn.title = 'Paste queued prompts sequentially across ALL open Dola tabs';
                btn.setAttribute('aria-label', 'Paste All Tabs');

                btn.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ action: 'paste_all_tabs_sequentially' }, (res) => {
                            if (res && res.success) {
                                showSyncToast(`⚡ Pasted Prompts across ${res.tabCount} Dola Tab(s)!`, 2500);
                            } else {
                                showSyncToast(res?.reason || '⚡ Pasted across all open tabs!', 2000);
                            }
                        });
                    }
                }, true);
            }
        });
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (!request) return;
            if (request.action === 'hit_create_video') {
                const success = clickCreateVideoButton();
                sendResponse({ success });
                return true;
            } else if (request.action === 'arm_click_sync') {
                handleArmClickSync();
                sendResponse({ success: true });
                return true;
            } else if (request.action === 'execute_mirrored_click') {
                executeMirroredClick(request.targetData);
                sendResponse({ success: true });
                return true;
            } else if (request.action === 'paste_specific_prompt') {
                const success = pasteTextIntoDolaInput(request.text);
                if (success) {
                    showSyncToast(`⚡ Prompt Pasted! (Tab #${request.tabIndex}/${request.totalTabs})`, 2000);
                }
                sendResponse({ success });
                return true;
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
