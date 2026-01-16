# Calendar Slots Picker

A Chrome extension that allows you to select multiple time slots from Google Calendar and copy them to your clipboard in a formatted manner for emails.

## Features

- **Multi-slot Selection**: Click on calendar time slots to select multiple availability windows
- **Visual Feedback**: Selected slots are highlighted with a blue overlay
- **Side Panel UI**: View and manage selected slots in a convenient side panel
- **Multiple Output Formats**:
  - Bullet list
  - Numbered list
  - Prose (natural sentence format)
- **One-click Copy**: Copy formatted availability to clipboard instantly
- **Keyboard Shortcuts**:
  - `Alt + S`: Toggle selection mode
  - `Esc`: Exit selection mode

## Installation

### Developer Mode (Recommended for testing)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked"
5. Select the `calendar-overlay` folder
6. The extension icon will appear in your toolbar

## Usage

1. **Navigate to Google Calendar** at [calendar.google.com](https://calendar.google.com)
2. **Click the extension icon** in your toolbar to open the side panel
3. **Click "Start Selecting"** to enter selection mode
4. **Click on time slots** in your calendar to select them
   - Click again on a selected slot to deselect it
   - Selected slots will be highlighted in blue
5. **Choose your preferred format** (bullet, numbered, or prose)
6. **Click "Copy to Clipboard"** to copy the formatted text
7. **Paste into your email** and send!

## Example Output

### Bullet List Format
```
I'm available at the following times:

Monday, January 20, 2025
  - 9:00 AM - 10:00 AM
  - 2:00 PM - 3:00 PM

Tuesday, January 21, 2025
  - 10:00 AM - 11:00 AM

Please let me know which time works best for you!
```

### Numbered List Format
```
I'm available at the following times:

1. Monday, January 20, 2025, 9:00 AM - 10:00 AM
2. Monday, January 20, 2025, 2:00 PM - 3:00 PM
3. Tuesday, January 21, 2025, 10:00 AM - 11:00 AM

Please let me know which option works best for you!
```

### Prose Format
```
I'm available on Monday, Jan 20 9:00 AM - 10:00 AM or 2:00 PM - 3:00 PM, or on Tuesday, Jan 21 10:00 AM - 11:00 AM. Let me know what works best for you!
```

## File Structure

```
calendar-overlay/
├── manifest.json       # Chrome extension manifest (v3)
├── background.js       # Service worker for extension lifecycle
├── content.js          # Script injected into Google Calendar
├── content.css         # Styles for selection highlighting
├── sidepanel.html      # Side panel UI
├── sidepanel.js        # Side panel logic
├── icons/
│   └── icon.svg        # Extension icon source
└── README.md           # This file
```

## Adding Custom Icons

To add custom icons:

1. Create PNG icons in the following sizes:
   - `icons/icon16.png` (16x16)
   - `icons/icon48.png` (48x48)
   - `icons/icon128.png` (128x128)

2. Update `manifest.json` to include:
```json
"action": {
  "default_title": "Calendar Slots Picker",
  "default_icon": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
},
"icons": {
  "16": "icons/icon16.png",
  "48": "icons/icon48.png",
  "128": "icons/icon128.png"
}
```

You can convert the included `icons/icon.svg` to PNG using tools like:
- [SVG to PNG converter](https://svgtopng.com/)
- ImageMagick: `convert -background none icon.svg -resize 128x128 icon128.png`

## Browser Compatibility

- Chrome 114+ (required for Side Panel API)
- Edge 114+ (Chromium-based)

## Permissions

The extension requires the following permissions:
- `sidePanel`: To display the side panel UI
- `storage`: To persist settings (future use)
- `activeTab`: To interact with the current tab
- Host permission for `calendar.google.com`: To detect and highlight time slots

## Known Limitations

- Works best in Week and Day views
- Time slot detection relies on Google Calendar's DOM structure, which may change
- Scrolling or resizing the calendar may clear visual highlights (slots remain selected)

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License - feel free to use and modify as needed.
