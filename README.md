# Arc Lite

A Manifest V3 Chromium extension that brings a few of Arc's best touches to any Chromium browser: a floating action bar, a command bar, a customizable start page, and session restore. No build step, no dependencies, just plain JavaScript.

## Screenshots

| Start page | Command bar |
| --- | --- |
| ![Start page](docs/screenshots/start-page.png) | ![Command bar](docs/screenshots/command-bar.png) |

![Start page settings](docs/screenshots/settings.png)

## Features

- **Action bar**: a small capsule pinned to the bottom-left of every page. At rest it carries a live cue for what's running (the focus ring and time, a download's progress, artwork and moving bars for media). Hover it and it opens one card: a home page with a section for everything active, and a detail page for each thing (the full media player, the latest three downloads, the focus controls, snooze), reached with the buttons along the bottom or a sideways swipe. With no click for five seconds, it slides back home. Each card lives in its own file under `buttons/`.
  - **Media**: a mini player for each playing `<video>`/`<audio>` source (play/pause, seek, mute, picture-in-picture, and next/previous on YouTube, YouTube Music and Spotify). It works across frames.
  - **Downloads**: shows the latest download as a chip, with the three most recent downloads on hover. It can hide the browser's native downloads UI. Drag a finished download onto a page to drop it into an upload area (Esc cancels; can be turned off in settings). Chrome shows its "started debugging this browser" banner for a moment while the file is dropped.
  - **Copy URL**: copies the current tab's URL (`Cmd+Shift+C` on Mac, `Ctrl+Shift+C` elsewhere) and shows a toast.
- **Command bar** (`Cmd/Ctrl+Shift+K`, plus a configurable in-page shortcut, default `Cmd/Ctrl+T`): one box that searches open tabs, actions, history, recently closed tabs and the web. It renders as an overlay iframe, or as a popup window on pages where scripts can't run (`chrome://`, the Web Store, PDFs).
- **Start page** (replaces the new tab page): clock, greeting, search box, top sites, a small to-do list, and a background that is a gradient, a solid colour, your own photo, or a daily photo from Bing, Wikipedia, NASA or Picsum.
- **Session restore**: snapshots all windows, tabs and tab groups, and reopens them on browser start if the browser didn't restore them itself.
- **Snooze tabs**: "Snooze tab…" in the command bar (or type `snooze 2h`, `snooze tomorrow 9am`, `snooze fri`) closes the tab now and reopens it later, with a notification, where you left off. Search your snoozed tabs with `snoozed`; Cmd/Ctrl+Backspace drops one. A browser that was closed when one came due reopens it on the next start.
- **Focus mode**: a pomodoro timer (25 minutes of focus, 5 off, a longer break every fourth session; all adjustable) that blocks a list of distracting sites while a focus session runs. The action bar shows the live countdown on its capsule, a row on the home card and a detail page with every control. When a phase ends, the bar opens on its own with a one-click "Start break" or "Start focus" (or turn on auto-start in settings). Pausing, skipping or stopping a focus session takes a 10 second wait, enforced in the service worker. Blocked sites, including tabs already open on them, show a focus page and return to the site when the session ends. Start it from the action bar or the command bar.
- **Settings page**: opened from the toolbar icon (configurable to open the start page or the Downloads folder instead).

## Install

1. Open `chrome://extensions` (or your Chromium browser's equivalent).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this directory.

Requires Chrome 116 or newer. Keyboard shortcuts can be changed at `chrome://extensions/shortcuts`.

## Project layout

| File | Role |
| --- | --- |
| `manifest.json` | Permissions, content scripts, commands, new-tab override |
| `background.js` | Service worker: commands, clipboard, downloads, media routing, daily photo fetch and alarms |
| `session.js` | Session snapshot and restore (loaded into the service worker via `importScripts`) |
| `settings.js` | Shared settings: defaults merged over a single object in `chrome.storage.local`. It is loaded everywhere and safe to inject twice |
| `action-bar.js`, `buttons/*.js` | Action bar host (closed shadow DOM) and the individual buttons |
| `media-agent.js` | Runs in every frame, finds the main media element, reports state and executes controls |
| `command-bar.js`, `commandbar.{html,css,js}` | Command bar trigger/overlay (content script) and the UI (extension page) |
| `newtab.{html,css,js}`, `newtab-boot.js` | Start page. The boot script swaps the browser's new tab for an identical `?f=1` tab so the search box can take focus |
| `prefs.{html,css,js}` | Settings UI |
| `offscreen.{html,js}` | Clipboard fallback for pages that can't be scripted |
| `icons/` | Extension icons and early icon concepts |

## How it works

- **Messaging**: content scripts and extension pages talk to the service worker through `chrome.runtime.sendMessage`. Message types include `media-report`, `media-control`, `get-downloads`, `toggle-command-bar`, `refresh-photo` and `restore-session`.
- **Reload safety**: content scripts detect "orphaned" copies left behind by an extension reload (`chrome.runtime.id` becomes unavailable) and replace or ignore them.
- **Copy URL** runs in the page first (it holds `activeTab`), and falls back to an offscreen document.
- **Daily photo**: the service worker fetches the image, caches it, and refreshes it at midnight using `chrome.alarms`, with retries on failure.

## Permissions

`<all_urls>` is needed for the action bar, media agent and command bar content scripts. Other permissions: `tabs`, `tabGroups`, `sessions`, `history`, `topSites`, `search` and `favicon` (command bar, start page, session restore), `downloads*` (downloads button), `debugger` (only to drop a dragged download onto a page; it is attached for that moment and then released), `offscreen`, `scripting` and `activeTab` (clipboard), `storage` and `unlimitedStorage` (settings, photos, session snapshot), and `alarms` (daily photo, focus timer), `declarativeNetRequest` (focus mode redirects blocked sites), `notifications` (focus phase changes) and `clipboardRead` (command bar paste actions).

Network requests are limited to the daily-photo sources you pick (Bing, Wikimedia, NASA, Picsum), and are sent without credentials. Nothing is sent anywhere else.

## Development

There is no build. Edit the files, then click the reload icon for the extension on `chrome://extensions`. Debug the service worker from its **Inspect views** link, and the settings, start and command-bar pages with normal DevTools.
