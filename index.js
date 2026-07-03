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
let restoreGeneration = 0;
let pmWaitTimer = null;
let chatChangedTimer = null;

/* -- Settings persistence -- */

function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch(e) { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
function getSetting(key, def) { const s = loadSettings(); return key in s ? s[key] : def; }
function setSetting(key, val) { const s = loadSettings(); s[key] = val; saveSettings(s); }

/* -- Helpers -- */

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

function saveStorage(data) { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }

// Access the live prompt-order entries ({identifier, enabled}) for the active
// character. This is the source of truth Prompt Manager itself mutates on every
// toggle click. Working with it directly lets us change many toggles and render
// ONCE, instead of clicking each toggle (which forces a full render + save per
// click and makes big presets crawl).
function getActiveOrder() {
    const pm = getPromptManager();
    if (!pm || typeof pm.getPromptOrderForCharacter !== 'function' || !pm.activeCharacter) return null;
    try {
        const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
        return Array.isArray(order) ? order : null;
    } catch (e) { return null; }
}

// Read current toggle states. Prefer the PM API (fast, DOM-independent); fall
// back to scraping the DOM when the API isn't ready yet.
function readToggles() {
    const order = getActiveOrder();
    if (order) {
        const toggles = {};
        order.forEach(e => { if (e && e.identifier) toggles[e.identifier] = !!e.enabled; });
        if (Object.keys(toggles).length) return toggles;
    }
    return readTogglesFromDOM();
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

// Apply saved toggle states via the PM API: flip only the entries that differ,
// then render + save exactly once. This is near-instant even for huge presets
// and never blocks the toolbar/toggles with a render storm.
// Returns the number of changed toggles, or -1 if the API path is unavailable.
async function applyTogglesViaAPI(saved) {
    const pm = getPromptManager();
    const order = getActiveOrder();
    if (!pm || !order) return -1;

    let changed = 0;
    order.forEach(e => {
        if (!e || !e.identifier || !(e.identifier in saved)) return;
        const want = !!saved[e.identifier];
        if (!!e.enabled !== want) { e.enabled = want; changed++; }
    });

    if (changed > 0) {
        try {
            if (pm.tokenHandler && typeof pm.tokenHandler.getCounts === 'function') {
                // Invalidate cached token counts for changed prompts (PM does this per toggle).
                const counts = pm.tokenHandler.getCounts();
                if (counts) order.forEach(e => { if (e && e.identifier in saved) counts[e.identifier] = null; });
            }
        } catch (e) {}
        // IMPORTANT: render(false) skips tryGenerate(), which otherwise runs a
        // full Generate('normal', {}, true) dry-run (prompt build + world-info
        // scan + token counting). That dry-run is what made restore hang for
        // ~20s. render(false) only does the cheap DOM refresh — same call ST
        // itself uses internally.
        if (typeof pm.render === 'function') pm.render(false);
        if (typeof pm.saveServiceSettings === 'function') { try { await pm.saveServiceSettings(); } catch (e) {} }
    }
    return changed;
}

// Fallback (API unavailable): click the differing toggles in one synchronous
// pass. Simple and fast; only used when the PM API can't be resolved.
function applyTogglesViaDOM(saved) {
    let applied = 0;
    document.querySelectorAll('[data-pm-identifier]').forEach(el => {
        const id = el.dataset.pmIdentifier;
        if (!id || !(id in saved)) return;
        const toggle = el.querySelector('.fa-toggle-on, .fa-toggle-off');
        if (!toggle) return;
        const isOn = toggle.classList.contains('fa-toggle-on');
        if (isOn !== !!saved[id]) { toggle.click(); applied++; }
    });
    return applied;
}

let togglesApplyInFlight = false;
async function applyToggles(saved, onDone) {
    if (togglesApplyInFlight) { if (onDone) onDone(0); return; }
    togglesApplyInFlight = true;
    let applied = 0;
    try {
        const viaApi = await applyTogglesViaAPI(saved);
        applied = viaApi === -1 ? applyTogglesViaDOM(saved) : viaApi;
    } catch (e) {
        console.error('[' + MODULE_NAME + '] applyToggles failed:', e);
    } finally {
        togglesApplyInFlight = false;
    }
    if (onDone) onDone(applied);
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
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function debounce(fn, ms) {
    let timer = null;
    return function() {
        const a = arguments, c = this;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(c, a), ms);
    };
}

function isReservedKey(key) { return typeof key === 'string' && key.startsWith('_'); }

/* -- Per-character save / restore -- */

function doSave() {
    const charId = getCurrentCharId();
    if (!charId || isReservedKey(charId)) { updateStatus('No active character'); return; }
    const toggles = readToggles();
    const count = Object.keys(toggles).length;
    if (count === 0) { updateStatus('Toggles not found — open Prompt Manager'); return; }
    const data = loadStorage();
    data[charId] = toggles;
    saveStorage(data);
    updateStatus(getCharName() + ': saved ' + count + ' toggles');
}

function tryRestore(charId, attempt, maxAttempts, generation) {
    attempt = attempt || 1;
    maxAttempts = maxAttempts || 8;
    if (generation === undefined) generation = restoreGeneration;
    // Abort if a newer character switch happened in the meantime.
    if (generation !== restoreGeneration) return;
    if (!charId || isReservedKey(charId)) return;
    // An apply is already running — don't start another on top of it.
    if (togglesApplyInFlight) return;
    // Abort if the active character no longer matches the one we're restoring for.
    if (getCurrentCharId() !== charId) return;

    const data = loadStorage();
    if (!data[charId]) return;
    const name = getCharName();

    // Fast path: the PM API is ready — apply instantly via prompt order, no DOM
    // scraping and a single render. This is what makes the switch feel snappy.
    if (getActiveOrder()) {
        applyToggles(data[charId], (applied) => {
            if (generation !== restoreGeneration) return;
            if (applied > 0) updateStatus(name + ': auto-restored ' + applied + ' toggles');
        });
        return;
    }

    // API not ready yet (PM not resolved / no active order). Retry a few times;
    // the DOM fallback inside applyToggles will kick in if toggles are present.
    const toggles = readTogglesFromDOM();
    if (Object.keys(toggles).length === 0) {
        if (attempt < maxAttempts) setTimeout(() => tryRestore(charId, attempt + 1, maxAttempts, generation), 400);
        return;
    }
    applyToggles(data[charId], (applied) => {
        if (generation !== restoreGeneration) return;
        if (applied > 0) updateStatus(name + ': auto-restored ' + applied + ' toggles');
    });
}

/* -- Global profiles -- */

function getProfiles() { return loadStorage()._profiles || {}; }

function saveProfiles(profiles) {
    const data = loadStorage();
    data._profiles = profiles;
    saveStorage(data);
}

function getProfileNames() { return Object.keys(getProfiles()); }

function setSelectedProfile(name) {
    selectedProfile = name;
    setSetting('selectedProfile', name);
}

function profileSave(name) {
    if (!name) return;
    const toggles = readToggles();
    if (Object.keys(toggles).length === 0) { toastr.warning('Open Prompt Manager first', MODULE_NAME); return; }
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
    applyToggles(profiles[name], (applied) => {
        toastr.info('Profile "' + escapeHtml(name) + '" applied (' + applied + ' changed)', MODULE_NAME);
    });
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
        if (selectedProfile && names.includes(selectedProfile)) sel.value = selectedProfile;
        else setSelectedProfile(sel.value);
    }
    sel.onchange = () => setSelectedProfile(sel.value);
}

/* -- Context unlock lock -- */

const CTX_LOCK_KEY = 'lockContextUnlock';

function isContextLockEnabled() { return !!getSetting(CTX_LOCK_KEY, false); }

function setContextLock(enabled) { setSetting(CTX_LOCK_KEY, enabled); applyContextLock(); }

function injectContextLockToggle() {
    const cb = document.getElementById('oai_max_context_unlocked');
    if (!cb || document.getElementById('cpt_lock_context')) return;
    const label = cb.closest('label.checkbox_label');
    if (!label) return;

    const t = getTranslator();
    const locked = isContextLockEnabled();
    const btn = document.createElement('span');
    btn.id = 'cpt_lock_context';
    btn.className = 'cpt-ctx-lock fa-solid ' + (locked ? 'fa-lock' : 'fa-lock-open') + ' fa-xs';
    btn.title = t('Lock context unlock');
    btn.style.cssText = 'cursor:pointer;margin-left:6px;opacity:' + (locked ? '1' : '0.7') + ';';
    btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const newState = !isContextLockEnabled();
        setContextLock(newState);
        btn.classList.toggle('fa-lock', newState);
        btn.classList.toggle('fa-lock-open', !newState);
        btn.style.opacity = newState ? '1' : '0.7';
    });
    label.appendChild(btn);
    applyContextLock();
}

function applyContextLock() {
    const cb = document.getElementById('oai_max_context_unlocked');
    if (!cb) return;
    if (isContextLockEnabled()) {
        if (cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
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
        // If locked and something tries to check it, revert silently.
        // Do NOT re-dispatch 'change' here: it re-enters this handler and forces
        // ST to re-run its own change handler redundantly.
        if (isContextLockEnabled() && cb.checked) {
            cb.checked = false;
        }
    });
}

/* -- Character panel -- */

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

    let inserted = false;
    const creatorsDiv = document.getElementById('creators_notes_div');
    if (creatorsDiv) {
        const drawer = creatorsDiv.closest('.inline-drawer');
        if (drawer) { drawer.before(panel); inserted = true; }
    }
    if (!inserted) {
        const target = document.getElementById('form_create');
        if (target) { target.appendChild(panel); inserted = true; }
    }
    if (!inserted) return; // No host element yet; will retry on next event.
    const saveBtn = panel.querySelector('#cpt_char_save');
    if (saveBtn) saveBtn.addEventListener('click', doSave);
}

/* -- PM toolbar: search + profiles -- */

function injectPMToolbar() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list || document.getElementById(TOOLBAR_ID)) return;

    const t = getTranslator();
    const toolbar = document.createElement('div');
    toolbar.id = TOOLBAR_ID;
    toolbar.className = 'cpt-pm-toolbar';
    toolbar.innerHTML =
        '<div class="cpt-pm-search-wrap">' +
            '<span class="fa-solid fa-magnifying-glass cpt-pm-search-icon"></span>' +
            '<input type="text" id="' + SEARCH_INPUT_ID + '" class="text_pole cpt-pm-search-input" placeholder="" autocomplete="off" />' +
            '<span id="' + SEARCH_CLEAR_ID + '" class="fa-solid fa-xmark cpt-pm-search-clear" title=""></span>' +
        '</div>' +
        '<div class="cpt-profiles-row">' +
            '<select id="cpt_profile_select" class="text_pole cpt-profile-select"></select>' +
            '<span id="cpt_profile_apply" class="cpt-profile-btn fa-solid fa-check fa-xs" title="' + escapeHtml(t('Apply profile')) + '"></span>' +
            '<span id="cpt_profile_save" class="cpt-profile-btn fa-solid fa-floppy-disk fa-xs" title="' + escapeHtml(t('Save to profile')) + '"></span>' +
            '<span id="cpt_profile_new" class="cpt-profile-btn fa-solid fa-plus fa-xs" title="' + escapeHtml(t('New profile')) + '"></span>' +
            '<span id="cpt_profile_delete" class="cpt-profile-btn caution fa-solid fa-trash fa-xs" title="' + escapeHtml(t('Delete profile')) + '"></span>' +
        '</div>';

    list.parentElement.insertBefore(toolbar, list);

    const input = toolbar.querySelector('#' + SEARCH_INPUT_ID);
    const clear = toolbar.querySelector('#' + SEARCH_CLEAR_ID);
    if (input) {
        input.placeholder = t('Search prompts by name...');
        if (searchQuery) input.value = searchQuery;
        input.addEventListener('input', () => { searchQuery = input.value; applySearchFilter(); });
    }
    if (clear) {
        clear.title = t('Clear');
        clear.addEventListener('click', () => { if (input) input.value = ''; searchQuery = ''; applySearchFilter(); input?.focus(); });
    }

    toolbar.querySelector('#cpt_profile_apply')?.addEventListener('click', () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (name) profileApply(name);
    });
    toolbar.querySelector('#cpt_profile_save')?.addEventListener('click', () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (name) profileSave(name);
    });
    toolbar.querySelector('#cpt_profile_new')?.addEventListener('click', () => {
        const name = window.prompt(t('New profile name'));
        if (!name || !name.trim()) return;
        profileSave(name.trim());
        setSelectedProfile(name.trim());
        refreshProfileUI();
    });
    toolbar.querySelector('#cpt_profile_delete')?.addEventListener('click', () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (!name) return;
        if (!window.confirm(t('Delete profile') + ' "' + name + '"?')) return;
        profileDelete(name);
    });

    refreshProfileUI();
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

/* -- PM: duplicate, delete, row actions -- */

let openaiModule = null;

// promptManager is an `export let` live binding in openai.js that starts null
// and becomes the instance after ST init. So we must read it LAZILY from the
// module namespace each time — caching the value early would capture null.
function getPromptManager() {
    if (openaiModule?.promptManager) return openaiModule.promptManager;
    if (cachedPromptManager) return cachedPromptManager;
    return null;
}

async function resolvePromptManager() {
    if (!openaiModulePromise) {
        openaiModulePromise = import('/scripts/openai.js').catch(() => import('../../../openai.js'));
    }
    try {
        const mod = await openaiModulePromise;
        if (mod) openaiModule = mod;
        if (mod?.promptManager) cachedPromptManager = mod.promptManager;
    } catch (e) { console.error('[' + MODULE_NAME + '] cannot resolve promptManager:', e); }
    return getPromptManager();
}

function getPromptsArray() {
    const pm = getPromptManager();
    if (pm?.serviceSettings?.prompts) return pm.serviceSettings.prompts;
    try { const ctx = SillyTavern.getContext(); if (ctx?.chatCompletionSettings?.prompts) return ctx.chatCompletionSettings.prompts; } catch (e) {}
    return null;
}

function getPromptById(id) {
    const arr = getPromptsArray();
    return arr ? arr.find(p => p?.identifier === id) || null : null;
}

function getPromptNameFromDOM(li) {
    if (!li) return '';
    const nameEl = li.querySelector('.completion_prompt_manager_prompt_name');
    if (!nameEl) return (li.textContent || '').trim();
    const inspect = nameEl.querySelector('.prompt-manager-inspect-action');
    if (inspect?.textContent) return inspect.textContent.trim();
    const attr = nameEl.getAttribute('data-pm-name');
    if (attr) return attr.trim();
    const clone = nameEl.cloneNode(true);
    clone.querySelectorAll('span, small, i, a').forEach(n => n.remove());
    return (clone.textContent || '').trim();
}

function getUuid() {
    try { const ctx = SillyTavern.getContext(); if (typeof ctx?.uuidv4 === 'function') return ctx.uuidv4(); } catch (e) {}
    return window.crypto?.randomUUID?.() || ('cpt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
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
        if (!pm || !src) { actionInProgress = false; return; }

        const newId = getUuid();
        const copy = JSON.parse(JSON.stringify(src));
        copy.identifier = newId;
        copy.system_prompt = false;
        copy.marker = false;
        if (typeof copy.name === 'string') copy.name = copy.name + ' (copy)';

        if (typeof pm.addPrompt === 'function') pm.addPrompt(copy, newId);
        else if (Array.isArray(pm.serviceSettings?.prompts)) pm.serviceSettings.prompts.push(copy);

        if (pm.activeCharacter && typeof pm.getPromptOrderForCharacter === 'function') {
            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
            if (Array.isArray(order)) {
                const srcIdx = order.findIndex(e => e?.identifier === identifier);
                const newEntry = { identifier: newId, enabled: srcIdx !== -1 ? !!order[srcIdx].enabled : false };
                if (srcIdx !== -1) order.splice(srcIdx + 1, 0, newEntry);
                else order.push(newEntry);
            }
        }

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
        if (!pm || !src) { actionInProgress = false; return; }
        if (src.system_prompt) { actionInProgress = false; return; }
        const t = getTranslator();
        if (!(await confirmDialog(t('Delete prompt'), t('Delete prompt') + ' "' + escapeHtml(src.name || identifier) + '"?'))) return;

        if (typeof pm.detachPrompt === 'function' && pm.activeCharacter) try { pm.detachPrompt(src, pm.activeCharacter); } catch (e) {}
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

    // Token count spans overlap toggle buttons on mobile — disable their pointer events
    // (same fix as 预设条目更多按钮)
    list.querySelectorAll('.prompt_manager_prompt_tokens').forEach(el => {
        el.style.pointerEvents = 'none';
    });

    list.querySelectorAll('li.completion_prompt_manager_prompt[data-pm-identifier]').forEach(li => {
        if (li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-thumb-tack')) return;
        if (li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-star')) return;
        const isUser = !!li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-asterisk');
        const isInjection = !!li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-syringe');
        const isSystem = !!li.querySelector(':scope > .completion_prompt_manager_prompt_name .fa-square-poll-horizontal');
        if (!isUser && !isInjection && !isSystem) return;
        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls || controls.querySelector('.cpt-row-actions')) return;
        const id = li.dataset.pmIdentifier;

        const wrap = document.createElement('span');
        wrap.className = 'cpt-row-actions';

        const dup = document.createElement('span');
        dup.className = 'cpt-row-action cpt-row-duplicate fa-solid fa-copy fa-xs';
        dup.title = t('Duplicate');
        dup.addEventListener('click', (ev) => { ev.stopPropagation(); duplicatePrompt(id); });
        wrap.appendChild(dup);

        if (!isSystem) {
            const del = document.createElement('span');
            del.className = 'cpt-row-action cpt-row-delete fa-solid fa-trash fa-xs caution';
            del.title = t('Delete');
            del.addEventListener('click', (ev) => { ev.stopPropagation(); deletePromptById(id); });
            wrap.appendChild(del);
        }
        controls.prepend(wrap);
    });
}

/* -- PM observer (disconnect/work/reconnect pattern) -- */

function injectPMEnhancements() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    injectPMToolbar();
    injectRowActions();
    applySearchFilter();
}

function reinjectPM() {
    if (pmObserver) pmObserver.disconnect();
    injectPMEnhancements();
    startPMObserver();
}

const debouncedReinject = debounce(reinjectPM, 500);

function startPMObserver() {
    // Observe the PM container's DIRECT children only (no subtree). pm.render()
    // replaces the whole #completion_prompt_manager_list node, which is a direct
    // child of the stable container, so childList here catches re-renders.
    // Dropping subtree:true stops the observer from re-firing on every
    // toggle/drag/attribute change deep inside rows, which previously caused a
    // self-feeding reinject loop and lag on large presets. Our own toolbar
    // insertion can't loop because reinjectPM() disconnects before injecting.
    const container = document.getElementById(PM_CONTAINER_ID);
    if (!container) return;
    if (!pmObserver) pmObserver = new MutationObserver(debouncedReinject);
    pmObserver.observe(container, { childList: true });
}

function waitForPMContainer() {
    if (pmWaitTimer) return; // Poll is already running; don't stack intervals.
    if (document.getElementById(PM_CONTAINER_ID)) { reinjectPM(); return; }
    // Lightweight polling instead of a document.body subtree observer. The body
    // observer fired on every DOM mutation while ST builds its whole UI on load,
    // which was the main source of startup lag. The PM container only needs to be
    // detected once, so a cheap interval is sufficient and far less costly.
    let elapsed = 0;
    const intervalMs = 500;
    const maxMs = 60000;
    pmWaitTimer = setInterval(() => {
        elapsed += intervalMs;
        if (document.getElementById(PM_CONTAINER_ID)) {
            clearInterval(pmWaitTimer);
            pmWaitTimer = null;
            reinjectPM();
        } else if (elapsed >= maxMs) {
            // Stop polling if the PM never appears (e.g. non Chat-Completion backends).
            clearInterval(pmWaitTimer);
            pmWaitTimer = null;
        }
    }, intervalMs);
}

/* -- Styles -- */

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
        .cpt-pm-search-icon { position: absolute; left: 8px; opacity: 0.6; pointer-events: none; font-size: 0.9em; }
        .cpt-pm-search-input { width: 100%; padding-left: 26px !important; padding-right: 26px !important; box-sizing: border-box; }
        .cpt-pm-search-clear { position: absolute; right: 8px; opacity: 0.6; cursor: pointer; font-size: 0.9em; padding: 2px; }
        .cpt-pm-search-clear:hover { opacity: 1; }
        .cpt-profiles-row { display: flex; gap: 4px; align-items: center; flex: 1 1 150px; min-width: 0; }
        .cpt-profile-select { flex: 1 1 auto; min-width: 0; font-size: 12px; padding: 3px 6px; }
        .cpt-profile-btn { cursor: pointer; opacity: 0.65; padding: 2px 4px; }
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

/* -- Init -- */

jQuery(async () => {
    console.log('[' + MODULE_NAME + '] Loading...');
    try {
        injectStyles();
        selectedProfile = getSetting('selectedProfile', '');
        resolvePromptManager();

        injectCharPanel();
        injectContextLockToggle();
        setupContextLockGuard();
        waitForPMContainer();

        const { eventSource, event_types } = SillyTavern.getContext();
        const initialCharId = getCurrentCharId();
        if (initialCharId) lastCharId = initialCharId;

        eventSource.on(event_types.CHAT_CHANGED, () => {
            const old = document.getElementById('cpt_char_panel');
            if (old) old.remove();
            const newCharId = getCurrentCharId();
            const shouldRestore = (lastCharId !== null && newCharId !== null && newCharId !== lastCharId);
            if (newCharId !== null) lastCharId = newCharId;
            // Invalidate any in-flight restore retry chain from a previous switch.
            const generation = ++restoreGeneration;

            // Restore toggles ASAP. The API path (getActiveOrder) is DOM-independent,
            // so we don't wait 2s for the UI — the saved prompts snap in right away.
            // A tiny delay lets ST finish switching the active character first.
            if (shouldRestore) setTimeout(() => tryRestore(newCharId, 1, 8, generation), 150);

            // Re-inject our UI (panel, toolbar, lock) — cheap and non-blocking.
            // Debounced/coalesced so rapid chat flips don't pile up work.
            if (chatChangedTimer) clearTimeout(chatChangedTimer);
            chatChangedTimer = setTimeout(() => {
                chatChangedTimer = null;
                injectCharPanel();
                injectContextLockToggle();
                setupContextLockGuard();
                debouncedReinject();
            }, 600);
        });

        if (event_types.OAI_PRESET_CHANGED_AFTER) {
            eventSource.on(event_types.OAI_PRESET_CHANGED_AFTER, () => {
                setTimeout(debouncedReinject, 800);
                setTimeout(() => { injectContextLockToggle(); setupContextLockGuard(); }, 1000);
            });
        }

        console.log('[' + MODULE_NAME + '] Loaded successfully');
    } catch (error) {
        console.error('[' + MODULE_NAME + '] Failed to load:', error);
    }
});
