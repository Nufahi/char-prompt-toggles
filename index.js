const MODULE_NAME = 'char-prompt-toggles';
// Legacy localStorage keys. Data now lives in ST's extension settings; these are
// only read once for migration and kept as a write fallback before ST is ready.
const LEGACY_STORAGE_KEY = 'char_prompt_toggles_data';
const LEGACY_SETTINGS_KEY = 'char_prompt_toggles_settings';

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
// The first CHAT_CHANGED after page load is ST restoring the already-open chat,
// NOT a character switch. Seeding lastCharId at init can't detect this because
// ST sets characterId AFTER extensions load, so getCurrentCharId() is still null
// there and the boot event looked like null -> char (a "switch"), which forcibly
// overwrote whatever toggles were live. This flag swallows that one event.
let bootHandled = false;

/* -- Persistence (ST extension settings, with legacy localStorage fallback) -- */

// Root object inside ST's extensionSettings: { data: {...}, settings: {...} }.
// Using ST settings means the data travels with the user profile and survives a
// browser cache wipe, unlike the old localStorage-only storage.
function getExtRoot() {
    try {
        const es = SillyTavern.getContext()?.extensionSettings;
        if (!es) return null;
        if (!es[MODULE_NAME] || typeof es[MODULE_NAME] !== 'object') es[MODULE_NAME] = {};
        const root = es[MODULE_NAME];
        if (!root.data || typeof root.data !== 'object') root.data = {};
        if (!root.settings || typeof root.settings !== 'object') root.settings = {};
        return root;
    } catch (e) { return null; }
}

function persistExtSettings() {
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx?.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
        else if (typeof ctx?.saveSettings === 'function') ctx.saveSettings();
    } catch (e) {}
}

function readLegacy(key) {
    try { const v = JSON.parse(localStorage.getItem(key)); return (v && typeof v === 'object') ? v : null; }
    catch (e) { return null; }
}

// One-shot copy of legacy localStorage content into ST settings. Only fills keys
// that don't exist yet, so it can never clobber newer ST-side data. The legacy
// entries are intentionally left in place as a manual safety net.
let migrationDone = false;
function migrateLegacyStorage() {
    if (migrationDone) return;
    const root = getExtRoot();
    if (!root) return; // ST not ready yet; retry on a later call.
    migrationDone = true;
    if (!root._migrated) {
        const oldData = readLegacy(LEGACY_STORAGE_KEY);
        if (oldData) for (const k of Object.keys(oldData)) if (!(k in root.data)) root.data[k] = oldData[k];
        const oldSettings = readLegacy(LEGACY_SETTINGS_KEY);
        if (oldSettings) for (const k of Object.keys(oldSettings)) if (!(k in root.settings)) root.settings[k] = oldSettings[k];
        root._migrated = true;
        persistExtSettings();
    }
}

function loadSettings() {
    const root = getExtRoot();
    if (root) { migrateLegacyStorage(); return root.settings; }
    return readLegacy(LEGACY_SETTINGS_KEY) || {};
}

function getSetting(key, def) { const s = loadSettings(); return key in s ? s[key] : def; }

function setSetting(key, val) {
    const root = getExtRoot();
    if (root) { migrateLegacyStorage(); root.settings[key] = val; persistExtSettings(); return; }
    const s = readLegacy(LEGACY_SETTINGS_KEY) || {};
    s[key] = val;
    try { localStorage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
}

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
    const root = getExtRoot();
    if (root) { migrateLegacyStorage(); return root.data; }
    return readLegacy(LEGACY_STORAGE_KEY) || {};
}

// loadStorage() returns the live object when ST is ready, so callers that mutate
// it in place are already correct; this just handles the pre-ST fallback and the
// actual persist call.
function saveStorage(data) {
    const root = getExtRoot();
    if (root) {
        migrateLegacyStorage();
        if (data !== root.data) root.data = data;
        persistExtSettings();
        return;
    }
    try { localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
}

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
    // Abort if the active character no longer matches the one we're restoring for.
    if (getCurrentCharId() !== charId) return;
    // An apply is already running — retry shortly instead of dropping the restore,
    // so a fast char switch during an in-flight apply still ends on the right state.
    if (togglesApplyInFlight) {
        if (attempt < maxAttempts) setTimeout(() => tryRestore(charId, attempt + 1, maxAttempts, generation), 200);
        return;
    }

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
    if (!cb) return;
    // Icon already present: still re-apply the lock so it re-enforces after a
    // preset change / re-render replaced the checkbox state under us.
    if (document.getElementById('cpt_lock_context')) { applyContextLock(); return; }
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
        // If locked and something checks it (user click OR ST loading a preset
        // that had it on), revert to unchecked AND re-dispatch change so ST's own
        // handler resets its internal max_context_unlocked flag to false.
        // Without the re-dispatch the checkbox looks off but ST stays "unlocked".
        // The _cptReverting guard prevents infinite re-entry.
        if (isContextLockEnabled() && cb.checked && !cb._cptReverting) {
            cb._cptReverting = true;
            cb.checked = false;
            cb.dispatchEvent(new Event('change', { bubbles: true }));
            cb._cptReverting = false;
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
    if (!list) return;

    // Toolbar survived the re-render (ST replaced only the list node): reuse it
    // instead of rebuilding, so the search text, caret and focus are preserved
    // while the user is typing.
    const existing = document.getElementById(TOOLBAR_ID);
    if (existing) {
        if (existing.nextElementSibling !== list && existing.parentElement === list.parentElement) {
            list.parentElement.insertBefore(existing, list);
        }
        return;
    }

    // Remember whether the search box was focused before a full rebuild.
    const hadFocus = document.activeElement?.id === SEARCH_INPUT_ID;
    const prevCaret = hadFocus ? document.activeElement.selectionStart : null;

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
        input.addEventListener('input', () => { searchQuery = input.value; debouncedSearchFilter(); });
        // Restore focus/caret lost to the rebuild.
        if (hadFocus) {
            input.focus();
            if (prevCaret != null) { try { input.setSelectionRange(prevCaret, prevCaret); } catch (e) {} }
        }
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
    toolbar.querySelector('#cpt_profile_new')?.addEventListener('click', async () => {
        const name = await inputDialog(t('New profile name'));
        if (!name || !name.trim()) return;
        profileSave(name.trim());
        setSelectedProfile(name.trim());
        refreshProfileUI();
    });
    toolbar.querySelector('#cpt_profile_delete')?.addEventListener('click', async () => {
        const name = selectedProfile || document.getElementById('cpt_profile_select')?.value;
        if (!name) return;
        if (!(await confirmDialog(t('Delete profile'), t('Delete profile') + ' "' + name + '"?'))) return;
        profileDelete(name);
    });

    refreshProfileUI();
}

function applySearchFilter() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const q = (searchQuery || '').trim().toLowerCase();
    const rows = list.querySelectorAll('li[data-pm-identifier]');
    if (!q) { rows.forEach(li => { li.style.display = ''; }); return; }
    // Build an identifier -> name lookup ONCE instead of a linear find() per row.
    // On large presets a per-keystroke O(n^2) scan noticeably lagged mobile.
    const nameById = new Map();
    const arr = getPromptsArray();
    if (Array.isArray(arr)) arr.forEach(p => { if (p?.identifier && typeof p.name === 'string') nameById.set(p.identifier, p.name); });
    rows.forEach(li => {
        const id = li.dataset.pmIdentifier;
        const name = (nameById.get(id) ?? getPromptNameFromDOM(li)).toLowerCase();
        li.style.display = name.includes(q) ? '' : 'none';
    });
}

const debouncedSearchFilter = debounce(applySearchFilter, 150);

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
    patchPromptManagerRender();
    return getPromptManager();
}

// The promptManager instance is created asynchronously during ST init, so it may
// still be null right after the module import resolves. Poll briefly until the
// render patch lands, then stop.
function ensureRenderPatch() {
    if (pmRenderPatched) return;
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        if (patchPromptManagerRender() || tries > 60) clearInterval(timer);
    }, 500);
}

/* -- Render coalescing (the main source of toggle lag) -- */

// ST's PromptManager calls this.render() with no argument on every toggle click,
// which means afterTryGenerate === true → tryGenerate() → a full dry-run
// Generate('normal', {}, true): prompt build + world-info scan + token counting.
// On large presets that is seconds of blocking work PER CLICK.
//
// We patch render() itself rather than handleToggle() because handleToggle is
// re-bound to fresh DOM nodes on every render, so a wrapper there is fragile;
// every expensive path funnels through render() regardless of caller.
//
// Behaviour: do the cheap DOM refresh immediately (instant toggle feedback), and
// coalesce the expensive tryGenerate pass into a single trailing run once the
// user stops clicking. Token counts still update, just a beat later.
const HEAVY_RENDER_DELAY = 700;
let pmRenderPatched = false;
let heavyRenderTimer = null;

function patchPromptManagerRender() {
    const pm = getPromptManager();
    if (!pm || pmRenderPatched || typeof pm.render !== 'function' || pm._cptRenderPatched) return false;

    const originalRender = pm.render.bind(pm);
    pm._cptOriginalRender = originalRender;
    pm._cptRenderPatched = true;

    pm.render = function (afterTryGenerate = true) {
        // Explicit cheap render (ours, and some of ST's own calls): pass through.
        // Deliberately does NOT cancel a pending heavy pass — that pass is what
        // refreshes token counts, and cancelling it here would leave them stale.
        if (afterTryGenerate === false) return originalRender(false);
        // Expensive render requested: paint now, defer the dry-run.
        const result = originalRender(false);
        if (heavyRenderTimer) clearTimeout(heavyRenderTimer);
        heavyRenderTimer = setTimeout(() => {
            heavyRenderTimer = null;
            // originalRender is the UNpatched function, so this cannot recurse.
            try { originalRender(true); } catch (e) { console.error('[' + MODULE_NAME + '] deferred render failed:', e); }
        }, HEAVY_RENDER_DELAY);
        return result;
    };

    pmRenderPatched = true;
    console.log('[' + MODULE_NAME + '] PromptManager.render patched (deferred token pass)');
    return true;
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

// Non-blocking text-input dialog via ST's Popup API, with a window.prompt fallback.
async function inputDialog(message, defaultValue) {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.Popup?.show?.input) {
            const res = await ctx.Popup.show.input(message, '', defaultValue || '');
            return (res === null || res === false) ? null : res;
        }
        if (typeof ctx?.callGenericPopup === 'function' && ctx?.POPUP_TYPE) {
            const res = await ctx.callGenericPopup(message, ctx.POPUP_TYPE.INPUT, defaultValue || '');
            return (res === null || res === false) ? null : String(res);
        }
    } catch (e) {}
    return window.prompt(message, defaultValue || '');
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
        // render(false) skips the tryGenerate() dry-run (prompt build + world-info
        // scan + token counting) that makes render() hang for ~20s on big presets.
        // The cheap DOM refresh is all we need after mutating prompts/order.
        if (typeof pm.render === 'function') pm.render(false);
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
        // Remove any lingering prompt_order references in OTHER characters too, so
        // deleting a prompt doesn't leave dangling identifiers behind in settings.
        try {
            const orders = pm.serviceSettings?.prompt_order;
            if (Array.isArray(orders)) {
                orders.forEach(entry => {
                    if (Array.isArray(entry?.order)) {
                        const i = entry.order.findIndex(e => e?.identifier === identifier);
                        if (i !== -1) entry.order.splice(i, 1);
                    }
                });
            }
        } catch (e) {}
        if (Array.isArray(pm.serviceSettings?.prompts)) {
            const idx = pm.serviceSettings.prompts.findIndex(p => p.identifier === identifier);
            if (idx !== -1) pm.serviceSettings.prompts.splice(idx, 1);
        }
        if (typeof pm.saveServiceSettings === 'function') await pm.saveServiceSettings();
        // render(false): skip the expensive tryGenerate() dry-run (see duplicatePrompt).
        if (typeof pm.render === 'function') pm.render(false);
    } catch (e) { console.error('[' + MODULE_NAME + '] delete failed:', e); }
    finally { actionInProgress = false; }
}

// Single delegated listener for ALL row actions, attached once to the list.
// Previously every row got its own two listeners on every re-inject, which on a
// 150-prompt preset meant hundreds of listener attachments after each render.
function setupRowActionDelegation(list) {
    // Flag lives on the node itself: when ST swaps in a fresh list element the
    // new node has no flag, so delegation re-attaches exactly once per node.
    if (!list || list._cptDelegated) return;
    list._cptDelegated = true;
    list.addEventListener('click', (ev) => {
        const action = ev.target.closest('.cpt-row-action');
        if (!action || !list.contains(action)) return;
        const li = action.closest('li[data-pm-identifier]');
        const id = li?.dataset.pmIdentifier;
        if (!id) return;
        ev.stopPropagation();
        ev.preventDefault();
        if (action.classList.contains('cpt-row-duplicate')) duplicatePrompt(id);
        else if (action.classList.contains('cpt-row-delete')) deletePromptById(id);
    });
}

function injectRowActions() {
    const list = document.getElementById(PM_LIST_ID);
    if (!list) return;
    const t = getTranslator();

    setupRowActionDelegation(list);

    // Token count spans overlap toggle buttons on mobile — disable their pointer events
    // (same fix as 预设条目更多按钮)
    list.querySelectorAll('.prompt_manager_prompt_tokens').forEach(el => {
        el.style.pointerEvents = 'none';
    });

    // One combined query per row instead of six separate querySelector calls.
    const dupTitle = t('Duplicate');
    const delTitle = t('Delete');
    list.querySelectorAll('li.completion_prompt_manager_prompt[data-pm-identifier]').forEach(li => {
        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls || controls.querySelector('.cpt-row-actions')) return;

        const nameEl = li.querySelector(':scope > .completion_prompt_manager_prompt_name');
        if (!nameEl) return;
        // Classify the row from a single pass over its marker icons.
        let isUser = false, isInjection = false, isSystem = false, skip = false;
        nameEl.querySelectorAll('.fa-thumb-tack, .fa-star, .fa-asterisk, .fa-syringe, .fa-square-poll-horizontal')
            .forEach(icon => {
                const cl = icon.classList;
                if (cl.contains('fa-thumb-tack') || cl.contains('fa-star')) skip = true;
                else if (cl.contains('fa-asterisk')) isUser = true;
                else if (cl.contains('fa-syringe')) isInjection = true;
                else if (cl.contains('fa-square-poll-horizontal')) isSystem = true;
            });
        if (skip || (!isUser && !isInjection && !isSystem)) return;

        // Build in one string; clicks are handled by the delegated listener above.
        const wrap = document.createElement('span');
        wrap.className = 'cpt-row-actions';
        wrap.innerHTML =
            '<span class="cpt-row-action cpt-row-duplicate fa-solid fa-copy fa-xs" title="' + escapeHtml(dupTitle) + '"></span>' +
            (isSystem ? '' : '<span class="cpt-row-action cpt-row-delete fa-solid fa-trash fa-xs caution" title="' + escapeHtml(delTitle) + '"></span>');
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
        ensureRenderPatch();

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

            // Restore ONLY on a genuine character -> different character switch.
            //   * bootHandled: the first CHAT_CHANGED is ST restoring the open chat
            //     on page load, never a switch. Swallow it so a reload never
            //     overwrites toggles the user tweaked ad-hoc.
            //   * lastCharId !== null: going from "no character" into a character
            //     (fresh boot into an empty chat, then opening a card) is also not a
            //     switch — leave whatever is currently set alone.
            // Anything that isn't a real switch does zero restore work.
            const isBoot = !bootHandled;
            bootHandled = true;
            const shouldRestore = !isBoot
                && newCharId !== null
                && lastCharId !== null
                && newCharId !== lastCharId;
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
