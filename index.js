const MODULE_NAME = 'char-prompt-toggles';
const STORAGE_KEY = 'char_prompt_toggles_data';

let lastCharId = null;

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

jQuery(async () => {
    console.log('[' + MODULE_NAME + '] Loading...');

    try {
        const observer = new MutationObserver(() => { injectCharPanel(); });
        observer.observe(document.body, { childList: true, subtree: true });
        injectCharPanel();

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
