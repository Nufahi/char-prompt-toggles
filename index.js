const MODULE_NAME = 'char-prompt-toggles';
const STORAGE_KEY = 'char_prompt_toggles_data';
const SETTINGS_KEY = 'char_prompt_toggles_settings';

const PM_CONTAINER_ID = 'completion_prompt_manager';
const PM_LIST_ID = 'completion_prompt_manager_list';
const TOOLBAR_ID = 'cpt_pm_toolbar';
const SEARCH_INPUT_ID = 'cpt_pm_search';
const SEARCH_CLEAR_ID = 'cpt_pm_search_clear';

let searchQuery = '';
let selectedProfile = '';
let lastCharId = null;
let pmObserver = null;
let cachedPromptManager = null;
let openaiModulePromise = null;
let actionInProgress = false;

// Persisted settings (small separate key to avoid bloating the main storage reads)
function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch(e) { return {}; }
}
function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
function getSetting(key, def) {
    const s = loadSettings();
    return key in s ? s[key] : def;
}
function setSetting(key, val) {
    const s = loadSettings();
    s[key] = val;
    saveSettings(s);
}

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

function isReservedKey(key) {
    return typeof key === 'string' && key.startsWith('_');
}

/* ============================================================
   PER-CHARACTER SAVE / RESTORE
   ============================================================ */

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
            setTimeout(function() { tryRestore(charId, attempt + 1, maxAttempts); }, 1000);
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
   GLOBAL PROFILES (stored under _profiles in localStorage)
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

function setSelectedProfile(name) {
    selectedProfile = name;
    setSetting('selectedProfile', name);
}

function profileSave(name) {
    if (!name) return;
    const toggles = readTogglesFromDOM();
    if (Object.keys(toggles).length === 0) {
        toastr.warning('Open Prompt Manager first', MODULE_NAME);
        return;
    }
    const profiles = getProfiles();
    profiles[name] = toggles;
    saveProfiles(profiles);
    setSelectedProfile(name);
    refreshProfileUI();
    toastr.success('Profile "' + escapeHtml(name) + '" saved (' + Object.keys(toggles).length + ' toggles)', MODULE_NAME);
}

function profileApply(name) {
    if (!name) return;
    const profiles = getProfiles();
    if (!profiles[name]) return;
    setSelectedProfile(name);
    const applied = applyTogglesToDOM(profiles[name]);
    toastr.info('Profile "' + escapeHtml(name) + '" applied (' + applied + ' changed)', MODULE_NAME);
}

function profileDelete(name) {
    if (!name) return;
    const profiles = getProfiles();
    delete profiles[name];
    saveProfiles(profiles);
    if (selectedProfile === name) setSelectedProfile('');
    refreshProfileUI();
    toastr.success('Profile "' + escapeHtml(name) + '" deleted', MODULE_NAME);
}

function refreshProfileUI() {
    const sel = document.getElementById('cpt_profile_select');
    if (!sel) return;
    const names = getProfileNames();
    sel.innerHTML = '';
    if (names.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = getTranslator()('No profiles');
        opt.disabled = true;
        opt.selected = true;
        sel.appendChild(opt);
        setSelectedProfile('');
    } else {
        names.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n;
            sel.appendChild(opt);
        });
        // Restore previously selected profile
        if (selectedProfile && names.includes(selectedProfile)) {
            sel.value = selectedProfile;
        } else {
            setSelectedProfile(sel.value);
        }
    }
    // Track changes from the dropdown itself
    sel.onchange = () => { setSelectedProfile(sel.value); };
}

/* ============================================================
   CONTEXT UNLOCK LOCK
   ============================================================ */

const CTX_LOCK_KEY = 'lockContextUnlock';

function isContextLockEnabled() {
    return !!getSetting(CTX_LOCK_KEY, false);
}

function setContextLock(enabled) {
    setSetting(CTX_LOCK_KEY, enabled);
    applyContextLock();
}

function injectContextLockToggle() {
    const cb = document.getElementById('oai_max_context_unlocked');
    if (!cb) return;
    // Already injected?
    if (document.getElementById('cpt_lock_context')) return;

    const label = cb.closest('label.checkbox_label');
    if (!label) return;

    const t = getTranslator();
    const locked = isContextLockEnabled();

    const btn = document.createElement('span');
    btn.id = 'cpt_lock_context';
    btn.className = 'cpt-ctx-lock fa-solid ' + (locked ? 'fa-lock' : 'fa-lock-open') + ' fa-xs';
    btn.title = t('Lock context unlock');
    btn.style.cssText = 'cursor:pointer;margin-left:6px;opacity:0.7;';
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const newState = !isContextLockEnabled();
        setContextLock(newState);
        btn.classList.toggle('fa-lock', newState);
        btn.classList.toggle('fa-lock-open', !newState);
        btn.style.opacity = newState ? '1' : '0.7';
    });
    if (locked) btn.style.opacity = '1';

    label.appendChild(btn);
    applyContextLock();
}

function applyContextLock() {
    const cb = document.getElementById('oai_max_context_unlocked');
    if (!cb) return;
    const locked = isContextLockEnabled();
    if (locked) {
        if (cb.checked) {
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
        cb.disabled = true;
        cb.style.opacity = '0.4';
        cb.style.pointerEvents = 'none';
    } else {
        cb.disabled = false;
        cb.style.opacity = '';
        cb.style.pointerEvents = '';
    }
}

function setupContextLockGuard() {
    const cb = document.getElementById('oai_max_context_unlocked');
    if (!cb || cb._cptGuarded) return;
    cb._cptGuarded = true;
    cb.addEventListener('change', () => {
        if (isContextLockEnabled() && cb.checked) {
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
        }
    });
}

/* ============================================================
   CHARACTER PANEL (per-char save only)
   ============================================================ */

function injectCharPanel() {
    if (document.getElementById('cpt_char_panel')) return;

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
                '<div class="flex-container" style="gap:6px;">' +
                    '<div id="cpt_char_save" class="menu_button" style="padding:5px 12px;cursor:pointer;font-size:12px;">' +
                        '<span class="fa-solid fa-floppy-disk" style="margin-right:4px;"></span>' +
                        '<span data-i18n="Save for char">Save for char</span>' +
                    '</div>' +
                '</div>' +
                '<small id="cpt_status" style="display:block;margin-top:6px;opacity:0.7;" data-i18n="Ready">Ready</small>' +
            '</div>' +
        '</div>';

    const creatorsDiv = document.getElementById('creators_notes_div');
    if (creatorsDiv) {
        const drawer = creatorsDiv.closest('.inline-drawer');
        if (drawer) drawer.before(panel);
    } else {
        const target = document.getElementById('form_create');
        if (target) target.appendChild(panel);
    }

    document.getElementById('cpt_char_save').addEventListener('click', doSave);
}

/* ============================================================
   PROMPT MANAGER TOOLBAR: search + profiles
   ============================================================ */

function injectPMToolbar() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return false;
    if (document.getElementById(TOOLBAR_ID)) return true;

    const t = getTranslator();

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = 'cpt-pm-toolbar';
    toolbar.innerHTML =
        // Search row
        '<div class="cpt-pm-search-wrap">' +
            '<span class="fa-solid fa-magnifying-glass cpt-pm-search-icon"></span>' +
            '<input type="text" id="' + SEARCH_INPUT_ID + '" class="text_pole cpt-pm-search-input" placeholder="" autocomplete="off" />' +
            '<span id="' + SEARCH_CLEAR_ID + '" class="fa-solid fa-xmark cpt-pm-search-clear" title=""></span>' +
        '</div>' +
        // Profiles row
        '<div class="cpt-profiles-row">' +
            '<select id="cpt_profile_select" class="text_pole cpt-profile-select"></select>' +
            '<span id="cpt_profile_apply" class="cpt-profile-btn fa-solid fa-check fa-xs" title="' + escapeHtml(t('Apply profile')) + '"></span>' +
            '<span id="cpt_profile_save" class="cpt-profile-btn fa-solid fa-floppy-disk fa-xs" title="' + escapeHtml(t('Save to profile')) + '"></span>' +
            '<span id="cpt_profile_new" class="cpt-profile-btn fa-solid fa-plus fa-xs" title="' + escapeHtml(t('New profile')) + '"></span>' +
            '<span id="cpt_profile_delete" class="cpt-profile-btn caution fa-solid fa-trash fa-xs" title="' + escapeHtml(t('Delete profile')) + '"></span>' +
        '</div>';

    list.parentElement.insertBefore(toolbar, list);

    // Search
    const input = toolbar.querySelector('#' + SEARCH_INPUT_ID);
    const clear = toolbar.querySelector('#' + SEARCH_CLEAR_ID);
    input.placeholder = t('Search prompts by name...');
    clear.title = t('Clear');
    if (searchQuery) input.value = searchQuery;
    input.addEventListener('input', () => { searchQuery = input.value; applySearchFilter(); });
    clear.addEventListener('click', () => { input.value = ''; searchQuery = ''; applySearchFilter(); input.focus(); });

    // Profile: Apply — read from selectedProfile (persisted across re-renders)
    toolbar.querySelector('#cpt_profile_apply').addEventListener('click', () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (name) profileApply(name);
    });

    // Profile: Overwrite
    toolbar.querySelector('#cpt_profile_save').addEventListener('click', () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (name) profileSave(name);
    });

    // Profile: New
    toolbar.querySelector('#cpt_profile_new').addEventListener('click', () => {
        const name = window.prompt(t('New profile name'));
        if (!name || !name.trim()) return;
        const trimmed = name.trim();
        profileSave(trimmed);
        setSelectedProfile(trimmed);
        refreshProfileUI();
    });

    // Profile: Delete
    toolbar.querySelector('#cpt_profile_delete').addEventListener('click', () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (!name) return;
        if (!window.confirm(t('Delete profile') + ' "' + name + '"?')) return;
        profileDelete(name);
    });

    refreshProfileUI();
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

/* ============================================================
   PROMPT MANAGER: duplicate, delete, row actions
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
    if (cachedPromptManager?.serviceSettings?.prompts) return cachedPromptManager.serviceSettings.prompts;
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
        if (!pm || !src) { console.error('[' + MODULE_NAME + '] duplicate: not found'); actionInProgress = false; return; }

        const newId = getUuid();
        const copy = JSON.parse(JSON.stringify(src));
        copy.identifier = newId;
        copy.system_prompt = false;
        copy.marker = false;

        if (typeof pm.addPrompt === 'function') pm.addPrompt(copy, newId);
        else if (Array.isArray(pm.serviceSettings?.prompts)) pm.serviceSettings.prompts.push(copy);

        if (pm.activeCharacter && typeof pm.getPromptOrderForCharacter === 'function') {
            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
            if (Array.isArray(order)) {
                const srcIdx = order.findIndex(e => e && e.identifier === identifier);
                const srcEntry = srcIdx !== -1 ? order[srcIdx] : null;
                const newEntry = { identifier: newId, enabled: srcEntry ? !!srcEntry.enabled : false };
                if (srcIdx !== -1) order.splice(srcIdx + 1, 0, newEntry);
                else order.push(newEntry);
            } else if (typeof pm.appendPrompt === 'function') pm.appendPrompt(copy, pm.activeCharacter);
        } else if (typeof pm.appendPrompt === 'function' && pm.activeCharacter) pm.appendPrompt(copy, pm.activeCharacter);

        if (typeof pm.saveServiceSettings === 'function') await pm.saveServiceSettings();
        if (typeof pm.render === 'function') pm.render();
    } catch (e) { console.error('[' + MODULE_NAME + '] duplicate failed:', e); }
    finally { actionInProgress = false; }
}

async function deletePromptById(identifier) {
    if (actionInProgress) return;
    actionInProgress = true;
    try {
        const pm = await resolvePromptManager();
        const src = getPromptById(identifier);
        if (!pm || !src) { console.error('[' + MODULE_NAME + '] delete: not found'); actionInProgress = false; return; }
        if (src.system_prompt) { actionInProgress = false; return; }
        const t = getTranslator();
        if (!(await confirmDialog(t('Delete prompt'), t('Delete prompt') + ' "' + escapeHtml(src.name || identifier) + '"?'))) return;

        if (typeof pm.detachPrompt === 'function' && pm.activeCharacter) { try { pm.detachPrompt(src, pm.activeCharacter); } catch (e) {} }
        if (Array.isArray(pm.serviceSettings?.prompts)) {
            const idx = pm.serviceSettings.prompts.findIndex(p => p.identifier === identifier);
            if (idx !== -1) pm.serviceSettings.prompts.splice(idx, 1);
        }
        if (typeof pm.saveServiceSettings === 'function') await pm.saveServiceSettings();
        if (typeof pm.render === 'function') pm.render();
    } catch (e) { console.error('[' + MODULE_NAME + '] delete failed:', e); }
    finally { actionInProgress = false; }
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
    injectPMToolbar();
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
            position: relative; flex: 1 1 150px; min-width: 0;
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

        .cpt-profiles-row {
            display: flex; gap: 4px; align-items: center;
            flex: 1 1 150px; min-width: 0;
        }
        .cpt-profile-select {
            flex: 1 1 auto; min-width: 0;
            font-size: 12px; padding: 3px 6px;
        }
        .cpt-profile-btn {
            cursor: pointer; opacity: 0.65; padding: 2px 4px;
        }
        .cpt-profile-btn:hover { opacity: 1; }

        .cpt-row-actions { display: inline-flex; gap: 6px; align-items: center; margin-right: 4px; vertical-align: middle; }
        .cpt-row-action { cursor: pointer; opacity: 0.65; }
        .cpt-row-action:hover { opacity: 1; }

        .cpt-ctx-lock:hover { opacity: 1 !important; }

        @media (max-width: 600px) {
            #${TOOLBAR_ID}.cpt-pm-toolbar { gap: 4px; }
            .cpt-pm-search-wrap { flex: 1 1 100%; }
            .cpt-profiles-row { flex: 1 1 100%; }
            .cpt-row-actions { gap: 8px; margin-right: 6px; }
            .cpt-row-action { padding: 3px 4px; font-size: 1.05em; }
            .cpt-profile-btn { padding: 4px 6px; font-size: 1.05em; }
        }
    `;
    document.head.appendChild(style);
}

/* ============================================================
   INIT
   ============================================================ */

const debouncedInjectCharPanel = debounce(() => { injectCharPanel(); }, 500);

jQuery(async () => {
    console.log('[' + MODULE_NAME + '] Loading...');
    try {
        injectStyles();

        // Restore persisted selectedProfile
        selectedProfile = getSetting('selectedProfile', '');

        resolvePromptManager().then(pm => {
            if (pm) console.log('[' + MODULE_NAME + '] promptManager resolved');
            else console.warn('[' + MODULE_NAME + '] promptManager not resolved');
        });

        const charPanelObserver = new MutationObserver(() => {
            debouncedInjectCharPanel();
            // Re-inject context lock icon if ST recreated the settings panel
            injectContextLockToggle();
        });
        charPanelObserver.observe(document.body, { childList: true, subtree: true });
        injectCharPanel();
        injectContextLockToggle();
        setupContextLockGuard();

        setupDelegatedHandlers();
        attachPMObserver();

        const { eventSource, event_types } = SillyTavern.getContext();

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
