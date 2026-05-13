import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Utilities

function formatSpeed(bytesPerSec) {
    if (bytesPerSec >= 1_000_000)
        return `${(bytesPerSec / 1_000_000).toFixed(1)} MB/s`;
    if (bytesPerSec >= 1_000)
        return `${(bytesPerSec / 1_000).toFixed(1)} KB/s`;
    return `${Math.round(bytesPerSec)} B/s`;
}

function readNetStats() {
    const file = Gio.File.new_for_path('/proc/net/dev');
    const [, contents] = file.load_contents(null);
    const text = new TextDecoder().decode(contents);
    const stats = {};
    for (const line of text.split('\n').slice(2)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx === -1) continue;
        const iface = trimmed.slice(0, colonIdx).trim();
        const cols = trimmed.slice(colonIdx + 1).trim().split(/\s+/);
        stats[iface] = {
            rx: parseInt(cols[0], 10), // receive bytes
            tx: parseInt(cols[8], 10), // transmit bytes
        };
    }
    return stats;
}

// Pick the non-loopback interface with the highest cumulative byte count.
// On a typical desktop this is always the single active interface.
function pickInterface(stats) {
    let best = null;
    let bestTotal = -1;
    for (const [iface, {rx, tx}] of Object.entries(stats)) {
        if (iface === 'lo') continue;
        const total = rx + tx;
        if (total > bestTotal) {
            bestTotal = total;
            best = iface;
        }
    }
    return best;
}

// Extension

export default class NetworkSpeedExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        this._label = new St.Label({
            text: '↓ -- ',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);

        // Popup menu items (non-interactive, just display info)
        this._dlItem = new PopupMenu.PopupMenuItem('↓ --', {reactive: false});
        this._ulItem = new PopupMenu.PopupMenuItem('↑ --', {reactive: false});
        this._indicator.menu.addMenuItem(this._dlItem);
        this._indicator.menu.addMenuItem(this._ulItem);

        // Hover: expand/collapse the bar label
        this._indicator.connect('enter-event', () => this._showBoth());
        this._indicator.connect('leave-event', () => this._showDownOnly());

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._dlSpeed = 0;
        this._ulSpeed = 0;
        this._hovering = false;

        // Bootstrap: take an initial reading so the first tick has a valid delta
        this._prevStats = readNetStats();
        this._prevTime = GLib.get_monotonic_time();

        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._prevStats = null;
        this._label = null;
        this._dlItem = null;
        this._ulItem = null;
    }

    _update() {
        const now = GLib.get_monotonic_time(); // microseconds
        const stats = readNetStats();
        const elapsed = (now - this._prevTime) / 1_000_000; // → seconds

        const iface = pickInterface(stats);
        let dlSpeed = 0;
        let ulSpeed = 0;

        if (iface && this._prevStats[iface]) {
            dlSpeed = (stats[iface].rx - this._prevStats[iface].rx) / elapsed;
            ulSpeed = (stats[iface].tx - this._prevStats[iface].tx) / elapsed;
            // Guard against negative deltas (interface counter reset / wrap)
            if (dlSpeed < 0) dlSpeed = 0;
            if (ulSpeed < 0) ulSpeed = 0;
        }

        this._dlSpeed = dlSpeed;
        this._ulSpeed = ulSpeed;

        this._dlItem.label.text = `↓ ${formatSpeed(dlSpeed)}`;
        this._ulItem.label.text = `↑ ${formatSpeed(ulSpeed)}`;

        if (this._hovering)
            this._showBoth();
        else
            this._showDownOnly();

        this._prevStats = stats;
        this._prevTime = now;
    }

    _showDownOnly() {
        this._hovering = false;
        if (this._label)
            this._label.text = `↓ ${formatSpeed(this._dlSpeed)}`;
    }

    _showBoth() {
        this._hovering = true;
        if (this._label)
            this._label.text = `↓ ${formatSpeed(this._dlSpeed)} ↑ ${formatSpeed(this._ulSpeed)}`;
    }
}
