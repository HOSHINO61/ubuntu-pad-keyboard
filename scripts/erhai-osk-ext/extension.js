// erhai-osk -- on-screen keyboard as a GNOME Shell extension.
//
// Why an extension: GNOME/mutter refuses third-party input injection (no
// zwp_virtual_keyboard, no wlr-layer-shell), and any normal window steals
// keyboard focus when tapped.  A shell extension has neither problem:
//   * Clutter.VirtualInputDevice injects keys *inside* the compositor
//   * its UI is a shell chrome actor, not a window -- it never takes focus
//
// Layout is PC-style: number row with shifted glyphs, sticky modifiers (a touch
// screen cannot hold a key down), arrows, Esc/Tab/Del/Enter.  Sized large for
// elderly users: 24px glyphs, 64px letter keys.
//
// API lessons baked in (GNOME 50.1 -- all learned the hard way):
//   * Main.layoutManager.addTopChrome() rejects 'affectsInputRegion'.
//     A rejected param still adds the actor half-configured and wrecks the
//     session, so call it with NO params at all.
//   * Position with set_translation() over a BinLayout, never set_position()
//     with a fixed layout.
//   * GType names are unique per process: register the Quick Settings classes
//     once at module scope, not on every enable().
//   * notify_keyval(keysym) does NOT apply the shift level: passing the keysym
//     for '!' typed '1'.  Shifted glyphs must be emitted as the base key plus a
//     real Shift press.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const XK = {
    Escape: 0xff1b,
    Tab: 0xff09,
    Return: 0xff0d,
    BackSpace: 0xff08,
    Delete: 0xffff,
    space: 0x20,
    Left: 0xff51,
    Up: 0xff52,
    Right: 0xff53,
    Down: 0xff54,
    Shift_L: 0xffe1,
    Control_L: 0xffe3,
    Alt_L: 0xffe9,
    Super_L: 0xffeb,
};

const POS_FILE = 'erhai-osk/position.kf';

// Hold-to-repeat: every character key repeats while held, plus the keys people
// actually hold down.  Sticky modifiers, shift, symbol and the IME key never
// repeat -- repeating those would arm a modifier or a chord by accident.
const REPEATABLE = new Set([XK.BackSpace, XK.Left, XK.Up, XK.Right, XK.Down]);
const REPEAT_DELAY_MS = 620;      // ignore a normal tap
const REPEAT_INTERVAL_MS = 125;   // ~8/s while getting going
const REPEAT_FAST_MS = 60;        // ~17/s once it is clearly deliberate
// Shared on/off state: the app launcher writes it, the extension watches it, so
// the Quick Settings switch and the PAD-OSK icon act on the SAME axis.
const STATE_FILE = 'erhai-osk/visible';

// ---- styling ---------------------------------------------------------
// Sized for older eyes and unsteady fingers: large glyphs, tall keys and a
// brighter, higher-contrast palette than a typical desktop theme.
//
// Every dimension below is written for the *medium* size and multiplied by a
// per-size scale factor, so the three sizes stay proportional instead of
// drifting apart.  See SIZE_STEPS / _setSize().
const COLORS = {
    key: 'background-color: #4a4e53; color: #ffffff;',
    mod: 'background-color: #5a5f65; color: #ffdc8a;',
    act: 'background-color: #54595f; color: #b9e4e6;',
    on: 'background-color: #ffd479; color: #1e2022;',
};

// Three sizes, picked from the grip bar.  Measured on this tablet (1696px-wide
// logical screen, logged by _reflow):
//
//     scale 0.72 -> 927x349  (55%)
//     scale 0.85 -> 1120x421 (66%)
//     scale 0.99 -> 1295x491 (76%)
//
// The panel grows roughly linearly with the factor, but not exactly: at some
// sizes a text label ('Shift', 'Ctrl') is wider than the key's min-width and
// pushes the row out, so the proportions drift by a couple of percent.  Tune
// against the logged numbers, not against a formula.
//
// The 1.00 design baseline stays in the px values; the steps just sit around
// it.  Earlier attempts used 1310px from the design notes as the panel width at
// 1.00 and came out one size too wide everywhere.
// ~/.config/erhai-osk/position.kf ([layout] scale_small= / scale_medium= /
// scale_large=) can override all three, so tuning needs neither a rebuild nor
// a re-login.
const SIZE_STEPS = [
    {name: 'small', label: '小', scale: 0.72},
    {name: 'medium', label: '中', scale: 0.85},
    {name: 'large', label: '大', scale: 0.99},
];
const DEFAULT_SIZE = 'medium';
const SCALE_MIN = 0.40;
const SCALE_MAX = 2.00;

function findStep(steps, name) {
    return steps.find(s => s.name === name) ?? steps[1];
}

// Whole pixels only: fractional sizes give blurry glyphs in St.
const px = (value, scale) => `${Math.max(1, Math.round(value * scale))}px`;

function keyStyle(kind, minWidth, scale = 1) {
    return `${COLORS[kind]} border-radius: ${px(8, scale)};`
        + ` padding: ${px(14, scale)} ${px(6, scale)};`
        + ` margin: ${px(3, scale)};`
        + ` font-size: ${px(24, scale)};`
        + ` min-width: ${px(minWidth, scale)};`;
}

const boxStyle = scale =>
    'background-color: rgba(18,20,22,0.97);'
    + ` border-radius: ${px(16, scale)}; padding: ${px(10, scale)};`;

const gripStyle = scale =>
    'background-color: #33373b; color: #b0b8c0;'
    + ` border-radius: ${px(10, scale)};`
    + ` padding: ${px(8, scale)} ${px(20, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(17, scale)};`;

const gripBtnStyle = scale =>
    'background-color: #474c52; color: #ffd479;'
    + ` border-radius: ${px(8, scale)};`
    + ` padding: ${px(5, scale)} ${px(20, scale)};`
    + ` margin: ${px(3, scale)} ${px(3, scale)} ${px(3, scale)} ${px(12, scale)};`
    + ` font-size: ${px(22, scale)};`;

const closeBtnStyle = scale =>
    'background-color: #553a3a; color: #ffabab;'
    + ` border-radius: ${px(8, scale)};`
    + ` padding: ${px(5, scale)} ${px(20, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(22, scale)};`;

// The size selector reads as a segmented control: the active step is filled,
// the other two stay quiet so they never compete with the keys.
const sizeBtnStyle = (active, scale) =>
    `background-color: ${active ? '#ffd479' : '#3c4147'};`
    + ` color: ${active ? '#1e2022' : '#c9d1d9'};`
    + ` border-radius: ${px(8, scale)};`
    + ` padding: ${px(5, scale)} ${px(16, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(20, scale)};`;

const shiftGlyphStyle = (on, scale) =>
    `color: ${on ? '#ffffff' : '#a8b0b8'}; font-size: ${px(15, scale)};`;

// ---- key descriptors -------------------------------------------------
const ch = (base, shifted, minW = 64) => ({base, shifted, minW, kind: 'key'});
const act = (label, keysym, minW = 82) => ({label, keysym, minW, kind: 'act'});
const md = (label, name, minW = 82) => ({label, mod: name, minW, kind: 'mod'});
// Input-method switch: emits Super+Space, which GNOME maps to "switch input
// source" (xkb:us <-> ibus:libpinyin).  Saved from accidental Super+Space.
const ime = (minW = 96) => ({label: '中/英', ime: true, minW, kind: 'mod'});

const LAYOUT = [
    [
        act('Esc', XK.Escape, 88),
        ch('`', '~'), ch('1', '!'), ch('2', '@'), ch('3', '#'), ch('4', '$'),
        ch('5', '%'), ch('6', '^'), ch('7', '&'), ch('8', '*'), ch('9', '('),
        ch('0', ')'), ch('-', '_'), ch('=', '+'),
        act('⌫', XK.BackSpace, 100),
    ],
    [
        act('Tab', XK.Tab, 96),
        ch('q'), ch('w'), ch('e'), ch('r'), ch('t'), ch('y'), ch('u'), ch('i'),
        ch('o'), ch('p'), ch('[', '{'), ch(']', '}'), ch('\\', '|'),
        act('Del', XK.Delete, 88),
    ],
    [
        md('Caps', 'caps', 108),
        ch('a'), ch('s'), ch('d'), ch('f'), ch('g'), ch('h'), ch('j'), ch('k'),
        ch('l'), ch(';', ':'), ch("'", '"'),
        act('⏎', XK.Return, 136),
    ],
    [
        md('Shift', 'shift', 120),
        ch('z'), ch('x'), ch('c'), ch('v'), ch('b'), ch('n'), ch('m'),
        ch(',', '<'), ch('.', '>'), ch('/', '?'),
        act('↑', XK.Up, 86),
        md('Shift', 'shift', 120),
    ],
    [
        md('Ctrl', 'ctrl'), md('Alt', 'alt'), md('⊞', 'super'),
        act('␣', XK.space, 340),
        ime(),
        md('Ctrl', 'ctrl'),
        act('←', XK.Left, 82), act('↓', XK.Down, 82), act('→', XK.Right, 82),
    ],
];

// Quick Settings classes: registered once per process (see note at the top).
let _qsClasses = null;

function makeQsClasses(QS) {
    if (_qsClasses)
        return _qsClasses;

    const OskToggle = GObject.registerClass({
        GTypeName: 'ErhaiOskToggle',
    }, class OskToggle extends QS.QuickToggle {
        _init(kbd) {
            super._init({
                title: '屏幕键盘',
                iconName: 'input-keyboard-symbolic',
                toggleMode: true,
                checked: !kbd._hidden,
            });
            this._kbd = kbd;
            this.connect('notify::checked', () => {
                if (this._kbd)
                    this._kbd._setVisible(this.checked);
            });
        }
    });

    const OskIndicator = GObject.registerClass({
        GTypeName: 'ErhaiOskIndicator',
    }, class OskIndicator extends QS.SystemIndicator {
        _init(kbd) {
            super._init();
            this.quickSettingsItems.push(new OskToggle(kbd));
        }

        destroy() {
            this.quickSettingsItems.forEach(item => item.destroy());
            this.quickSettingsItems = [];
            super.destroy();
        }
    });

    _qsClasses = {OskToggle, OskIndicator};
    return _qsClasses;
}

export default class ErhaiOSK extends Extension {
    enable() {
        log('erhai-osk: v14 enable (sizes, in-place visuals, shifted symbols)');
        try {
            const seat = this._makeSeat();
            if (!seat) {
                log('erhai-osk: no Clutter seat');
                return;
            }
            this._vdev = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);

            // one-shot / latching key state
            this._shift = false;
            this._caps = false;
            this._mods = {ctrl: false, alt: false, super: false};
            // hold-to-repeat state
            this._repeatFire = null;
            this._repeatCount = 0;
            this._repeatDelayId = 0;
            this._repeatTimerId = 0;
            this._repeatStageId = 0;

            // Widget references so state changes update labels/styles IN PLACE.
            // Rebuilding the rows caused a stray character: destroy+recreate
            // between a touch press and its release can deliver the release to
            // a different button, which then fires 'clicked'.
            this._letterKeys = [];
            this._shiftGlyphs = [];
            this._modButtons = [];
            // Every button keeps its descriptor so a size change can restyle it
            // in place (rebuilding would re-deliver an in-flight touch).
            this._styledKeys = [];
            this._sizeBtns = {};

            // Restore the size before the rows are built, so the very first
            // allocation is already the right size (no visible jump).
            const cfg = this._loadConfig();
            this._steps = this._readScales(cfg);
            this._sizeName = cfg && this._steps.some(s => s.name === cfg.size)
                ? cfg.size : DEFAULT_SIZE;
            this._scale = findStep(this._steps, this._sizeName).scale;
            this._savedConfig = cfg;

            this._hidden = false;
            this._hiddenByModal = false;
            this._placed = false;
            this._dragging = false;
            this._grabId = 0;
            this._posX = 0;
            this._posY = 0;

            this._container = new St.Widget({
                reactive: false,
                x_expand: true,
                y_expand: true,
                layout_manager: new Clutter.BinLayout(),
            });

            this._box = new St.BoxLayout({
                vertical: true,
                style: boxStyle(this._scale),
                reactive: true,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.START,
            });

            this._buildGrip();
            this._rowsBox = new St.BoxLayout({vertical: true, reactive: false});
            this._buildRows();
            this._box.add_child(this._rowsBox);

            this._container.add_child(this._box);

            // No params: GNOME 50 rejects 'affectsInputRegion'.
            Main.layoutManager.addTopChrome(this._container);

            this._box.connect('notify::allocation',
                this._onAllocation.bind(this));
            this._placeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700,
                () => {
                    this._placeTimeoutId = 0;
                    this._placeIfNeeded();
                    return GLib.SOURCE_REMOVE;
                });

            this._monitorId = Main.layoutManager.connect('monitors-changed',
                this._onMonitorsChanged.bind(this));

            this._watchStateFile();
            this._watchModalDialogs();

            this._indicator = null;
            this._qsToggle = null;
            import('resource:///org/gnome/shell/ui/quickSettings.js')
                .then(QS => this._addQuickSettings(QS))
                .catch(e => log(`erhai-osk: quick settings unavailable: ${e}`));

            log('erhai-osk: v14 enabled');
        } catch (e) {
            log(`erhai-osk: v14 enable failed: ${e}`);
        }
    }

    disable() {
        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (e) {
                log(`erhai-osk: indicator destroy failed: ${e}`);
            }
            this._indicator = null;
            this._qsToggle = null;
        }
        if (this._placeTimeoutId) {
            GLib.source_remove(this._placeTimeoutId);
            this._placeTimeoutId = 0;
        }
        if (this._dragTimeoutId) {
            GLib.source_remove(this._dragTimeoutId);
            this._dragTimeoutId = 0;
        }
        if (this._grabId) {
            global.stage.disconnect(this._grabId);
            this._grabId = 0;
        }
        if (this._stateMonitorId) {
            this._stateMonitor.disconnect(this._stateMonitorId);
            this._stateMonitorId = 0;
        }
        this._stateMonitor = null;
        if (this._modalPollId) {
            GLib.source_remove(this._modalPollId);
            this._modalPollId = 0;
        }
        if (this._monitorId) {
            Main.layoutManager.disconnect(this._monitorId);
            this._monitorId = 0;
        }
        if (this._container) {
            Main.layoutManager.removeChrome(this._container);
            this._container.destroy();
            this._container = null;
        }
        this._box = null;
        this._grip = null;
        this._rowsBox = null;
        this._letterKeys = [];
        this._shiftGlyphs = [];
        this._modButtons = [];
        this._styledKeys = [];
        this._sizeBtns = {};
        this._savedConfig = null;
        this._repeatCancel();
        this._vdev = null;
        log('erhai-osk: v14 disabled');
    }

    _makeSeat() {
        const tries = [
            () => Clutter.get_default_backend().get_default_seat(),
            () => global.backend.get_default_seat(),
            () => global.stage.context.get_backend().get_default_seat(),
        ];
        for (const fn of tries) {
            try {
                const seat = fn();
                if (seat)
                    return seat;
            } catch (e) { /* try next */ }
        }
        return null;
    }

    _addQuickSettings(QS) {
        try {
            if (!this._box)
                return;         // disabled before the import resolved
            const {OskIndicator} = makeQsClasses(QS);
            this._indicator = new OskIndicator(this);
            this._qsToggle = this._indicator.quickSettingsItems[0];
            Main.panel.statusArea.quickSettings.addExternalIndicator(
                this._indicator);
            log('erhai-osk: quick settings toggle added');
        } catch (e) {
            log(`erhai-osk: quick settings toggle failed: ${e}`);
            if (this._indicator) {
                try {
                    this._indicator.destroy();
                } catch (_) { /* already gone */ }
            }
            this._indicator = null;
            this._qsToggle = null;
        }
    }

    // ---- grip bar ----------------------------------------------------
    _buildGrip() {
        this._grip = new St.BoxLayout({
            style: gripStyle(this._scale),
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._dragArea = new St.BoxLayout({reactive: true, x_expand: true});
        this._dragArea.add_child(new St.Label({
            text: '⠿  拖动',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._dragArea.connect('button-press-event', this._onGripPress.bind(this));
        this._dragArea.connect('touch-event', this._onGripTouch.bind(this));
        this._grip.add_child(this._dragArea);

        // 小 / 中 / 大 -- a segmented control, the active step filled.
        for (const step of this._steps) {
            const btn = new St.Button({
                child: new St.Label({
                    text: step.label,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: sizeBtnStyle(step.name === this._sizeName, this._scale),
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', () => this._setSize(step.name));
            this._grip.add_child(btn);
            this._sizeBtns[step.name] = btn;
        }

        this._collapseBtn = new St.Button({
            child: new St.Label({text: '⌄', y_align: Clutter.ActorAlign.CENTER}),
            style: gripBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._collapseBtn.connect('clicked', () => this._toggleCollapse());
        this._grip.add_child(this._collapseBtn);

        this._closeBtn = new St.Button({
            child: new St.Label({text: '✕', y_align: Clutter.ActorAlign.CENTER}),
            style: closeBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._closeBtn.connect('clicked', () => this._setVisible(false));
        this._grip.add_child(this._closeBtn);

        this._box.add_child(this._grip);
    }

    // ---- size (小 / 中 / 大) -----------------------------------------
    // Restyle in place -- the rows are never rebuilt, so a touch that is down
    // while the size changes still lands on the button it started on.
    _setSize(name) {
        // Re-read the overrides on every click, so editing the KeyFile is
        // enough to retune the factors -- no rebuild, no re-login.
        this._steps = this._readScales();
        if (!this._steps.some(s => s.name === name))
            return;
        const step = findStep(this._steps, name);
        // Same step *and* same factor: nothing to do.  A retuned factor for
        // the step already in use still gets applied, on the next click.
        if (name === this._sizeName && step.scale === this._scale)
            return;

        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._sizeName = name;
        this._scale = step.scale;
        this._applyScale();
        this._saveConfig();
        log(`erhai-osk: size -> ${name} (scale ${this._scale})`);

        // Keep the bottom edge where it is: the panel grows upward instead of
        // pushing itself off the bottom of the screen.
        this._reflow(oldHeight);
    }

    // SIZE_STEPS defaults with the file's [layout] scale_small= / scale_large=
    // layered on top, clamped to something that cannot destroy the layout.
    _readScales(cfg = null) {
        const conf = cfg ?? this._loadConfig();
        const steps = SIZE_STEPS.map(s => ({...s}));
        for (const step of steps) {
            const raw = conf ? conf[`scale_${step.name}`] : null;
            if (typeof raw === 'number' && raw >= SCALE_MIN && raw <= SCALE_MAX)
                step.scale = Math.round(raw * 100) / 100;
        }
        return steps;
    }

    // Re-place the panel after its height changed, keeping the bottom edge put.
    _reflow(oldHeight) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._box)
                return GLib.SOURCE_REMOVE;
            // Before the first placement _posX/_posY are still 0,0; moving and
            // persisting here would overwrite the remembered position with the
            // top-left corner.  Let _placeIfNeeded() do the first one.
            if (!this._placed)
                return GLib.SOURCE_REMOVE;
            const [width, newHeight] = this._box.get_size();
            this._applyPosition(this._posX, this._posY + (oldHeight - newHeight));
            // Clamping may have moved us; persist whatever is now on screen.
            this._saveConfig();
            // Printed so the size can be checked against the screen without a
            // screenshot: percentage of the monitor width is what we tune for.
            const mon = Main.layoutManager.primaryMonitor;
            const pct = mon ? Math.round(width / mon.width * 100) : 0;
            log(`erhai-osk: panel ${width}x${newHeight} `
                + `(${pct}% of ${mon ? mon.width : 0}px, step ${this._sizeName} `
                + `scale ${this._scale})`);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyScale() {
        const s = this._scale;
        if (this._box)
            this._box.style = boxStyle(s);
        if (this._grip)
            this._grip.style = gripStyle(s);
        if (this._collapseBtn)
            this._collapseBtn.style = gripBtnStyle(s);
        if (this._closeBtn)
            this._closeBtn.style = closeBtnStyle(s);
        for (const {btn, kind, minW, mod} of this._styledKeys) {
            const active = mod ? this._modActive(mod) : false;
            btn.style = keyStyle(active ? 'on' : kind, minW, s);
        }
        for (const glyph of this._shiftGlyphs)
            glyph.style = shiftGlyphStyle(this._shift, s);
        this._updateSizeButtons();
    }

    _updateSizeButtons() {
        for (const step of this._steps) {
            const btn = this._sizeBtns[step.name];
            if (btn)
                btn.style = sizeBtnStyle(step.name === this._sizeName, this._scale);
        }
    }

    // ---- key rows ----------------------------------------------------
    _buildRows() {
        for (const row of LAYOUT) {
            const r = new St.BoxLayout({
                reactive: false,
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const def of row)
                r.add_child(this._key(def));
            this._rowsBox.add_child(r);
        }
    }

    _key(def) {
        if (def.kind === 'key')
            return this._charKey(def);
        return this._plainKey(def);
    }

    _charKey(def) {
        const upperCaseLetter = /^[a-z]$/.test(def.base);
        const shiftedGlyph = def.shifted
            ?? (upperCaseLetter ? def.base.toUpperCase() : null);

        const content = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
        });

        // Shifted glyph sits above the base glyph, like a hardware keycap.
        if (shiftedGlyph && !upperCaseLetter) {
            const glyphLabel = new St.Label({
                text: shiftedGlyph,
                style: shiftGlyphStyle(false, this._scale),
                x_align: Clutter.ActorAlign.CENTER,
            });
            content.add_child(glyphLabel);
            this._shiftGlyphs.push(glyphLabel);
        }

        const uppercaseNow = upperCaseLetter && (this._caps !== this._shift);
        const mainLabel = new St.Label({
            text: uppercaseNow ? def.base.toUpperCase() : def.base,
            x_align: Clutter.ActorAlign.CENTER,
        });
        content.add_child(mainLabel);
        if (upperCaseLetter)
            this._letterKeys.push({def, label: mainLabel});

        const btn = new St.Button({
            child: content,
            style: keyStyle('key', def.minW, this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        // Letters, digits and symbols all repeat while held.  A closure per key
        // so the repeat honours caps/shift exactly like a single tap does.
        this._attachRepeat(btn, () => this._emitChar(def));
        this._styledKeys.push({btn, kind: 'key', minW: def.minW, mod: null});
        return btn;
    }

    _plainKey(def) {
        const active = def.mod && this._modActive(def.mod);
        const style = keyStyle(active ? 'on' : def.kind, def.minW, this._scale);

        const btn = new St.Button({
            child: new St.Label({
                text: def.label,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style,
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._styledKeys.push({
            btn, kind: def.kind, minW: def.minW, mod: def.mod ?? null,
        });

        if (def.ime) {
            btn.connect('clicked', () => this._toggleIme());
        } else if (def.mod) {
            this._modButtons.push({name: def.mod, btn, minW: def.minW});
            btn.connect('clicked', () => this._toggleMod(def.mod));
        } else if (def.keysym !== undefined) {
            if (REPEATABLE.has(def.keysym)) {
                // Erase and the arrows: held keys repeat, like a real keyboard.
                this._attachRepeat(btn, () => this._emit(def.keysym, false));
            } else {
                btn.connect('clicked', () => this._emit(def.keysym, false));
            }
        }
        return btn;
    }

    // ---- hold-to-repeat (⌫ and the arrow keys) ------------------------
    // The first key goes out on press so a quick tap feels immediate; further
    // repeats wait out a delay, then speed up.  Release, a stage-level backstop
    // and hiding the panel all cancel the timer, so a key can never keep firing
    // after the finger is gone.
    _attachRepeat(btn, fire) {
        btn.connect('button-press-event', () => {
            this._repeatStart(fire);
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('button-release-event', () => {
            this._repeatEnd();
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('touch-event', (_actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN)
                this._repeatStart(fire);
            else if (type === Clutter.EventType.TOUCH_END
                     || type === Clutter.EventType.TOUCH_CANCEL)
                this._repeatEnd();
            return Clutter.EVENT_PROPAGATE;
        });
        // St.Button drives touch through an internal click gesture, and once
        // that gesture owns the sequence the actor stops seeing the release --
        // 'clicked' is the release signal we actually get, so the key itself
        // goes out on press and a tap's only remaining job is to stop the timer.
        btn.connect('clicked', () => this._repeatEnd());
    }

    _repeatStart(fire) {
        // A touch press arrives as both a touch-event and an emulated
        // button-press; the second must not restart and re-send the key.
        if (this._repeatFire)
            return;
        this._repeatFire = fire;
        this._repeatCount = 0;
        this._repeatEmit();
        this._backstopRelease();
        this._repeatDelayId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, REPEAT_DELAY_MS, () => {
                this._repeatDelayId = 0;
                this._repeatTick();
                return GLib.SOURCE_REMOVE;
            });
    }

    _repeatEnd() {
        if (!this._repeatFire)
            return;
        this._repeatCancel();
    }

    _repeatEmit() {
        if (!this._repeatFire || !this._vdev)
            return;
        this._repeatFire();
    }

    _repeatTick() {
        if (!this._repeatFire)
            return;
        this._repeatEmit();
        this._repeatCount++;
        const interval = this._repeatCount > 10
            ? REPEAT_FAST_MS : REPEAT_INTERVAL_MS;
        this._repeatTimerId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, interval, () => {
                this._repeatTimerId = 0;
                this._repeatTick();
                return GLib.SOURCE_REMOVE;
            });
    }

    // Last line of defence: the button may never see the release (a finger
    // that slides off, or a sequence the click gesture swallowed), so watch the
    // whole stage for it.  Without this a held key would repeat forever.
    _backstopRelease() {
        if (this._repeatStageId)
            return;
        this._repeatStageId = global.stage.connect('captured-event',
            (_actor, event) => {
                const type = event.type();
                if (type === Clutter.EventType.BUTTON_RELEASE
                    || type === Clutter.EventType.TOUCH_END
                    || type === Clutter.EventType.TOUCH_CANCEL)
                    this._repeatEnd();
                return Clutter.EVENT_PROPAGATE;
            });
    }

    _repeatCancel() {
        this._repeatFire = null;
        this._repeatCount = 0;
        for (const id of [this._repeatDelayId, this._repeatTimerId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._repeatDelayId = 0;
        this._repeatTimerId = 0;
        if (this._repeatStageId) {
            global.stage.disconnect(this._repeatStageId);
            this._repeatStageId = 0;
        }
    }

    // Super+Space: GNOME's "switch input source" (us <-> libpinyin).  Sent as a
    // real chord rather than going through the sticky-modifier path, so it can
    // never leave Super armed for the next key.
    _toggleIme() {
        if (!this._vdev)
            return;
        const t = Clutter.get_current_event_time();
        this._vdev.notify_keyval(t, XK.Super_L, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, XK.space, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, XK.space, Clutter.KeyState.RELEASED);
        this._vdev.notify_keyval(t, XK.Super_L, Clutter.KeyState.RELEASED);
        // Any half-armed sticky modifiers must not leak into the next keystroke.
        this._mods = {ctrl: false, alt: false, super: false};
        this._shift = false;
        this._updateVisuals();
    }

    _modActive(name) {
        if (name === 'shift')
            return this._shift;
        if (name === 'caps')
            return this._caps;
        return !!this._mods[name];
    }

    _toggleMod(name) {
        if (name === 'shift')
            this._shift = !this._shift;
        else if (name === 'caps')
            this._caps = !this._caps;
        else
            this._mods[name] = !this._mods[name];
        this._updateVisuals();
    }

    // Update glyphs and highlight in place -- never rebuild, so an in-flight
    // touch can never be re-delivered to a different button.
    _updateVisuals() {
        for (const {def, label} of this._letterKeys) {
            const upper = this._caps !== this._shift;
            label.text = upper ? def.base.toUpperCase() : def.base;
        }
        for (const glyph of this._shiftGlyphs)
            glyph.style = shiftGlyphStyle(this._shift, this._scale);
        for (const {name, btn, minW} of this._modButtons)
            btn.style = keyStyle(
                this._modActive(name) ? 'on' : 'mod', minW, this._scale);
    }

    // ---- visibility ---------------------------------------------------
    _toggleCollapse() {
        if (!this._rowsBox)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        const show = !this._rowsBox.visible;
        this._rowsBox.visible = show;
        if (this._collapseBtn) {
            const label = this._collapseBtn.get_child();
            if (label)
                label.text = show ? 'v' : '^';
        }
        this._reflow(oldHeight);
    }

    _setVisible(visible, writeState = true) {
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        if (!visible)
            this._repeatCancel();
        this._hidden = !visible;
        if (this._box)
            this._box.visible = visible;
        if (this._rowsBox)
            this._rowsBox.visible = visible;
        if (this._collapseBtn) {
            const label = this._collapseBtn.get_child();
            if (label)
                label.text = visible ? 'v' : '^';
        }
        if (this._qsToggle && this._qsToggle.checked !== visible)
            this._qsToggle.checked = visible;
        if (writeState && this._readState() !== visible)
            this._writeState(visible);
        this._reflow(oldHeight);
    }

    // ---- shared on/off state (app icon <-> extension) -----------------
    _statePath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), STATE_FILE]);
    }

    _readState() {
        try {
            const path = this._statePath();
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return null;
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok)
                return null;
            // The file only ever holds "0" or "1"; avoid TextDecoder, which is
            // not guaranteed across GJS versions.
            const text = Array.from(bytes)
                .map(b => String.fromCharCode(b)).join('').trim();
            if (text === '1')
                return true;
            if (text === '0')
                return false;
        } catch (e) {
            log(`erhai-osk: read state failed: ${e}`);
        }
        return null;
    }

    _writeState(visible) {
        try {
            const path = this._statePath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, visible ? '1' : '0');
        } catch (e) {
            log(`erhai-osk: write state failed: ${e}`);
        }
    }

    _watchStateFile() {
        try {
            const path = this._statePath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);

            // Start in whatever state the launcher left behind.
            if (this._readState() === false)
                this._setVisible(false, false);

            const file = Gio.File.new_for_path(path);
            this._stateMonitor = file.monitor_file(
                Gio.FileMonitorFlags.NONE, null);
            this._stateMonitorId = this._stateMonitor.connect('changed',
                () => this._onStateFileChanged());
        } catch (e) {
            log(`erhai-osk: state watch failed: ${e}`);
        }
    }

    _onStateFileChanged() {
        const want = this._readState();
        if (want === null || want === !this._hidden)
            return;             // nothing to do (also breaks the feedback loop)
        this._setVisible(want, false);
    }

    // ---- yield to modal dialogs --------------------------------------
    // Our panel is added with addTopChrome(), and layout.js adds
    // modalDialogGroup to uiGroup *before* top chrome -- so the keyboard renders
    // ON TOP of the shutdown/session dialog while that dialog's pushModal grab
    // makes our buttons unclickable.
    //
    // Watching the group's child-added signal does NOT work: the session dialog
    // is constructed once at shell startup (before we attach) and only toggles
    // visibility afterwards, so no signal ever fires.  Poll its visible children
    // instead -- a 250ms check over a handful of actors is free.
    _watchModalDialogs() {
        if (this._modalPollId)
            return;
        this._modalPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._modalTick();
            return GLib.SOURCE_CONTINUE;
        });
        log('erhai-osk: modal watcher started');
    }

    _isModalDialogVisible() {
        try {
            const group = Main.layoutManager.modalDialogGroup;
            if (!group)
                return false;
            return group.get_children().some(child => child.visible);
        } catch (e) {
            return false;
        }
    }

    _modalTick() {
        const modal = this._isModalDialogVisible();
        if (modal && !this._hidden) {
            this._hiddenByModal = true;
            this._setVisible(false, false);   // don't rewrite the state file
            log('erhai-osk: modal dialog opened, keyboard yielded');
        } else if (!modal && this._hiddenByModal) {
            this._hiddenByModal = false;
            if (this._readState() !== false) {
                this._setVisible(true, false);
                log('erhai-osk: modal dialog closed, keyboard restored');
            }
        }
    }

    // ---- placement ---------------------------------------------------
    _onAllocation() {
        this._placeIfNeeded();
    }

    _placeIfNeeded() {
        if (this._placed || !this._box)
            return;
        const [w, h] = this._box.get_size();
        if (w <= 0 || h <= 0)
            return;
        this._placed = true;

        const saved = this._savedConfig ?? this._loadConfig();
        if (saved)
            this._applyPosition(saved.x, saved.y);
        else
            this._placeDefault();
        log(`erhai-osk: placed at ${this._posX},${this._posY} size ${w}x${h}`);
    }

    _placeDefault() {
        const mon = Main.layoutManager.primaryMonitor;
        const [w, h] = this._box.get_size();
        this._applyPosition(
            mon.x + Math.round((mon.width - w) / 2),
            mon.y + mon.height - h - 24);
    }

    _applyPosition(x, y) {
        if (!this._box)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        const [w, h] = this._box.get_size();
        const nx = Math.max(mon.x, Math.min(Math.round(x), mon.x + mon.width - w));
        const ny = Math.max(mon.y, Math.min(Math.round(y), mon.y + mon.height - h));
        this._posX = nx;
        this._posY = ny;
        this._box.set_translation(nx, ny, 0);
    }

    _onMonitorsChanged() {
        if (this._box)
            this._applyPosition(this._posX, this._posY);
    }

    // ---- dragging ----------------------------------------------------
    _coords(event) {
        const c = event.get_coords();
        return c.length === 3 ? [c[1], c[2]] : c;
    }

    _startDrag(event) {
        if (this._dragging || !this._box)
            return Clutter.EVENT_STOP;
        this._dragging = true;
        const [px, py] = this._coords(event);
        this._dragDx = px - this._posX;
        this._dragDy = py - this._posY;
        this._grabId = global.stage.connect('captured-event',
            this._onDragEvent.bind(this));
        // Safety: never leave the stage grabbed if the release event is lost,
        // which would swallow every subsequent touch and freeze the desktop.
        this._dragTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000,
            () => {
                this._dragTimeoutId = 0;
                log('erhai-osk: drag timeout, releasing grab');
                this._endDrag();
                return GLib.SOURCE_REMOVE;
            });
        return Clutter.EVENT_STOP;
    }

    _onGripPress(_actor, event) {
        return this._startDrag(event);
    }

    _onGripTouch(_actor, event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN)
            return this._startDrag(event);
        return Clutter.EVENT_PROPAGATE;
    }

    _onDragEvent(_stage, event) {
        const type = event.type();
        if (type === Clutter.EventType.MOTION
            || type === Clutter.EventType.TOUCH_UPDATE) {
            const [px, py] = this._coords(event);
            this._applyPosition(px - this._dragDx, py - this._dragDy);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE
            || type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL) {
            this._endDrag();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _endDrag() {
        this._dragging = false;
        if (this._dragTimeoutId) {
            GLib.source_remove(this._dragTimeoutId);
            this._dragTimeoutId = 0;
        }
        if (this._grabId) {
            global.stage.disconnect(this._grabId);
            this._grabId = 0;
        }
        if (this._box)
            this._saveConfig();
    }

    // ---- config persistence (position + size) ------------------------
    _posPath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), POS_FILE]);
    }

    // Returns {x, y, size, scale_small, scale_large}.  Anything the file does
    // not carry is null: `size` falls back to DEFAULT_SIZE, the two scale
    // factors fall back to SIZE_STEPS.
    _loadConfig() {
        try {
            const path = this._posPath();
            if (!GLib.file_test(path, GLib.FileTest.EXISTS))
                return null;
            const kf = new GLib.KeyFile();
            kf.load_from_file(path, GLib.KeyFileFlags.NONE);

            // Read straight out of [layout] and let get_string() throw when the
            // group or key is missing.  Do NOT gate this on
            // kf.get_groups().includes('layout'): GJS maps that gchar** out
            // param to a [names, length] tuple, so the call returns
            // [["position","layout"], 2] and includes() never matches -- which
            // silently disabled every override.
            const str = key => {
                try {
                    return kf.get_string('layout', key);
                } catch (e) {
                    return null;
                }
            };
            const num = key => {
                const raw = str(key);
                if (raw === null)
                    return null;
                const value = parseFloat(raw);
                return Number.isFinite(value) ? value : null;
            };

            return {
                x: kf.get_integer('position', 'x'),
                y: kf.get_integer('position', 'y'),
                size: str('size'),
                scale_small: num('scale_small'),
                scale_medium: num('scale_medium'),
                scale_large: num('scale_large'),
            };
        } catch (e) {
            log(`erhai-osk: load config failed: ${e}`);
        }
        return null;
    }

    // One KeyFile holds both groups: writing a fresh file with only the
    // position would silently drop the remembered size (and vice versa).
    _saveConfig() {
        try {
            const path = this._posPath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            // Hand-tuned scale factors live in this same file; rewriting it
            // without reading them first would erase the user's tuning.
            const prev = this._loadConfig();
            const kf = new GLib.KeyFile();
            kf.set_integer('position', 'x', Math.round(this._posX));
            kf.set_integer('position', 'y', Math.round(this._posY));
            kf.set_string('layout', 'size', this._sizeName || DEFAULT_SIZE);
            for (const key of ['scale_small', 'scale_medium', 'scale_large']) {
                const value = prev ? prev[key] : null;
                if (typeof value === 'number')
                    kf.set_string('layout', key, String(value));
            }
            kf.save_to_file(path);
            this._savedConfig = {
                x: Math.round(this._posX),
                y: Math.round(this._posY),
                size: this._sizeName || DEFAULT_SIZE,
                scale_small: prev ? prev.scale_small : null,
                scale_medium: prev ? prev.scale_medium : null,
                scale_large: prev ? prev.scale_large : null,
            };
        } catch (e) {
            log(`erhai-osk: save config failed: ${e}`);
        }
    }

    // ---- key injection -----------------------------------------------
    // Emits one key with the currently armed sticky modifiers, then clears them.
    _emit(keysym, withShift) {
        if (!this._vdev || !keysym)
            return;

        const armed = [];
        if (this._mods.ctrl)
            armed.push(XK.Control_L);
        if (this._mods.alt)
            armed.push(XK.Alt_L);
        if (this._mods.super)
            armed.push(XK.Super_L);
        if (withShift)
            armed.push(XK.Shift_L);

        const hadState = armed.length > 0;
        const t = Clutter.get_current_event_time();

        for (const m of armed)
            this._vdev.notify_keyval(t, m, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, keysym, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, keysym, Clutter.KeyState.RELEASED);
        for (const m of armed.reverse())
            this._vdev.notify_keyval(t, m, Clutter.KeyState.RELEASED);

        this._mods = {ctrl: false, alt: false, super: false};
        this._shift = false;
        if (hadState)
            this._updateVisuals();
    }

    _emitChar(def) {
        // Letters: uppercase comes from Caps XOR Shift.
        if (/^[a-z]$/.test(def.base)) {
            const upper = this._caps !== this._shift;
            this._emit(Clutter.unicode_to_keysym(def.base.codePointAt(0)), upper);
            return;
        }
        // Symbols: notify_keyval does not apply the shift level, so a shifted
        // glyph ('!' from '1') must be sent as the BASE key with a real Shift
        // press -- passing the keysym for '!' would type '1'.
        const useShift = this._shift && !!def.shifted;
        this._emit(Clutter.unicode_to_keysym(def.base.codePointAt(0)), useShift);
    }
}
