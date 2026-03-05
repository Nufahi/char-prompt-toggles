# Per-Character Prompt Toggles

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that remembers prompt toggle states per character.

## What it does

When you toggle prompt entries on/off in Prompt Manager, this extension saves that configuration for the current character. Switching to another character and back will automatically restore the saved toggle states.

## Installation

### Via SillyTavern

1. Open SillyTavern
2. Go to Extensions > Install Extension
3. Paste this URL: `https://github.com/Nufahi/ST-PerCharPromptToggles`
4. Click Install
5. Refresh the page

### Manual

1. Clone or download this repository
2. Place the folder in `SillyTavern/data/default-user/extensions/third-party/char-prompt-toggles`
3. Refresh SillyTavern

## Usage

1. Open a character card -- you will see the **Prompt Toggles** panel above Creator's Notes
2. Open Prompt Manager and configure your toggles
3. Press **Save** in the Prompt Toggles panel
4. Switch to another character, configure toggles differently, Save again
5. When you switch back, toggles are automatically restored

## Features

- Save prompt toggle states per character
- Auto-restore on character switch (when Prompt Manager is open)
- Localization support (English, Russian)
- Minimal UI integrated into the character card

## Localization

The extension supports `data-i18n` attributes and includes a Russian locale. To add more languages, create a JSON file in the `locales/` folder following the `ru-ru.json` format.

## License

MIT
