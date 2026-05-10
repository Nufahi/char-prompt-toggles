const MODULE_NAME = 'char-prompt-toggles';
const STORAGE_KEY = 'char_prompt_toggles_data';

const PM_CONTAINER_ID = 'completion_prompt_manager';
const PM_LIST_ID = 'completion_prompt_manager_list';
const TOOLBAR_ID = 'cpt_pm_toolbar';
const SEARCH_INPUT_ID = 'cpt_pm_search';
const SEARCH_CLEAR_ID = 'cpt_pm_search_clear';

let searchQuery = '';
let lastCharId = null;
let pmObserver = null;
let cachedPromptManager = null;
let openaiModulePromise = null;

// Guard against double-clicks on async actions
let actionInProgress = false;

/* ============================================================
   CORE HELPERS
   ============================================================ */

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

function getTranslator() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.translate === 'function') return ctx.translate;
        if (typeof ctx?.t === 'function') return ctx.t;
    } catch (e) {}
    return (s) => s;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function debounce(fn, ms) {
    let timer = null;
    return function() {
        const a = arguments, c = this;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(c, a), ms);
    };
}

/* ============================================================
   PER-CHARACTER SAVE / RESTORE
   ============================================================ */

function isReservedKey(key) {
    return typeof key === 'string' && key.startsWith('_');
}

function doSave() {
    const charId = getCurrentCharId();
    if (!charId || isReservedKey(charId)) {
        updateStatus('No active character');
        return;
    }
    const toggles = readTogglesFromDOM();
    const count = Object.keys(toggles).length;
    if (count === 0) {
        updateStatus('Toggles not found — open Prompt Manager');
        return;
    }
    const data = loadStorage();
    data[charId] = toggles;
    saveStorage(data);
    updateStatus(getCharName() + ': saved ' + count + ' toggles');
}

function tryRestore(charId, attempt, maxAttempts) {
    attempt = attempt || 1;
    maxAttempts = maxAttempts || 8;
    if (!charId || isReservedKey(charId)) return;
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
    }
}

/* ============================================================
   GLOBAL PROFILES
   ============================================================ */

function getProfiles() {
    const data = loadStorage();
    return data._profiles || {};
}

function saveProfiles(profiles) {
    const data = loadStorage();
    data._profiles = profiles;
    saveStorage(data);
}

function getProfileNames() {
    return Object.keys(getProfiles());
}

function profileSave(name) {
    if (!name) return;
    const toggles = readTogglesFromDOM();
    if (Object.keys(toggles).length === 0) {
        updateStatus('Toggles not found — open Prompt Manager');
        return;
    }
    const profiles = getProfiles();
    profiles[name] = toggles;
    saveProfiles(profiles);
    updateStatus('Profile "' + name + '": saved');
    refreshProfileSelect();
}

function profileApply(name) {
    if (!name) return;
    const profiles = getProfiles();
    if (!profiles[name]) return;
    const applied = applyTogglesToDOM(profiles[name]);
    updateStatus('Profile "' + name + '": applied ' + applied + ' toggles');
}

function profileDelete(name) {
    if (!name) return;
    const profiles = getProfiles();
    delete profiles[name];
    saveProfiles(profiles);
    updateStatus('Profile "' + name + '": deleted');
    refreshProfileSelect();
}

function refreshProfileSelect() {
    const sel = document.getElementById('cpt_profile_select');
    if (!sel) return;
    const names = getProfileNames();
    const prev = sel.value;
    sel.innerHTML = '';
    if (names.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = getTranslator()('No profiles');
        opt.disabled = true;
        opt.selected = true;
        sel.appendChild(opt);
    } else {
        names.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            sel.appendChild(opt);
        });
        if (names.includes(prev)) {
            sel.value = prev;
        }
    }
}

async function promptForName(title, defaultVal) {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE) {
            // Build input via DOM to avoid XSS from defaultVal
            const safeDefault = escapeHtml(defaultVal || '');
            const res = await ctx.callGenericPopup(
                '<input id="cpt_popup_input" class="text_pole" type="text" value="' + safeDefault + '" />',
                ctx.POPUP_TYPE.CONFIRM,
                title || ''
            );
            if (!res) return null;
            const input = document.getElementById('cpt_popup_input');
            return input ? input.value.trim() : null;
        }
    } catch (e) {}
    return (window.prompt(title, defaultVal) || '').trim() || null;
}

/* ============================================================
   CHARACTER PANEL (with profiles UI)
   ============================================================ */

function injectCharPanel() {
    if (document.getElementById('cpt_char_panel')) return;

    const t = getTranslator();

    const panel = document.createElement('div');
    panel.id = 'cpt_char_panel';
    panel.className = 'cpt-char-panel';
    panel.style.cssText = 'margin-bottom:10px;';
    panel.innerHTML =
        '<div class="inline-drawer">' +
            '<div class="inline-drawer-toggle inline-drawer-header">' +
                '<b data-i18n="Prompt Toggles">Prompt Toggles</b>' +
                '<div class="inline-drawer-icon fa-solid fa-circle-chevron-up up interactable"></div>' +
            '</div>' +
            '<div class="inline-drawer-content" style="display:block;">' +
                '<div class="flex-container" style="gap:6px;margin-bottom:8px;">' +
                    '<div id="cpt_char_save" class="menu_button" style="padding:5px 12px;cursor:pointer;font-size:12px;">' +
                        '<span class="fa-solid fa-floppy-disk" style="margin-right:4px;"></span>' +
                        '<span data-i18n="Save for char">Save for char</span>' +
                    '</div>' +
                '</div>' +
                '<div class="cpt-profiles-section">' +
                    '<div class="cpt-profiles-row">' +
                        '<select id="cpt_profile_select" class="text_pole cpt-profile-select"></select>' +
                        '<div id="cpt_profile_apply" class="menu_button cpt-profile-btn" title="' + escapeHtml(t('Apply')) + '">' +
                            '<span class="fa-solid fa-check fa-xs"></span>' +
                        '</div>' +
                        '<div id="cpt_profile_save" class="menu_button cpt-profile-btn" title="' + escapeHtml(t('Overwrite')) + '">' +
                            '<span class="fa-solid fa-floppy-disk fa-xs"></span>' +
                        '</div>' +
                        '<div id="cpt_profile_new" class="menu_button cpt-profile-btn" title="' + escapeHtml(t('New profile')) + '">' +
                            '<span class="fa-solid fa-plus fa-xs"></span>' +
                        '</div>' +
                        '<div id="cpt_profile_delete" class="menu_button cpt-profile-btn caution" title="' + escapeHtml(t('Delete profile')) + '">' +
                            '<span class="fa-solid fa-trash fa-xs"></span>' +
                        '</div>' +
                    '</div>' +
                '</div>' +
                '<small id="cpt_status" style="display:block;margin-top:6px;opacity:0.7;" data-i18n="Ready">Ready</small>' +
            '</div>' +
        '</div>';

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

    document.getElementById('cpt_profile_apply').addEventListener('click', () => {
        const sel = document.getElementById('cpt_profile_select');
        if (sel && sel.value) profileApply(sel.value);
    });

    document.getElementById('cpt_profile_save').addEventListener('click', () => {
        const sel = document.getElementById('cpt_profile_select');
        if (sel && sel.value) profileSave(sel.value);
    });

    document.getElementById('cpt_profile_new').addEventListener('click', async () => {
        const name = await promptForName(getTranslator()('New profile name'));
        if (!name) return;
        profileSave(name);
        const sel = document.getElementById('cpt_profile_select');
        if (sel) sel.value = name;
    });

    document.getElementById('cpt_profile_delete').addEventListener('click', async () => {
        const sel = document.getElementById('cpt_profile_select');
        if (!sel || !sel.value) return;
        const confirmed = await confirmDialog(
            getTranslator()('Delete profile'),
            getTranslator()('Delete profile') + ' "' + escapeHtml(sel.value) + '"?'
        );
        if (confirmed) profileDelete(sel.value);
    });

    refreshProfileSelect();
}

/* ============================================================
   PROMPT MANAGER ENHANCEMENTS: search, delete, duplicate
   ============================================================ */

async function resolvePromptManager() {
    if (cachedPromptManager) return cachedPromptManager;
    if (!openaiModulePromise) {
        openaiModulePromise = import('/scripts/openai.js').catch((e) => {
            console.warn('[' + MODULE_NAME + '] failed to import /scripts/openai.js, trying relative path', e);
            return import('../../../openai.js');
        });
    }
    try {
        const mod = await openaiModulePromise;
        if (mod && mod.promptManager) {
            cachedPromptManager = mod.promptManager;
            return cachedPromptManager;
        }
    } catch (e) {
        console.error('[' + MODULE_NAME + '] cannot import openai.js:', e);
    }
    return null;
}

function getPromptsArray() {
    if (cachedPromptManager?.serviceSettings?.prompts) {
        return cachedPromptManager.serviceSettings.prompts;
    }
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.chatCompletionSettings?.prompts) return ctx.chatCompletionSettings.prompts;
    } catch (e) {}
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
    const clone = nameEl.cloneNode(true);
    clone.querySelectorAll('span, small, i, a').forEach(n => n.remove());
    return (clone.textContent || '').trim();
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
        '  <span id="' + SEARCH_CLEAR_ID + '" class="fa-solid fa-xmark cpt-pm-search-clear" title=""></span>' +
        '</div>';

    list.parentElement.insertBefore(toolbar, list);

    const input = toolbar.querySelector('#' + SEARCH_INPUT_ID);
    const clear = toolbar.querySelector('#' + SEARCH_CLEAR_ID);
    input.placeholder = t('Search prompts by name...');
    clear.title = t('Clear');
    if (searchQuery) input.value = searchQuery;

    input.addEventListener('input', () => { searchQuery = input.value; applySearchFilter(); });
    clear.addEventListener('click', () => { input.value = ''; searchQuery = ''; applySearchFilter(); input.focus(); });
    return true;
}

function applySearchFilter() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const q = (searchQuery || '').trim().toLowerCase();
    list.querySelectorAll('li[data-pm-identifier]').forEach(li => {
        if (!q) { li.style.display = ''; return; }
        const id = li.dataset.pmIdentifier;
        const p = getPromptById(id);
        const name = ((p && typeof p.name === 'string') ? p.name : getPromptNameFromDOM(li)).toLowerCase();
        li.style.display = name.includes(q) ? '' : 'none';
    });
}

function getUuid() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.uuidv4 === 'function') return ctx.uuidv4();
    } catch (e) {}
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return 'cpt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

async function confirmDialog(title, message) {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.Popup?.show?.confirm) return !!(await ctx.Popup.show.confirm(title, message));
        if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE) return !!(await ctx.callGenericPopup(message, ctx.POPUP_TYPE.CONFIRM));
    } catch (e) {}
    return window.confirm(message);
}

async function duplicatePrompt(identifier) {
    if (actionInProgress) return;
    actionInProgress = true;
    try {
        const pm = await resolvePromptManager();
        const src = getPromptById(identifier);
        if (!pm || !src) { console.error('[' + MODULE_NAME + '] duplicate: not found'); return; }

        const newId = getUuid();
        const copy = JSON.parse(JSON.stringify(src));
        copy.identifier = newId;
        copy.system_prompt = false;
        copy.marker = false;

        if (typeof pm.addPrompt === 'function') { pm.addPrompt(copy, newId); }
        else if (Array.isArray(pm.serviceSettings?.prompts)) { pm.serviceSettings.prompts.push(copy); }

        if (pm.activeCharacter && typeof pm.getPromptOrderForCharacter === 'function') {
            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
            if (Array.isArray(order)) {
                const srcIdx = order.findIndex(e => e && e.identifier === identifier);
                const srcEntry = srcIdx !== -1 ? order[srcIdx] : null;
                const newEntry = { identifier: newId, enabled: srcEntry ? !!srcEntry.enabled : false };
                if (srcIdx !== -1) { order.splice(srcIdx + 1, 0, newEntry); }
                else { order.push(newEntry); }
            } else if (typeof pm.appendPrompt === 'function') { pm.appendPrompt(copy, pm.activeCharacter); }
        } else if (typeof pm.appendPrompt === 'function' && pm.activeCharacter) { pm.appendPrompt(copy, pm.activeCharacter); }

        if (typeof pm.saveServiceSettings === 'function') await pm.saveServiceSettings();
        if (typeof pm.render === 'function') pm.render();
    } catch (e) {
        console.error('[' + MODULE_NAME + '] duplicate failed:', e);
    } finally {
        actionInProgress = false;
    }
}

async function deletePromptById(identifier) {
    if (actionInProgress) return;
    actionInProgress = true;
    try {
        const pm = await resolvePromptManager();
        const src = getPromptById(identifier);
        if (!pm || !src) { console.error('[' + MODULE_NAME + '] delete: not found'); return; }
        if (src.system_prompt) return;
        const t = getTranslator();
        if (!(await confirmDialog(t('Delete prompt'), t('Delete prompt') + ' "' + escapeHtml(src.name || identifier) + '"?'))) return;

        if (typeof pm.detachPrompt === 'function' && pm.activeCharacter) { try { pm.detachPrompt(src, pm.activeCharacter); } catch (e) {} }
        if (Array.isArray(pm.serviceSettings?.prompts)) {
            const idx = pm.serviceSettings.prompts.findIndex(p => p.identifier === identifier);
            if (idx !== -1) pm.serviceSettings.prompts.splice(idx, 1);
        }
        if (typeof pm.saveServiceSettings === 'function') await pm.saveServiceSettings();
        if (typeof pm.render === 'function') pm.render();
    } catch (e) {
        console.error('[' + MODULE_NAME + '] delete failed:', e);
    } finally {
        actionInProgress = false;
    }
}

function injectRowActions() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const t = getTranslator();
    list.querySelectorAll('li.completion_prompt_manager_prompt[data-pm-identifier]').forEach(li => {
        if (li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-thumb-tack')) return;
        if (li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-star')) return;
        const isUser = !!li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-asterisk');
        const isInjection = !!li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-syringe');
        const isSystem = !!li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-square-poll-horizontal');
        if (!isUser && !isInjection && !isSystem) return;
        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls || controls.querySelector('.cpt-row-actions')) return;
        const wrap = document.createElement('span');
        wrap.className = 'cpt-row-actions';
        const dup = document.createElement('span');
        dup.className = 'cpt-row-action cpt-row-duplicate fa-solid fa-copy fa-xs';
        dup.title = t('Duplicate');
        wrap.appendChild(dup);
        if (!isSystem) {
            const del = document.createElement('span');
            del.className = 'cpt-row-action cpt-row-delete fa-solid fa-trash fa-xs caution';
            del.title = t('Delete');
            wrap.appendChild(del);
        }
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

const debouncedReinject = debounce(() => {
    if (pmObserver) pmObserver.disconnect();
    try { injectPMEnhancements(); } finally { attachPMObserver(); }
}, 300);

function attachPMObserver() {
    const container = document.getElementById(PM_CONTAINER_ID);
    if (!container) {
        if (!pmObserver) {
            pmObserver = new MutationObserver(() => {
                if (document.getElementById(PM_CONTAINER_ID)) { pmObserver.disconnect(); pmObserver = null; attachPMObserver(); debouncedReinject(); }
            });
            pmObserver.observe(document.body, { childList: true, subtree: true });
        }
        return;
    }
    pmObserver = new MutationObserver(debouncedReinject);
    pmObserver.observe(container, { childList: true, subtree: true });
    injectPMEnhancements();
}

function setupDelegatedHandlers() {
    document.addEventListener('click', (ev) => {
        const target = ev.target;
        if (!(target instanceof Element)) return;
        const dup = target.closest('.cpt-row-duplicate');
        if (dup) { ev.preventDefault(); ev.stopPropagation(); const li = dup.closest('li[data-pm-identifier]'); if (li) duplicatePrompt(li.dataset.pmIdentifier); return; }
        const del = target.closest('.cpt-row-delete');
        if (del) { ev.preventDefault(); ev.stopPropagation(); const li = del.closest('li[data-pm-identifier]'); if (li) deletePromptById(li.dataset.pmIdentifier); return; }
    }, true);
}

/* ============================================================
   STYLES
   ============================================================ */

function injectStyles() {
    if (document.getElementById('cpt-styles')) return;
    const style = document.createElement('style');
    style.id = 'cpt-styles';
    style.textContent = `
        #${TOOLBAR_ID}.cpt-pm-toolbar {
            display: flex; gap: 6px; align-items: center;
            margin: 6px 0 8px 0; flex-wrap: wrap;
        }
        .cpt-pm-search-wrap {
            position: relative; flex: 1 1 auto; min-width: 0;
            display: flex; align-items: center;
        }
        .cpt-pm-search-icon {
            position: absolute; left: 8px; opacity: 0.6;
            pointer-events: none; font-size: 0.9em;
        }
        .cpt-pm-search-input {
            width: 100%;
            padding-left: 26px !important; padding-right: 26px !important;
            box-sizing: border-box;
        }
        .cpt-pm-search-clear {
            position: absolute; right: 8px; opacity: 0.6;
            cursor: pointer; font-size: 0.9em; padding: 2px;
        }
        .cpt-pm-search-clear:hover { opacity: 1; }

        .cpt-row-actions { display: inline-flex; gap: 6px; align-items: center; margin-right: 4px; vertical-align: middle; }
        .cpt-row-action { cursor: pointer; opacity: 0.65; }
        .cpt-row-action:hover { opacity: 1; }

        .cpt-profiles-section { margin-bottom: 4px; }
        .cpt-profiles-row {
            display: flex; gap: 4px; align-items: center; flex-wrap: nowrap;
        }
        .cpt-profile-select {
            flex: 1 1 auto; min-width: 0;
            font-size: 12px; padding: 3px 6px;
        }
        .cpt-profile-btn {
            flex: 0 0 auto; padding: 4px 8px; cursor: pointer; font-size: 12px;
        }

        @media (max-width: 600px) {
            #${TOOLBAR_ID}.cpt-pm-toolbar { gap: 4px; }
            .cpt-row-actions { gap: 8px; margin-right: 6px; }
            .cpt-row-action { padding: 3px 4px; font-size: 1.05em; }
            .cpt-profiles-row { flex-wrap: wrap; }
            .cpt-profile-select { flex: 1 1 100%; }
            .cpt-profile-btn { padding: 6px 10px; font-size: 13px; }
        }
    `;
    document.head.appendChild(style);
}

/* ============================================================
   INIT
   ============================================================ */

// Debounced version for the char panel observer — avoids calling injectCharPanel
// on every single DOM mutation
const debouncedInjectCharPanel = debounce(() => { injectCharPanel(); }, 500);

jQuery(async () => {
    console.log('[' + MODULE_NAME + '] Loading...');
    try {
        injectStyles();
        resolvePromptManager().then(pm => {
            if (pm) console.log('[' + MODULE_NAME + '] promptManager resolved');
            else console.warn('[' + MODULE_NAME + '] promptManager not resolved');
        });

        const charPanelObserver = new MutationObserver(debouncedInjectCharPanel);
        charPanelObserver.observe(document.body, { childList: true, subtree: true });
        injectCharPanel();

        setupDelegatedHandlers();
        attachPMObserver();

        const { eventSource, event_types } = SillyTavern.getContext();

        // Try to restore for the character that's already open when extension loads
        const initialCharId = getCurrentCharId();
        if (initialCharId) {
            lastCharId = initialCharId;
            setTimeout(() => tryRestore(initialCharId), 2000);
        }

        eventSource.on(event_types.CHAT_CHANGED, () => {
            const old = document.getElementById('cpt_char_panel');
            if (old) old.remove();
            const newCharId = getCurrentCharId();
            const shouldRestore = (lastCharId !== null && newCharId !== null && newCharId !== lastCharId);
            if (newCharId !== null) lastCharId = newCharId;
            console.log('[' + MODULE_NAME + '] CHAT_CHANGED -> restore=' + shouldRestore + ', char=' + newCharId);
            setTimeout(() => {
                injectCharPanel();
                debouncedReinject();
                if (shouldRestore) tryRestore(newCharId);
            }, 1500);
        });

        console.log('[' + MODULE_NAME + '] Loaded successfully');
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to load:', error);
    }
});
