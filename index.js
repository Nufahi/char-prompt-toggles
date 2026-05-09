const MODULE_NAME = 'char-prompt-toggles';
const STORAGE_KEY = 'char_prompt_toggles_data';

const PM_CONTAINER_ID = 'completion_prompt_manager';
const PM_LIST_ID = 'completion_prompt_manager_list';
const TOOLBAR_ID = 'cpt_pm_toolbar';
const SEARCH_INPUT_ID = 'cpt_pm_search';
const SEARCH_CLEAR_ID = 'cpt_pm_search_clear';

// Persisted across re-renders
let searchQuery = '';

let lastCharId = null;
let pmObserver = null;

function getCurrentCharId() {
    const ctx = SillyTavern.getContext();
    if (ctx.groupId) return 'group_' + ctx.groupId;
    if (ctx.characterId != null) {
        const char = ctx.characters[ctx.characterId];
        return char?.avatar || ('char_' + ctx.characterId);
    }
    return null;
}

function getCharName() {
    const ctx = SillyTavern.getContext();
    if (ctx.characterId != null) return ctx.characters[ctx.characterId]?.name || '?';
    return '?';
}

function loadStorage() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch(e) { return {}; }
}

function saveStorage(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function readTogglesFromDOM() {
    const toggles = {};
    document.querySelectorAll('[data-pm-identifier]').forEach(el => {
        const id = el.dataset.pmIdentifier;
        if (!id) return;
        const toggle = el.querySelector('.fa-toggle-on, .fa-toggle-off');
        if (!toggle) return;
        toggles[id] = toggle.classList.contains('fa-toggle-on');
    });
    return toggles;
}

function applyTogglesToDOM(saved) {
    let applied = 0;
    document.querySelectorAll('[data-pm-identifier]').forEach(el => {
        const id = el.dataset.pmIdentifier;
        if (!id || !(id in saved)) return;
        const toggle = el.querySelector('.fa-toggle-on, .fa-toggle-off');
        if (!toggle) return;
        const isOn = toggle.classList.contains('fa-toggle-on');
        if (isOn !== saved[id]) {
            toggle.click();
            applied++;
        }
    });
    return applied;
}

function updateStatus(text) {
    const el = document.getElementById('cpt_status');
    if (el) el.textContent = text;
}

function doSave() {
    const charId = getCurrentCharId();
    if (!charId) { toastr.error('No active character', MODULE_NAME); return; }
    const toggles = readTogglesFromDOM();
    const count = Object.keys(toggles).length;
    if (count === 0) { toastr.warning('Toggles not found -- open Prompt Manager!', MODULE_NAME); return; }
    const data = loadStorage();
    data[charId] = toggles;
    saveStorage(data);
    updateStatus(getCharName() + ': saved ' + count + ' toggles');
    toastr.success(getCharName() + ': saved ' + count + ' toggles', MODULE_NAME);
}

function tryRestore(charId, attempt, maxAttempts) {
    attempt = attempt || 1;
    maxAttempts = maxAttempts || 8;
    const toggles = readTogglesFromDOM();
    if (Object.keys(toggles).length === 0) {
        if (attempt < maxAttempts) {
            console.log('[' + MODULE_NAME + '] DOM not ready, retry ' + attempt + '/' + maxAttempts);
            setTimeout(function() { tryRestore(charId, attempt + 1, maxAttempts); }, 1000);
        } else {
            console.warn('[' + MODULE_NAME + '] Gave up waiting for toggles');
        }
        return;
    }
    const data = loadStorage();
    if (!data[charId]) return;
    const applied = applyTogglesToDOM(data[charId]);
    if (applied > 0) {
        updateStatus(getCharName() + ': auto-restored ' + applied + ' toggles');
        toastr.info(getCharName() + ': restored ' + applied + ' toggles', MODULE_NAME);
    }
}

function injectCharPanel() {
    if (document.getElementById('cpt_char_panel')) return;

    const panel = document.createElement('div');
    panel.id = 'cpt_char_panel';
    panel.className = 'cpt-char-panel';
    panel.style.cssText = 'margin-bottom:10px;';
    panel.innerHTML = '\
        <div class="inline-drawer">\
            <div class="inline-drawer-toggle inline-drawer-header">\
                <b data-i18n="Prompt Toggles">Prompt Toggles</b>\
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up interactable"></div>\
            </div>\
            <div class="inline-drawer-content" style="display:block;">\
                <div class="flex-container" style="gap:6px;">\
                    <div id="cpt_char_save" class="menu_button" style="padding:5px 12px;cursor:pointer;font-size:12px;">\
                        <span class="fa-solid fa-floppy-disk" style="margin-right:4px;"></span>\
                        <span data-i18n="Save">Save</span>\
                    </div>\
                </div>\
                <small id="cpt_status" style="display:block;margin-top:6px;opacity:0.7;" data-i18n="Ready">Ready</small>\
            </div>\
        </div>\
    ';

    const creatorsDiv = document.getElementById('creators_notes_div');
    if (creatorsDiv) {
        const drawer = creatorsDiv.closest('.inline-drawer');
        if (drawer) {
            drawer.before(panel);
        }
    } else {
        const target = document.getElementById('form_create');
        if (target) target.appendChild(panel);
    }

    document.getElementById('cpt_char_save').addEventListener('click', doSave);
}

/* ============================================================
   PROMPT MANAGER ENHANCEMENTS: search, delete, duplicate
   ============================================================ */

function getPromptManager() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx && ctx.promptManager) return ctx.promptManager;
    } catch (e) {}
    if (typeof window !== 'undefined' && window.promptManager) return window.promptManager;
    return null;
}

function getPromptsArray() {
    const pm = getPromptManager();
    if (pm && pm.serviceSettings && Array.isArray(pm.serviceSettings.prompts)) {
        return pm.serviceSettings.prompts;
    }
    try {
        const ctx = SillyTavern.getContext();
        if (ctx && ctx.oai_settings && Array.isArray(ctx.oai_settings.prompts)) {
            return ctx.oai_settings.prompts;
        }
    } catch (e) {}
    if (window.oai_settings && Array.isArray(window.oai_settings.prompts)) {
        return window.oai_settings.prompts;
    }
    return null;
}

function getPromptById(identifier) {
    const arr = getPromptsArray();
    if (!arr) return null;
    return arr.find(p => p && p.identifier === identifier) || null;
}

function getPromptNameFromDOM(li) {
    if (!li) return '';
    const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
    if (!nameEl) return (li.textContent || '').trim();
    const inspect = nameEl.querySelector('.prompt-manager-inspect-action');
    if (inspect && inspect.textContent) return inspect.textContent.trim();
    const attr = nameEl.getAttribute('data-pm-name');
    if (attr) return attr.trim();
    // Fallback: take only direct text nodes (skip child icon spans)
    const clone = nameEl.cloneNode(true);
    clone.querySelectorAll('span, small, i').forEach(n => n.remove());
    return (clone.textContent || '').trim();
}

function getTranslator() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.translate === 'function') return ctx.translate;
    } catch (e) {}
    return (s) => s;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function injectSearchToolbar() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return false;
    if (document.getElementById(TOOLBAR_ID)) return true;

    const t = getTranslator();

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = 'cpt-pm-toolbar';
    toolbar.innerHTML =
        '<div class="cpt-pm-search-wrap">' +
        '  <span class="fa-solid fa-magnifying-glass cpt-pm-search-icon"></span>' +
        '  <input type="text" id="' + SEARCH_INPUT_ID + '" class="text_pole cpt-pm-search-input" placeholder="" autocomplete="off" />' +
        '  <span id="' + SEARCH_CLEAR_ID + '" class="fa-solid fa-xmark cpt-pm-search-clear interactable" title=""></span>' +
        '</div>';

    list.parentElement.insertBefore(toolbar, list);

    const input = toolbar.querySelector('#' + SEARCH_INPUT_ID);
    const clear = toolbar.querySelector('#' + SEARCH_CLEAR_ID);

    input.placeholder = t('Search prompts by name...');
    clear.title = t('Clear');

    if (searchQuery) input.value = searchQuery;

    input.addEventListener('input', () => {
        searchQuery = input.value;
        applySearchFilter();
    });
    clear.addEventListener('click', () => {
        input.value = '';
        searchQuery = '';
        applySearchFilter();
        input.focus();
    });

    return true;
}

function applySearchFilter() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const q = (searchQuery || '').trim().toLowerCase();

    const items = list.querySelectorAll('li[data-pm-identifier]');
    items.forEach(li => {
        if (!q) {
            li.style.display = '';
            return;
        }
        const id = li.dataset.pmIdentifier;
        const promptName = (() => {
            const p = getPromptById(id);
            return (p && typeof p.name === 'string') ? p.name : '';
        })();
        const name = (promptName || getPromptNameFromDOM(li)).toLowerCase();
        li.style.display = name.includes(q) ? '' : 'none';
    });
}

function getUuid() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.getUuidv4 === 'function') return ctx.getUuidv4();
        if (typeof ctx?.uuidv4 === 'function') return ctx.uuidv4();
    } catch (e) {}
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'cpt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

async function confirmDialog(title, message) {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.Popup?.show?.confirm) {
            const res = await ctx.Popup.show.confirm(title, message);
            return !!res;
        }
        if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE) {
            const res = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM);
            return !!res;
        }
    } catch (e) {}
    return window.confirm(message);
}

async function duplicatePrompt(identifier) {
    const pm = getPromptManager();
    const src = getPromptById(identifier);
    if (!pm || !src) {
        toastr.error('Cannot duplicate: prompt not found', MODULE_NAME);
        return;
    }
    try {
        const newId = getUuid();
        const copy = JSON.parse(JSON.stringify(src));
        copy.identifier = newId;
        copy.system_prompt = false;
        copy.marker = false;

        if (typeof pm.addPrompt === 'function') {
            pm.addPrompt(copy, newId);
        } else if (Array.isArray(pm.serviceSettings?.prompts)) {
            pm.serviceSettings.prompts.push(copy);
        }

        // Append to active character order — places it at the top of the user list
        if (typeof pm.appendPrompt === 'function' && pm.activeCharacter) {
            pm.appendPrompt(copy, pm.activeCharacter);
        }

        if (typeof pm.saveServiceSettings === 'function') {
            await pm.saveServiceSettings();
        }
        if (typeof pm.render === 'function') {
            pm.render();
        }
        toastr.success(getTranslator()('Prompt duplicated'), MODULE_NAME);
    } catch (e) {
        console.error('[' + MODULE_NAME + '] duplicate failed:', e);
        toastr.error('Duplicate failed: ' + e.message, MODULE_NAME);
    }
}

async function deletePromptById(identifier) {
    const pm = getPromptManager();
    const src = getPromptById(identifier);
    if (!pm || !src) {
        toastr.error('Cannot delete: prompt not found', MODULE_NAME);
        return;
    }
    if (src.system_prompt) {
        toastr.warning(getTranslator()('System prompts cannot be deleted'), MODULE_NAME);
        return;
    }
    const t = getTranslator();
    const confirmed = await confirmDialog(t('Delete prompt'), t('Delete prompt') + ' "' + (src.name || identifier) + '"?');
    if (!confirmed) return;

    try {
        if (typeof pm.detachPrompt === 'function' && pm.activeCharacter) {
            try { pm.detachPrompt(src, pm.activeCharacter); } catch (e) {}
        }
        if (Array.isArray(pm.serviceSettings?.prompts)) {
            const idx = pm.serviceSettings.prompts.findIndex(p => p.identifier === identifier);
            if (idx !== -1) pm.serviceSettings.prompts.splice(idx, 1);
        }
        if (typeof pm.saveServiceSettings === 'function') {
            await pm.saveServiceSettings();
        }
        if (typeof pm.render === 'function') {
            pm.render();
        }
        toastr.success(t('Prompt deleted'), MODULE_NAME);
    } catch (e) {
        console.error('[' + MODULE_NAME + '] delete failed:', e);
        toastr.error('Delete failed: ' + e.message, MODULE_NAME);
    }
}

/**
 * Inject Duplicate/Delete buttons into each user prompt row.
 *
 * Filtering by type-icon (fa-asterisk = regular prompt, fa-syringe = injection prompt,
 * fa-square-poll-horizontal = output formatting marker that is still user-editable).
 * Markers like fa-thumb-tack (charDescription/scenario/etc.) and fa-star (system) are skipped.
 * Reference: 酒馆助手脚本 "预设条目更多按钮" by 青空莉.
 */
function injectRowActions() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const t = getTranslator();

    const eligibleSelector = 'li.completion_prompt_manager_prompt:has(.fa-asterisk), ' +
                             'li.completion_prompt_manager_prompt:has(.fa-syringe), ' +
                             'li.completion_prompt_manager_prompt:has(.fa-square-poll-horizontal)';

    let candidates;
    try {
        candidates = list.querySelectorAll(eligibleSelector);
    } catch (e) {
        // :has() not supported — fallback to all non-marker rows
        candidates = list.querySelectorAll('li.completion_prompt_manager_prompt:not(.completion_prompt_manager_marker)');
    }

    candidates.forEach(li => {
        const id = li.dataset.pmIdentifier;
        if (!id) return;
        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls) return;
        if (controls.querySelector('.cpt-row-actions')) return;

        const wrap = document.createElement('span');
        wrap.className = 'cpt-row-actions';

        const dup = document.createElement('span');
        dup.className = 'cpt-row-action cpt-row-duplicate fa-solid fa-copy fa-xs interactable';
        dup.title = t('Duplicate');
        dup.setAttribute('role', 'button');
        dup.setAttribute('tabindex', '0');

        const del = document.createElement('span');
        del.className = 'cpt-row-action cpt-row-delete caution fa-solid fa-trash fa-xs interactable';
        del.title = t('Delete');
        del.setAttribute('role', 'button');
        del.setAttribute('tabindex', '0');

        wrap.appendChild(dup);
        wrap.appendChild(del);
        controls.prepend(wrap);
    });
}

function injectPMEnhancements() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    injectSearchToolbar();
    injectRowActions();
    applySearchFilter();
}

// Debounce — same approach as the Chinese script (500ms)
function debounce(fn, ms) {
    let timer = null;
    return function() {
        const args = arguments;
        const ctx = this;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { fn.apply(ctx, args); }, ms);
    };
}

const debouncedReinject = debounce(() => {
    if (pmObserver) pmObserver.disconnect();
    try {
        injectPMEnhancements();
    } finally {
        attachPMObserver();
    }
}, 300);

function attachPMObserver() {
    const container = document.getElementById(PM_CONTAINER_ID);
    if (!container) {
        // Fall back: watch body until the container appears
        if (!pmObserver) {
            pmObserver = new MutationObserver(() => {
                const c = document.getElementById(PM_CONTAINER_ID);
                if (c) {
                    pmObserver.disconnect();
                    pmObserver = null;
                    attachPMObserver();
                    debouncedReinject();
                }
            });
            pmObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
    }
    pmObserver = new MutationObserver(debouncedReinject);
    pmObserver.observe(container, { childList: true, subtree: true });
    // Run once now
    injectPMEnhancements();
}

// Delegated click handler — survives full innerHTML rebuilds.
function setupDelegatedHandlers() {
    document.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;

        const dup = target.closest('.cpt-row-duplicate');
        if (dup) {
            ev.preventDefault();
            ev.stopPropagation();
            const li = dup.closest('li[data-pm-identifier]');
            if (li) duplicatePrompt(li.dataset.pmIdentifier);
            return;
        }

        const del = target.closest('.cpt-row-delete');
        if (del) {
            ev.preventDefault();
            ev.stopPropagation();
            const li = del.closest('li[data-pm-identifier]');
            if (li) deletePromptById(li.dataset.pmIdentifier);
            return;
        }
    }, true);
}

function injectStyles() {
    if (document.getElementById('cpt-styles')) return;
    const style = document.createElement('style');
    style.id = 'cpt-styles';
    style.textContent = `
        #${TOOLBAR_ID}.cpt-pm-toolbar {
            display: flex;
            gap: 6px;
            align-items: center;
            margin: 6px 0 8px 0;
            flex-wrap: wrap;
        }
        .cpt-pm-search-wrap {
            position: relative;
            flex: 1 1 auto;
            min-width: 0;
            display: flex;
            align-items: center;
        }
        .cpt-pm-search-icon {
            position: absolute;
            left: 8px;
            opacity: 0.6;
            pointer-events: none;
            font-size: 0.9em;
        }
        .cpt-pm-search-input {
            width: 100%;
            padding-left: 26px !important;
            padding-right: 26px !important;
            box-sizing: border-box;
        }
        .cpt-pm-search-clear {
            position: absolute;
            right: 8px;
            opacity: 0.6;
            cursor: pointer;
            font-size: 0.9em;
            padding: 2px;
        }
        .cpt-pm-search-clear:hover { opacity: 1; }

        .cpt-row-actions {
            display: inline-flex;
            gap: 6px;
            align-items: center;
            margin-right: 4px;
            vertical-align: middle;
        }
        .cpt-row-action {
            cursor: pointer;
            opacity: 0.6;
            padding: 2px 4px;
            border-radius: 3px;
        }
        .cpt-row-action:hover { opacity: 1; }
        .cpt-row-delete:hover { color: var(--crimson70a, #c0392b); }

        @media (max-width: 600px) {
            #${TOOLBAR_ID}.cpt-pm-toolbar { gap: 4px; }
            .cpt-row-actions { gap: 8px; margin-right: 6px; }
            .cpt-row-action {
                padding: 5px 6px;
                font-size: 1.05em;
            }
        }
    `;
    document.head.appendChild(style);
}

jQuery(async () => {
    console.log('[' + MODULE_NAME + '] Loading...');

    try {
        injectStyles();

        // Watch for char panel
        const charPanelObserver = new MutationObserver(() => { injectCharPanel(); });
        charPanelObserver.observe(document.body, { childList: true, subtree: true });
        injectCharPanel();

        setupDelegatedHandlers();
        attachPMObserver();

        const { eventSource, event_types } = SillyTavern.getContext();

        eventSource.on(event_types.CHAT_CHANGED, () => {
            const old = document.getElementById('cpt_char_panel');
            if (old) old.remove();

            const newCharId = getCurrentCharId();

            const shouldRestore = (lastCharId !== null && newCharId !== null && newCharId !== lastCharId);

            if (newCharId !== null) {
                lastCharId = newCharId;
            }

            console.log('[' + MODULE_NAME + '] CHAT_CHANGED → restore=' + shouldRestore + ', char=' + newCharId);

            setTimeout(() => {
                injectCharPanel();
                debouncedReinject();
                if (shouldRestore) {
                    tryRestore(newCharId);
                }
            }, 1500);
        });

        console.log('[' + MODULE_NAME + '] Loaded successfully');
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to load:', error);
    }
});
