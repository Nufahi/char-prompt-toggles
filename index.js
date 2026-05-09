const MODULE_NAME = 'char-prompt-toggles';
const STORAGE_KEY = 'char_prompt_toggles_data';

const PM_CONTAINER_ID = 'completion_prompt_manager';
const PM_LIST_ID = 'completion_prompt_manager_list';
const TOOLBAR_ID = 'cpt_pm_toolbar';
const SEARCH_INPUT_ID = 'cpt_pm_search';
const SEARCH_MODE_ID = 'cpt_pm_search_mode';
const SEARCH_CLEAR_ID = 'cpt_pm_search_clear';

let lastCharId = null;
let pmObserver = null;
let pmReinjectScheduled = false;

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
        return ctx.promptManager || (window.promptManager) || null;
    } catch (e) {
        return null;
    }
}

function getPromptById(identifier) {
    const pm = getPromptManager();
    if (!pm) return null;
    try {
        if (typeof pm.getPromptById === 'function') return pm.getPromptById(identifier);
        if (Array.isArray(pm.serviceSettings?.prompts)) {
            return pm.serviceSettings.prompts.find(p => p.identifier === identifier) || null;
        }
    } catch (e) {}
    return null;
}

function getPromptContent(identifier) {
    const p = getPromptById(identifier);
    return (p && typeof p.content === 'string') ? p.content : '';
}

function getPromptName(identifier) {
    const p = getPromptById(identifier);
    return (p && typeof p.name === 'string') ? p.name : '';
}

function findXmlTags(content) {
    if (!content) return [];
    const tags = new Set();
    const re = /<\/?\s*([a-zA-Z][\w:-]*)\b[^>]*>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
        tags.add(m[1].toLowerCase());
    }
    return Array.from(tags);
}

function injectSearchToolbar() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return false;
    if (document.getElementById(TOOLBAR_ID)) return true;

    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = 'cpt-pm-toolbar';
    toolbar.innerHTML = '\
        <div class="cpt-pm-search-wrap">\
            <span class="fa-solid fa-magnifying-glass cpt-pm-search-icon"></span>\
            <input type="search" id="' + SEARCH_INPUT_ID + '" class="text_pole cpt-pm-search-input" placeholder="" autocomplete="off" />\
            <span id="' + SEARCH_CLEAR_ID + '" class="fa-solid fa-xmark cpt-pm-search-clear" title=""></span>\
        </div>\
        <select id="' + SEARCH_MODE_ID + '" class="text_pole cpt-pm-search-mode" title="">\
            <option value="name" data-i18n="cpt_search_by_name">Name</option>\
            <option value="tag" data-i18n="cpt_search_by_tag">XML tag</option>\
            <option value="both" data-i18n="cpt_search_by_both">Name + tag</option>\
        </select>\
    ';

    list.parentElement.insertBefore(toolbar, list);

    const input = toolbar.querySelector('#' + SEARCH_INPUT_ID);
    const mode = toolbar.querySelector('#' + SEARCH_MODE_ID);
    const clear = toolbar.querySelector('#' + SEARCH_CLEAR_ID);

    // i18n via SillyTavern translate
    try {
        const t = SillyTavern.getContext().translate || ((s) => s);
        input.placeholder = t('Search prompts...');
        clear.title = t('Clear');
        mode.title = t('Search mode');
    } catch (e) {}

    input.addEventListener('input', applySearchFilter);
    mode.addEventListener('change', applySearchFilter);
    clear.addEventListener('click', () => {
        input.value = '';
        applySearchFilter();
        input.focus();
    });

    return true;
}

function applySearchFilter() {
    const input = document.getElementById(SEARCH_INPUT_ID);
    const mode = document.getElementById(SEARCH_MODE_ID);
    if (!input) return;
    const q = (input.value || '').trim().toLowerCase();
    const m = mode ? mode.value : 'name';
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;

    const items = list.querySelectorAll('li[data-pm-identifier]');
    items.forEach(li => {
        if (!q) {
            li.style.display = '';
            return;
        }
        const id = li.dataset.pmIdentifier;
        const nameFromDom = (li.querySelector('.completion_prompt_manager_prompt_name, .prompt-manager-prompt-name, .completion_prompt_manager_prompt span')?.textContent || li.textContent || '').toLowerCase();
        const name = (getPromptName(id) || nameFromDom).toLowerCase();

        let matched = false;
        if (m === 'name') {
            matched = name.includes(q);
        } else if (m === 'tag') {
            const content = getPromptContent(id);
            const tags = findXmlTags(content);
            const qNoBrackets = q.replace(/[<>/\s]/g, '');
            matched = tags.some(t => t.includes(qNoBrackets));
        } else { // both
            const content = getPromptContent(id);
            const tags = findXmlTags(content);
            const qNoBrackets = q.replace(/[<>/\s]/g, '');
            matched = name.includes(q) || tags.some(t => t.includes(qNoBrackets));
        }
        li.style.display = matched ? '' : 'none';
    });
}

async function duplicatePrompt(identifier) {
    const pm = getPromptManager();
    const src = getPromptById(identifier);
    if (!pm || !src) {
        toastr.error('Cannot duplicate: prompt not found', MODULE_NAME);
        return;
    }
    try {
        const ctx = SillyTavern.getContext();
        const newId = (typeof ctx.getUuidv4 === 'function') ? ctx.getUuidv4()
            : (window.crypto?.randomUUID ? window.crypto.randomUUID()
            : ('cpt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)));

        const copy = JSON.parse(JSON.stringify(src));
        copy.identifier = newId;
        // keep original name as requested
        // ensure not marked as system/marker so it's editable/removable
        if (copy.system_prompt) copy.system_prompt = false;
        if (copy.marker) copy.marker = false;

        if (typeof pm.addPrompt === 'function') {
            pm.addPrompt(copy, copy);
        } else if (Array.isArray(pm.serviceSettings?.prompts)) {
            pm.serviceSettings.prompts.push(copy);
        }

        if (typeof pm.appendPrompt === 'function') {
            pm.appendPrompt(copy, pm.activeCharacter);
        }

        if (typeof pm.saveServiceSettings === 'function') {
            await pm.saveServiceSettings();
        }
        if (typeof pm.render === 'function') {
            pm.render();
        }
        toastr.success('Prompt duplicated', MODULE_NAME);
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
    let confirmed = false;
    try {
        const ctx = SillyTavern.getContext();
        const t = ctx.translate || ((s) => s);
        const msg = t('Delete prompt') + ' "' + (src.name || identifier) + '"?';
        if (typeof ctx.Popup?.show?.confirm === 'function') {
            const res = await ctx.Popup.show.confirm(t('Delete prompt'), msg);
            confirmed = !!res;
        } else if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            const res = await ctx.callGenericPopup(msg, ctx.POPUP_TYPE.CONFIRM);
            confirmed = !!res;
        } else {
            confirmed = window.confirm(msg);
        }
    } catch (e) {
        confirmed = window.confirm('Delete prompt "' + (src.name || identifier) + '"?');
    }
    if (!confirmed) return;

    try {
        // Detach from current character order
        if (typeof pm.detachPrompt === 'function' && pm.activeCharacter) {
            pm.detachPrompt(src, pm.activeCharacter);
        }
        // Remove from prompts list
        if (Array.isArray(pm.serviceSettings?.prompts)) {
            const idx = pm.serviceSettings.prompts.findIndex(p => p.identifier === identifier);
            if (idx !== -1) pm.serviceSettings.prompts.splice(idx, 1);
        }
        if (typeof pm.removePromptOrderForCharacter === 'function' && pm.activeCharacter) {
            // best-effort: do not call unless API present
        }
        if (typeof pm.saveServiceSettings === 'function') {
            await pm.saveServiceSettings();
        }
        if (typeof pm.render === 'function') {
            pm.render();
        }
        toastr.success('Prompt deleted', MODULE_NAME);
    } catch (e) {
        console.error('[' + MODULE_NAME + '] delete failed:', e);
        toastr.error('Delete failed: ' + e.message, MODULE_NAME);
    }
}

function injectRowActions() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const items = list.querySelectorAll('li[data-pm-identifier]');
    items.forEach(li => {
        if (li.querySelector('.cpt-row-actions')) return;
        const id = li.dataset.pmIdentifier;
        if (!id) return;
        // Skip dummy/marker items if they have no real prompt
        const prompt = getPromptById(id);
        if (!prompt) return;

        // Try to attach to actions container, fall back to li itself
        const actionsContainer = li.querySelector('.completion_prompt_manager_prompt_controls, .prompt_manager_prompt_controls') || li;

        const wrap = document.createElement('span');
        wrap.className = 'cpt-row-actions';

        const dup = document.createElement('span');
        dup.className = 'cpt-row-action cpt-row-duplicate fa-solid fa-clone interactable';
        dup.title = 'Duplicate';
        try {
            const t = SillyTavern.getContext().translate || ((s) => s);
            dup.title = t('Duplicate');
        } catch (e) {}
        dup.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            duplicatePrompt(id);
        });

        const del = document.createElement('span');
        del.className = 'cpt-row-action cpt-row-delete fa-solid fa-trash-can interactable';
        del.title = 'Delete';
        try {
            const t = SillyTavern.getContext().translate || ((s) => s);
            del.title = t('Delete');
        } catch (e) {}
        del.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            deletePromptById(id);
        });

        wrap.appendChild(dup);
        wrap.appendChild(del);
        actionsContainer.appendChild(wrap);
    });
}

function injectPMEnhancements() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    injectSearchToolbar();
    injectRowActions();
    // Re-apply current filter after a re-render
    applySearchFilter();
}

function schedulePMReinject() {
    if (pmReinjectScheduled) return;
    pmReinjectScheduled = true;
    requestAnimationFrame(() => {
        pmReinjectScheduled = false;
        injectPMEnhancements();
    });
}

function setupPMObserver() {
    if (pmObserver) return;
    pmObserver = new MutationObserver((mutations) => {
        // Re-inject if our toolbar or row actions were stripped (PM re-renders innerHTML)
        const list = document.getElementById(PM_LIST_ID);
        if (!list) return;
        const toolbar = document.getElementById(TOOLBAR_ID);
        const anyRowAction = list.querySelector('.cpt-row-actions');
        if (!toolbar || !anyRowAction) {
            schedulePMReinject();
        }
    });
    pmObserver.observe(document.body, { childList: true, subtree: true });
}

function injectStyles() {
    if (document.getElementById('cpt-styles')) return;
    const style = document.createElement('style');
    style.id = 'cpt-styles';
    style.textContent = `
        .cpt-pm-toolbar {
            display: flex;
            gap: 6px;
            align-items: center;
            margin: 6px 0 8px 0;
            flex-wrap: wrap;
        }
        .cpt-pm-search-wrap {
            position: relative;
            flex: 1 1 180px;
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
        .cpt-pm-search-input::-webkit-search-cancel-button { display: none; }
        .cpt-pm-search-clear {
            position: absolute;
            right: 8px;
            opacity: 0.6;
            cursor: pointer;
            font-size: 0.9em;
        }
        .cpt-pm-search-clear:hover { opacity: 1; }
        .cpt-pm-search-mode {
            flex: 0 0 auto;
            min-width: 110px;
            max-width: 160px;
        }

        .cpt-row-actions {
            display: inline-flex;
            gap: 8px;
            align-items: center;
            margin-left: 6px;
        }
        .cpt-row-action {
            cursor: pointer;
            opacity: 0.65;
            font-size: 0.95em;
            padding: 2px 4px;
        }
        .cpt-row-action:hover { opacity: 1; }
        .cpt-row-delete:hover { color: var(--crimson70a, #c0392b); }

        @media (max-width: 600px) {
            .cpt-pm-toolbar {
                gap: 4px;
            }
            .cpt-pm-search-wrap { flex: 1 1 100%; }
            .cpt-pm-search-mode {
                flex: 1 1 100%;
                max-width: 100%;
            }
            .cpt-row-actions { gap: 10px; }
            .cpt-row-action {
                font-size: 1.05em;
                padding: 4px 6px;
            }
        }
    `;
    document.head.appendChild(style);
}

jQuery(async () => {
    console.log('[' + MODULE_NAME + '] Loading...');

    try {
        injectStyles();

        const observer = new MutationObserver(() => { injectCharPanel(); });
        observer.observe(document.body, { childList: true, subtree: true });
        injectCharPanel();

        setupPMObserver();
        injectPMEnhancements();

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
                injectPMEnhancements();
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
