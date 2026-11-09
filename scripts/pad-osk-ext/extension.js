// pad-osk -- on-screen keyboard as a GNOME Shell extension.
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
// Namespace import instead of named: gnome-shell exports `gettext` since 45,
// and a named import of something missing would break the whole module.
import * as ShellExtension from 'resource:///org/gnome/shell/extensions/extension.js';

const Extension = ShellExtension.Extension;

// ---- translations ----------------------------------------------------
// Every user-visible string below is written in English as the msgid and looked
// up at render time through T().
//
// Use the shell's own gettext export: it binds the text domain to this
// extension's uuid and its locale/ directory when the Extension instance is
// created.  Do NOT try GLib.bindtextdomain() -- GJS does not expose it (it
// throws "bindtextdomain is not a function"), which silently left every string
// untranslated even though the .mo file was installed correctly.
const _shellGettext = typeof ShellExtension.gettext === 'function'
    ? ShellExtension.gettext
    : null;

// Set in enable(): the instance method knows this extension's uuid and binds
// the domain, which is what actually makes lookups resolve.
let _gettextFn = null;

function T(text) {
    if (!text || !_gettextFn)
        return text;
    try {
        return _gettextFn(text);
    } catch (e) {
        return text;
    }
}

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

const POS_FILE = 'pad-osk/position.kf';

// Hold-to-repeat: every character key repeats while held, plus the keys people
// actually hold down.  Sticky modifiers, shift, symbol and the IME key never
// repeat -- repeating those would arm a modifier or a chord by accident.
const REPEATABLE = new Set([XK.BackSpace, XK.Left, XK.Up, XK.Right, XK.Down]);
const REPEAT_DELAY_MS = 620;      // ignore a normal tap
const REPEAT_INTERVAL_MS = 125;   // ~8/s while getting going
const REPEAT_FAST_MS = 60;        // ~17/s once it is clearly deliberate
// Shared on/off state: the app launcher writes it, the extension watches it, so
// the Quick Settings switch and the PAD-OSK icon act on the SAME axis.
const STATE_FILE = 'pad-osk/visible';

// ---- styling ---------------------------------------------------------
// Three things are user-adjustable from the ⚙ menu, and all of them live
// here: the size of every dimension (小/中/大), the palette (配色), and how
// see-through the keyboard's background is (透明, 100%..50%).
//
// Every dimension below is written for the *medium* size and multiplied by a
// per-size scale factor, so the three sizes stay proportional instead of
// drifting apart.  See SIZE_STEPS / _setSize().
//
// Palettes: spelled out role by role, so a theme can never inherit a colour
// left over from the one before it.  Roles ([background, foreground] pairs
// unless noted):
//   key / mod / act  ordinary key, sticky modifier, action key
//   on               a modifier that is currently armed (the lit key)
//   grip / btn / close / idle    the bar around the keys
//   accent(+accentFg)            the filled choice in a segmented control
//   shift            the small shifted glyph above a key cap
//   panel / panelAlpha          keyboard background: "r,g,b" + its own alpha
//   panelAlt                    settings sheet inside the panel
//   swatch           the theme's own chooser button
//
// THEME is module state: _setTheme() swaps the object, then every style is
// re-applied in place by _applyScale() -- no actor is ever rebuilt.
const THEMES = [
    {
        name: 'graphite', label: 'Graphite',
        panel: '18,20,22', panelAlpha: 0.97, panelAlt: 'rgba(0,0,0,0.25)',
        key: ['#4a4e53', '#ffffff'],
        mod: ['#5a5f65', '#ffdc8a'],
        act: ['#54595f', '#b9e4e6'],
        on: ['#ffd479', '#1e2022'],
        grip: ['#33373b', '#b0b8c0'],
        btn: ['#474c52', '#ffd479'],
        close: ['#553a3a', '#ffabab'],
        idle: ['#3c4147', '#c9d1d9'],
        accent: '#ffd479', accentFg: '#1e2022',
        shift: ['#a8b0b8', '#ffffff'],
        swatch: ['#4a4e53', '#ffffff'],
    },
    {
        name: 'light', label: 'Light',
        panel: '244,246,249', panelAlpha: 0.98, panelAlt: 'rgba(15,23,42,0.07)',
        key: ['#ffffff', '#1b1e21'],
        mod: ['#e8eef6', '#8a5a00'],
        act: ['#e4edf2', '#0f6d78'],
        on: ['#1f6feb', '#ffffff'],
        grip: ['#dfe5ec', '#3d4650'],
        btn: ['#e8eef6', '#1f6feb'],
        close: ['#ffe1e1', '#b4232a'],
        idle: ['#eef2f7', '#4b5563'],
        accent: '#1f6feb', accentFg: '#ffffff',
        shift: ['#6b7480', '#111418'],
        swatch: ['#ffffff', '#1b1e21'],
    },
    {
        name: 'warm', label: 'Warm',
        panel: '43,37,32', panelAlpha: 0.97, panelAlt: 'rgba(0,0,0,0.22)',
        key: ['#5b5046', '#fdf6ec'],
        mod: ['#6d6052', '#ffd9a0'],
        act: ['#63584a', '#d8f3c9'],
        on: ['#f3a952', '#241d16'],
        grip: ['#3b332c', '#c8bcae'],
        btn: ['#4f463c', '#f3a952'],
        close: ['#5e3b38', '#ffb3a7'],
        idle: ['#463d34', '#d9cfc2'],
        accent: '#f3a952', accentFg: '#241d16',
        shift: ['#b3a898', '#ffffff'],
        swatch: ['#5b5046', '#fdf6ec'],
    },
    {
        name: 'contrast', label: 'High contrast',
        panel: '0,0,0', panelAlpha: 1.0, panelAlt: '#111111',
        key: ['#1a1a1a', '#ffffff'],
        mod: ['#262600', '#ffff00'],
        act: ['#002626', '#00ffff'],
        on: ['#ffff00', '#000000'],
        grip: ['#000000', '#ffff00'],
        btn: ['#1a1a1a', '#ffff00'],
        close: ['#330000', '#ff8080'],
        idle: ['#1a1a1a', '#ffffff'],
        accent: '#ffff00', accentFg: '#000000',
        shift: ['#cccccc', '#ffffff'],
        swatch: ['#1a1a1a', '#ffffff'],
    },
];
const DEFAULT_THEME = 'graphite';
let THEME = THEMES.find(t => t.name === DEFAULT_THEME);

// 透明度: a multiplier applied to the whole keyboard panel -- background, key
// faces, chrome and glyphs alike -- so the keyboard reads as one piece of
// glass instead of a see-through frame with solid keys.  It rides on the
// actor's own opacity (Clutter paints the actor and its children with it), so
// every style below stays completely unaware of it.
//
// 50% is the floor: below that the keys float over a live desktop and the
// glyphs stop being readable.
const OPACITY_STEPS = [
    {value: 1.0, label: '100'},
    {value: 0.9, label: '90'},
    {value: 0.8, label: '80'},
    {value: 0.7, label: '70'},
    {value: 0.6, label: '60'},
    {value: 0.5, label: '50'},
];
const DEFAULT_OPACITY = 1.0;
const OPACITY_MIN = 0.5;
let OPACITY = DEFAULT_OPACITY;

// ---- custom palette --------------------------------------------------
// [custom] in position.kf: panel= key= mod= act= on= as #rrggbb (three-digit
// hex is accepted too).  Foregrounds are computed from luminance, so a light
// panel gets dark glyphs without the user having to spell out both halves of
// every [bg, fg] pair.  Every role the presets define is derived from those
// five, which is why a custom palette can never end up half-populated.
const CUSTOM_THEME = 'custom';

const hexToRgb = hex => {
    const h = String(hex ?? '').trim().replace(/^#/, '');
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full))
        return null;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
};
const rgbToHex = rgb => '#' + rgb
    .map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('');
const mixRgb = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const luminance = rgb => {
    const [r, g, b] = rgb.map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const fgFor = hex => {
    const rgb = hexToRgb(hex);
    return rgb && luminance(rgb) > 0.45 ? '#101418' : '#ffffff';
};
// t < 0 darkens towards black, t > 0 lightens towards white.
const shade = (hex, t) => {
    const rgb = hexToRgb(hex) ?? [0, 0, 0];
    return rgbToHex(mixRgb(rgb, t < 0 ? [0, 0, 0] : [255, 255, 255], Math.abs(t)));
};

// Returns a complete theme, or null when the five colours are not all valid.
function makeCustomTheme(source) {
    if (!source)
        return null;
    const need = ['panel', 'key', 'mod', 'act', 'on'];
    for (const role of need) {
        if (!hexToRgb(source[role]))
            return null;
    }
    const {panel, key, mod, act, on} = source;
    const glyph = fgFor(key);
    return {
        name: CUSTOM_THEME, label: 'Custom',
        panel: hexToRgb(panel).join(','),
        panelAlpha: 1.0,
        panelAlt: 'rgba(0,0,0,0.25)',
        key: [key, glyph],
        mod: [mod, fgFor(mod)],
        act: [act, fgFor(act)],
        on: [on, fgFor(on)],
        // chrome follows the panel/key so a light custom palette does not
        // inherit the dark presets' bars
        grip: [shade(panel, -0.22), fgFor(shade(panel, -0.22))],
        btn: [shade(key, 0.08), fgFor(shade(key, 0.08))],
        close: [shade(on, -0.6), fgFor(shade(on, -0.6))],
        idle: [shade(key, -0.2), fgFor(shade(key, -0.2))],
        accent: on,
        accentFg: fgFor(on),
        shift: [rgbToHex(mixRgb(hexToRgb(glyph), hexToRgb(key), 0.45)), glyph],
        swatch: [panel, fgFor(panel)],
    };
}

// Set by the extension from [layout] background=<path>; kept as a plain URI
// string so this section stays free of gi:// imports (the style test slices it
// out and runs it in bare Node).
let BACKGROUND_URI = null;

// Three sizes, picked from the ⚙ settings sheet.  Measured on this tablet
// (1696px-wide logical screen, logged by _reflow):
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
// ~/.config/pad-osk/position.kf ([layout] scale_small= / scale_medium= /
// scale_large=, plus size= and theme=) can override all three, so tuning needs
// neither a rebuild nor a re-login.
const SIZE_STEPS = [
    {name: 'small', label: 'Small', scale: 0.72},
    {name: 'medium', label: 'Medium', scale: 0.85},
    {name: 'large', label: 'Large', scale: 0.99},
];
const DEFAULT_SIZE = 'medium';
const SCALE_MIN = 0.40;
const SCALE_MAX = 2.00;

function findStep(steps, name) {
    return steps.find(s => s.name === name) ?? steps[1];
}

// Whole pixels only: fractional sizes give blurry glyphs in St.
const px = (value, scale) => `${Math.max(1, Math.round(value * scale))}px`;

// 圆角: one number drives every rounded corner.  The default 8 reproduces the
// original design exactly (keys 8, panel 16, grip 10, small buttons 8, sheet
// 12); larger steps round the keys into pills, 0 makes them square.
const RADIUS_STEPS = [
    {value: 0, label: 'Square'},
    {value: 8, label: 'Small'},
    {value: 16, label: 'Medium'},
    {value: 26, label: 'Large'},
];
const DEFAULT_RADIUS = 8;
const RADIUS_MIN = 0;
const RADIUS_MAX = 40;
let RADIUS = DEFAULT_RADIUS;

// Derived radii keep the proportions of the shipped look at every step.
const radiusKey = () => RADIUS;
const radiusPanel = () => Math.max(16, RADIUS * 2);
const radiusGrip = () => Math.max(10, RADIUS + 2);
const radiusSmall = () => Math.max(8, RADIUS);
const radiusSheet = () => Math.max(12, RADIUS + 4);

// px() floors at 1px so no border ever vanishes by accident; a corner radius is
// the one place where 0 is a real value (直角), so it gets its own helper.
const pxSoft = (value, scale) => value <= 0
    ? '0px'
    : `${Math.max(1, Math.round(value * scale))}px`;

// A key kind that the current theme does not name falls back to a plain key,
// so a typo in LAYOUT can never render an invisible button.
function keyStyle(kind, minWidth, scale = 1) {
    const [bg, fg] = THEME[kind] ?? THEME.key;
    return `background-color: ${bg}; color: ${fg};`
        + ` border-radius: ${pxSoft(radiusKey(), scale)};`
        + ` padding: ${px(14, scale)} ${px(6, scale)};`
        + ` margin: ${px(3, scale)};`
        + ` font-size: ${px(24, scale)};`
        + ` min-width: ${px(minWidth, scale)};`;
}

const boxStyle = scale => {
    const css = `background-color: rgba(${THEME.panel}, ${THEME.panelAlpha.toFixed(2)});`
        + ` border-radius: ${pxSoft(radiusPanel(), scale)};`
        + ` padding: ${px(10, scale)};`;
    // User-supplied backdrop: cover the whole panel, cropped rather than
    // stretched, and faded by the same actor opacity as everything else.
    return BACKGROUND_URI
        ? `${css} background-image: url("${BACKGROUND_URI}"); background-size: cover;`
        : css;
};

const gripStyle = scale =>
    `background-color: ${THEME.grip[0]}; color: ${THEME.grip[1]};`
    + ` border-radius: ${pxSoft(radiusGrip(), scale)};`
    + ` padding: ${px(8, scale)} ${px(20, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(17, scale)};`;

const gripBtnStyle = scale =>
    `background-color: ${THEME.btn[0]}; color: ${THEME.btn[1]};`
    + ` border-radius: ${pxSoft(radiusSmall(), scale)};`
    + ` padding: ${px(5, scale)} ${px(20, scale)};`
    + ` margin: ${px(3, scale)} ${px(3, scale)} ${px(3, scale)} ${px(12, scale)};`
    + ` font-size: ${px(22, scale)};`;

const closeBtnStyle = scale =>
    `background-color: ${THEME.close[0]}; color: ${THEME.close[1]};`
    + ` border-radius: ${pxSoft(radiusSmall(), scale)};`
    + ` padding: ${px(5, scale)} ${px(20, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(22, scale)};`;

// The size selector reads as a segmented control: the active step is filled,
// the others stay quiet so they never compete with the keys.
const sizeBtnStyle = (active, scale) =>
    `background-color: ${active ? THEME.accent : THEME.idle[0]};`
    + ` color: ${active ? THEME.accentFg : THEME.idle[1]};`
    + ` border-radius: ${pxSoft(radiusSmall(), scale)};`
    + ` padding: ${px(5, scale)} ${px(16, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(20, scale)};`;

// A theme button carries its own colours (that is the preview); the border is
// what marks the active one.  The border is always drawn, in the swatch colour
// when idle, so switching themes cannot leave a stale outline behind.
const themeBtnStyle = (active, scale, theme) =>
    `background-color: ${theme.swatch[0]}; color: ${theme.swatch[1]};`
    + ` border: ${px(3, scale)} solid ${active ? THEME.accent : theme.swatch[0]};`
    + ` border-radius: ${pxSoft(radiusSmall(), scale)};`
    + ` padding: ${px(4, scale)} ${px(12, scale)};`
    + ` margin: ${px(3, scale)}; font-size: ${px(18, scale)};`;

// The settings sheet sits inside the panel, so it needs its own tint to read as
// a separate surface; panelAlt is that tint per theme.
const settingsPanelStyle = scale =>
    `background-color: ${THEME.panelAlt};`
    + ` border-radius: ${pxSoft(radiusSheet(), scale)};`
    + ` padding: ${px(8, scale)};`
    + ` margin: ${px(3, scale)} ${px(3, scale)} 0 ${px(3, scale)};`;

const sectionLabelStyle = scale =>
    `color: ${THEME.grip[1]};`
    + ` font-size: ${px(16, scale)};`
    + ` padding: ${px(2, scale)} ${px(12, scale)} ${px(2, scale)} ${px(4, scale)};`;

const shiftGlyphStyle = (on, scale) =>
    `color: ${on ? THEME.shift[1] : THEME.shift[0]};`
    + ` font-size: ${px(15, scale)};`;

// Emoji cells: no min-width, a square-ish padding and a larger glyph, so a
// page of 32 fits the panel width at every size step.
const emojiBtnStyle = scale =>
    `background-color: ${THEME.key[0]}; color: ${THEME.key[1]};`
    + ` border-radius: ${pxSoft(radiusSmall(), scale)};`
    + ` padding: ${px(4, scale)} ${px(8, scale)};`
    + ` margin: ${px(2, scale)}; font-size: ${px(26, scale)};`;

// ---- key descriptors -------------------------------------------------
const ch = (base, shifted, minW = 64) => ({base, shifted, minW, kind: 'key'});
const act = (label, keysym, minW = 82) => ({label, keysym, minW, kind: 'act'});
const md = (label, name, minW = 82) => ({label, mod: name, minW, kind: 'mod'});
// Input-method switch: emits Super+Space, which GNOME maps to "switch input
// source" (xkb:us <-> ibus:libpinyin).  Saved from accidental Super+Space.
// The label is a msgid: English systems show "IME", Chinese ones "中/英".
const ime = (minW = 96) => ({label: 'IME', ime: true, minW, kind: 'mod'});
// Emoji switch: only opens the emoji sheet, it never types anything itself.
const emj = (minW = 82) => ({label: '😀', emoji: true, minW, kind: 'mod'});

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
        emj(),
        ime(),
        md('Ctrl', 'ctrl'),
        act('←', XK.Left, 82), act('↓', XK.Down, 82), act('→', XK.Right, 82),
    ],
];

// Emoji are shipped as data rather than via the emoji picker/input method:
// pressing one injects its Unicode keysym directly, which is the only route
// that works in apps that never speak text-input-v3.
// 3 pages × 8 columns × 4 rows.
const EMOJI_PAGES = [
    [
        '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣',
        '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰',
        '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜',
        '🤪', '🤨', '🧐', '🤓', '😎', '🥳', '😏', '😒',
    ],
    [
        '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫',
        '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬',
        '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥',
        '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐',
    ],
    [
        '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙',
        '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️',
        '🖖', '👋', '🤝', '🙏', '💪', '🦾', '🧠', '👀',
        '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍',
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
                title: T('Screen Keyboard'),
                iconName: 'input-keyboard-symbolic',
                toggleMode: true,
                checked: !kbd._hidden,
            });
            this._kbd = kbd;
            this.connect('notify::checked', () => {
                // Ignore the echo of a programmatic sync.  Without this the
                // extension hiding itself (file picker, modal dialog, initial
                // state restore) flips the switch, and the switch writes "off"
                // back into the state file -- so the keyboard never returns on
                // its own and has to be turned on by hand every time.
                if (!this._kbd || this._kbd._syncingToggle)
                    return;
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
        log('pad-osk: v15 enable (settings sheet, themes, sizes, repeat)');
        try {
            // Prefer the instance method: it is bound to this extension's uuid
            // and locale/ directory.  The module-level export is only a
            // fallback.  In either case, "Size" in the log means English and
            // "大小" means the translation is live.
            _gettextFn = typeof this.gettext === 'function'
                ? this.gettext.bind(this)
                : _shellGettext;
            log(`pad-osk: gettext ${_gettextFn ? 'ok' : 'MISSING'}`
                + `, msg Size -> "${T('Size')}"`);

            const seat = this._makeSeat();
            if (!seat) {
                log('pad-osk: no Clutter seat');
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
            this._themeBtns = {};
            this._opacityBtns = {};
            this._radiusBtns = {};
            this._backgroundBtns = {};
            this._bgMode = 'pick';
            this._pendingDelete = null;
            this._pendingDeleteTimeoutId = 0;
            this._settingsOpen = false;
            // Guards the Quick Settings switch against echoing our own
            // programmatic checked= writes back into the state file.
            this._syncingToggle = false;
            this._pickerHidden = false;
            this._pickerTimeoutId = 0;

            // The config directory follows the package name now
            // (~/.config/pad-osk); copy the old one across once so an upgrade
            // keeps position, size, palette and on/off state.
            this._migrateConfig();

            // Restore the size, palette, transparency and backdrop before the
            // rows are built, so the very first allocation is already correct
            // (no visible jump at startup).
            const cfg = this._loadConfig();
            this._steps = this._readScales(cfg);
            this._sizeName = cfg && this._steps.some(s => s.name === cfg.size)
                ? cfg.size : DEFAULT_SIZE;
            this._scale = findStep(this._steps, this._sizeName).scale;

            // The custom palette has to exist before the remembered theme name
            // is resolved, because 'custom' is only a valid choice once it does.
            this._custom = makeCustomTheme(cfg ? cfg.custom : null);
            this._themes = this._custom ? [...THEMES, this._custom] : [...THEMES];
            this._themeName = cfg && this._themes.some(t => t.name === cfg.theme)
                ? cfg.theme : DEFAULT_THEME;
            THEME = this._themes.find(t => t.name === this._themeName);

            this._opacity = cfg && typeof cfg.opacity === 'number'
                ? Math.min(1, Math.max(OPACITY_MIN, cfg.opacity))
                : DEFAULT_OPACITY;
            OPACITY = this._opacity;
            this._radius = cfg && typeof cfg.radius === 'number'
                ? Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, Math.round(cfg.radius)))
                : DEFAULT_RADIUS;
            RADIUS = this._radius;
            this._background = cfg ? cfg.background : null;
            this._emojiMode = (cfg && cfg.emoji_mode) || 'paste';
            // "无" only switches the picture off; the path stays remembered so
            // tapping its button again brings it back.  An absent key means the
            // old shape of the file, where a stored path was always shown.
            this._backgroundOn = !!this._background
                && (cfg.backgroundEnabled === null
                    || cfg.backgroundEnabled === undefined
                    || !!cfg.backgroundEnabled);
            BACKGROUND_URI = this._backgroundOn
                ? this._backgroundUri(this._background) : null;
            // Give the backdrop folder a home, so "how do I add a picture?" is
            // answered by a directory that already exists.
            try {
                GLib.mkdir_with_parents(this._backgroundDir(), 0o755);
            } catch (e) {
                log(`pad-osk: background dir failed: ${e}`);
            }
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
            // Apply the remembered transparency before the first paint, so the
            // panel never flashes opaque on login.
            this._box.opacity = Math.round(OPACITY * 255);

            this._buildGrip();
            this._buildSettings();
            this._buildEmoji();
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
                .catch(e => log(`pad-osk: quick settings unavailable: ${e}`));

            log('pad-osk: v15 enabled');
        } catch (e) {
            log(`pad-osk: v15 enable failed: ${e}`);
        }
    }

    disable() {
        if (this._indicator) {
            try {
                this._indicator.destroy();
            } catch (e) {
                log(`pad-osk: indicator destroy failed: ${e}`);
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
        this._themeBtns = {};
        this._opacityBtns = {};
        this._radiusBtns = {};
        this._backgroundBtns = {};
        this._bgMode = 'pick';
        this._cancelDeleteBackground(false);
        this._bgRow = null;
        this._resetBtn = null;
        this._sectionLabels = [];
        this._settings = null;
        this._settingsBtn = null;
        this._emojiPanel = null;
        this._emojiBtns = [];
        this._emojiPrev = null;
        this._emojiNext = null;
        this._emojiPageLabel = null;
        this._emojiOpen = false;
        this._savedConfig = null;
        this._custom = null;
        this._themes = [...THEMES];
        this._background = null;
        this._backgroundOn = false;
        // Back to the shipping palette, opacity and backdrop: module-scope
        // THEME/OPACITY/BACKGROUND_URI outlive this instance, and a disabled
        // extension must not leave them swapped.
        THEME = THEMES.find(t => t.name === DEFAULT_THEME);
        this._opacity = DEFAULT_OPACITY;
        OPACITY = DEFAULT_OPACITY;
        this._radius = DEFAULT_RADIUS;
        RADIUS = DEFAULT_RADIUS;
        BACKGROUND_URI = null;
        if (this._pickerTimeoutId) {
            GLib.source_remove(this._pickerTimeoutId);
            this._pickerTimeoutId = 0;
        }
        this._pickerHidden = false;
        this._repeatCancel();
        this._vdev = null;
        log('pad-osk: v15 disabled');
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
            log('pad-osk: quick settings toggle added');
        } catch (e) {
            log(`pad-osk: quick settings toggle failed: ${e}`);
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
            text: T('⠿  Drag'),
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._dragArea.connect('button-press-event', this._onGripPress.bind(this));
        this._dragArea.connect('touch-event', this._onGripTouch.bind(this));
        this._grip.add_child(this._dragArea);

        // ⚙ -- the size and the palette both moved in here; the grip bar only
        // keeps the controls you reach for mid-sentence.
        this._settingsBtn = new St.Button({
            child: new St.Label({text: '⚙', y_align: Clutter.ActorAlign.CENTER}),
            style: gripBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._settingsBtn.connect('clicked', () => this._toggleSettings());
        this._grip.add_child(this._settingsBtn);

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

    // ---- settings sheet (⚙: 大小 + 颜色) -------------------------------
    // An inline sheet, not a St.PopupMenu: a popup takes a shell grab, and
    // grabs are exactly what makes touch unreliable here (see the click-gesture
    // note in _attachRepeat).  A sheet inside the panel needs no grab at all,
    // and it reflows the panel the same way a size change already does.
    _buildSettings() {
        this._settings = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            style: settingsPanelStyle(this._scale),
        });
        this._sectionLabels = [];

        const sizeRow = new St.BoxLayout({reactive: false});
        sizeRow.add_child(this._sectionLabel(T('Size')));
        for (const step of this._steps) {
            const btn = new St.Button({
                child: new St.Label({
                    text: T(step.label),
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: sizeBtnStyle(step.name === this._sizeName, this._scale),
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', () => this._setSize(step.name));
            sizeRow.add_child(btn);
            this._sizeBtns[step.name] = btn;
        }
        this._settings.add_child(sizeRow);

        const themeRow = new St.BoxLayout({reactive: false});
        themeRow.add_child(this._sectionLabel(T('Color')));
        for (const theme of this._themes) {
            const btn = new St.Button({
                child: new St.Label({
                    text: T(theme.label),
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: themeBtnStyle(
                    theme.name === this._themeName, this._scale, theme),
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', () => this._setTheme(theme.name));
            themeRow.add_child(btn);
            this._themeBtns[theme.name] = btn;
        }
        this._settings.add_child(themeRow);

        const opacityRow = new St.BoxLayout({reactive: false});
        opacityRow.add_child(this._sectionLabel(T('Opacity')));
        for (const step of OPACITY_STEPS) {
            const btn = new St.Button({
                child: new St.Label({
                    text: `${step.label}%`,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: sizeBtnStyle(
                    Math.abs(step.value - this._opacity) < 0.001, this._scale),
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', () => this._setOpacity(step.value));
            opacityRow.add_child(btn);
            this._opacityBtns[step.value] = btn;
        }
        this._settings.add_child(opacityRow);

        const radiusRow = new St.BoxLayout({reactive: false});
        radiusRow.add_child(this._sectionLabel(T('Radius')));
        for (const step of RADIUS_STEPS) {
            const btn = new St.Button({
                child: new St.Label({
                    text: T(step.label),
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: sizeBtnStyle(
                    Math.abs(step.value - this._radius) < 0.001, this._scale),
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', () => this._setRadius(step.value));
            radiusRow.add_child(btn);
            this._radiusBtns[step.value] = btn;
        }
        this._settings.add_child(radiusRow);

        // 背景 and 默认 rows.  The background row is (re)filled every time the
        // sheet opens, and the reset button lives in its own row.
        this._bgRow = new St.BoxLayout({reactive: false});
        this._settings.add_child(this._bgRow);
        this._buildResetRow();

        this._box.add_child(this._settings);
    }

    // ---- backdrop + reset -------------------------------------------
    // One-way move from ~/.config/erhai-osk to ~/.config/pad-osk.  Runs only
    // when the new directory does not exist yet, so a downgrade or a second
    // upgrade never overwrites newer settings with older ones.
    _migrateConfig() {
        try {
            const root = GLib.get_user_config_dir();
            const oldDir = GLib.build_filenamev([root, 'erhai-osk']);
            const newDir = GLib.build_filenamev([root, 'pad-osk']);
            if (!GLib.file_test(oldDir, GLib.FileTest.IS_DIR))
                return;
            if (GLib.file_test(newDir, GLib.FileTest.IS_DIR))
                return;

            GLib.mkdir_with_parents(newDir, 0o755);
            const copy = (from, to) => {
                try {
                    const [ok, bytes] = GLib.file_get_contents(from);
                    if (ok)
                        GLib.file_set_contents(to, bytes);
                } catch (e) {
                    log(`pad-osk: migrate ${from} failed: ${e}`);
                }
            };
            for (const name of ['position.kf', 'visible']) {
                const from = GLib.build_filenamev([oldDir, name]);
                if (GLib.file_test(from, GLib.FileTest.EXISTS))
                    copy(from, GLib.build_filenamev([newDir, name]));
            }

            const oldBg = GLib.build_filenamev([oldDir, 'backgrounds']);
            if (GLib.file_test(oldBg, GLib.FileTest.IS_DIR)) {
                const newBg = GLib.build_filenamev([newDir, 'backgrounds']);
                GLib.mkdir_with_parents(newBg, 0o755);
                const iter = Gio.File.new_for_path(oldBg).enumerate_children(
                    'standard::name', Gio.FileQueryInfoFlags.NONE, null);
                let info;
                while ((info = iter.next_file(null)) !== null) {
                    copy(GLib.build_filenamev([oldBg, info.get_name()]),
                        GLib.build_filenamev([newBg, info.get_name()]));
                }
                iter.close(null);
            }
            log('pad-osk: migrated ~/.config/erhai-osk -> ~/.config/pad-osk');
        } catch (e) {
            log(`pad-osk: config migration failed: ${e}`);
        }
    }

    // The keyboard is chrome, so it paints *above* every window -- including
    // the chooser.  Step out of the way while the picker is up and come back
    // when it closes, whichever way it closes.
    _yieldForPicker() {
        if (this._hidden)
            return;                     // already out of the way
        if (this._pickerHidden)
            return;                     // one picker at a time
        this._pickerHidden = true;
        this._setVisible(false, false); // don't touch the on/off state file
        // Safety net: a portal that never answers must not leave the keyboard
        // hidden forever.
        this._pickerTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 180000, () => {
                this._pickerTimeoutId = 0;
                log('pad-osk: picker timeout, restoring keyboard');
                this._restoreAfterPicker();
                return GLib.SOURCE_REMOVE;
            });
    }

    _restoreAfterPicker() {
        if (this._pickerTimeoutId) {
            GLib.source_remove(this._pickerTimeoutId);
            this._pickerTimeoutId = 0;
        }
        if (!this._pickerHidden)
            return;
        this._pickerHidden = false;
        // Unconditional: the keyboard was visible when the picker opened, so it
        // goes back regardless of what the state file says.  (Reading the file
        // here used to lose the keyboard, because the Quick Settings echo wrote
        // "off" while it was hidden.)
        this._setVisible(true, false);
    }

    // Images are picked with the desktop's own chooser (XDG portal), which is
    // the dialog the user already knows.  A shell chrome actor cannot open a
    // GTK dialog itself, so this goes through the portal service, with zenity
    // as a fallback for systems without one.
    _pickBackground() {
        this._yieldForPicker();
        try {
            const bus = Gio.DBus.session;
            const unique = bus.get_unique_name() ?? '';
            const token = `padosk${Date.now()}`;
            const sender = unique.replace(/^:/, '').replace(/\./g, '_');
            const handle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
            let subId = 0;
            subId = bus.signal_subscribe(
                'org.freedesktop.portal.Desktop',
                'org.freedesktop.portal.Request', 'Response', handle, null,
                Gio.DBusSignalFlags.NONE,
                (_conn, _from, _path, _iface, _signal, params) => {
                    bus.signal_unsubscribe(subId);
                    const [response, results] = params.deep_unpack();
                    if (response !== 0) {
                        log(`pad-osk: file chooser closed (${response})`);
                        this._restoreAfterPicker();
                        return;
                    }
                    const raw = results.uris;
                    const uris = raw && raw.deep_unpack ? raw.deep_unpack() : [];
                    if (uris.length) {
                        const path = Gio.File.new_for_uri(uris[0]).get_path();
                        if (path)
                            this._setBackground(this._importBackground(path));
                    }
                    this._restoreAfterPicker();
                    // Safe to rebuild here: the chooser has already closed, so
                    // no touch is in flight on the row's buttons.
                    if (this._settingsOpen)
                        this._buildBackgroundRow();
                });

            const options = {
                handle_token: new GLib.Variant('s', token),
                multiple: new GLib.Variant('b', false),
                filters: new GLib.Variant('a(sa(us))', [
                    ['图片', [[0, '*.png'], [0, '*.jpg'], [0, '*.jpeg'],
                        [0, '*.webp']]],
                ]),
            };
            bus.call('org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.FileChooser', 'OpenFile',
                new GLib.Variant('(ssa{sv})', ['', T('Choose keyboard background'), options]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (_conn, res) => {
                    try {
                        bus.call_finish(res);
                    } catch (e) {
                        log(`pad-osk: portal chooser failed: ${e}, trying zenity`);
                        this._pickBackgroundZenity();
                    }
                });
        } catch (e) {
            log(`pad-osk: portal unavailable: ${e}, trying zenity`);
            this._pickBackgroundZenity();
        }
    }

    _pickBackgroundZenity() {
        try {
            const proc = Gio.Subprocess.new(
                ['zenity', '--file-selection', '--title=选择键盘背景',
                    '--file-filter=图片 | *.png *.jpg *.jpeg *.webp'],
                Gio.SubprocessFlags.STDOUT_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_utf8_finish(res);
                    const path = (stdout ?? '').trim();
                    if (path) {
                        this._setBackground(this._importBackground(path));
                        if (this._settingsOpen)
                            this._buildBackgroundRow();
                    }
                } catch (e) {
                    log(`pad-osk: zenity picker failed: ${e}`);
                }
                this._restoreAfterPicker();
            });
        } catch (e) {
            log(`pad-osk: no image picker available: ${e}`);
            this._restoreAfterPicker();
        }
    }

    _backgroundDir() {
        return GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'pad-osk', 'backgrounds']);
    }

    _backgroundFiles() {
        const dirPath = this._backgroundDir();
        try {
            if (!GLib.file_test(dirPath, GLib.FileTest.IS_DIR))
                return [];
            // Gio enumeration rather than GLib.dir_read_names(): the latter is
            // GLib 2.80+ and its GJS binding is easy to get wrong, while
            // enumerate_children() is stable across every shell version here.
            const dir = Gio.File.new_for_path(dirPath);
            const iter = dir.enumerate_children(
                'standard::name', Gio.FileQueryInfoFlags.NONE, null);
            const names = [];
            let info;
            while ((info = iter.next_file(null)) !== null) {
                const name = info.get_name();
                if (/\.(png|jpe?g|webp)$/i.test(name))
                    names.push(name);
            }
            iter.close(null);
            names.sort();
            return names.map(n => GLib.build_filenamev([dirPath, n]));
        } catch (e) {
            log(`pad-osk: background list failed: ${e}`);
            return [];
        }
    }

    _backgroundUri(path) {
        if (!path)
            return null;
        try {
            if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
                log(`pad-osk: background missing: ${path}`);
                return null;
            }
            return GLib.filename_to_uri(path, null);
        } catch (e) {
            log(`pad-osk: background uri failed: ${e}`);
            return null;
        }
    }

    _buildBackgroundRow() {
        if (!this._bgRow)
            return;
        this._bgRow.destroy_all_children();
        this._backgroundBtns = {};
        // The old buttons are gone with the children; drop the references so a
        // later _applyScale() cannot poke a disposed actor.
        this._pickBtn = null;
        this._manageBtn = null;
        this._bgRow.add_child(new St.Label({
            text: this._bgMode === 'manage' ? T('Manage') : T('Background'),
            y_align: Clutter.ActorAlign.CENTER,
            style: sectionLabelStyle(this._scale),
        }));

        const button = (label, active, onActivate, extraStyle = '') => {
            const btn = new St.Button({
                child: new St.Label({
                    text: label,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: sizeBtnStyle(active, this._scale) + extraStyle,
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', onActivate);
            this._bgRow.add_child(btn);
            return btn;
        };

        if (this._bgMode === 'manage')
            return this._buildBackgroundManageRow(button);

        const add = (value, label) => {
            const btn = button(label, this._backgroundActive(value),
                () => this._setBackground(value));
            this._backgroundBtns[value ?? '__none__'] = btn;
        };

        add(null, T('None'));

        const files = this._backgroundFiles();
        // A picture picked with the system chooser can live anywhere, so show it
        // even when it is not inside the backgrounds folder.
        if (this._background && !files.includes(this._background))
            files.unshift(this._background);
        for (const file of files) {
            const base = GLib.path_get_basename(file).replace(/\.[^.]+$/, '');
            add(file, base.length > 10 ? `${base.slice(0, 10)}…` : base);
        }

        this._pickBtn = button(T('Pick…'), false, () => this._pickBackground());
        this._manageBtn = button(T('Manage…'), false, () => {
            this._bgMode = 'manage';
            this._buildBackgroundRow();
        });

        if (!files.length && !this._background) {
            this._bgRow.add_child(new St.Label({
                text: T('(or drop images into ~/.config/pad-osk/backgrounds/)'),
                y_align: Clutter.ActorAlign.CENTER,
                style: sectionLabelStyle(this._scale),
            }));
        }
    }

    // Screen 2 of the 背景 row: every stored picture with its own delete
    // button, plus a way back.  Deleting a file is the only thing that really
    // forgets a backdrop -- 无 and 恢复默认 both keep the remembered path.
    _buildBackgroundManageRow(button) {
        button(T('Back'), false, () => {
            this._cancelDeleteBackground(false);
            this._bgMode = 'pick';
            this._buildBackgroundRow();
        });

        const files = this._backgroundFiles();
        // The picture in use may live outside the folder (a path typed into
        // position.kf by hand), and it must still be listed and deletable.
        if (this._background && !files.includes(this._background))
            files.unshift(this._background);
        if (!files.length) {
            this._bgRow.add_child(new St.Label({
                text: T('(no images yet)'),
                y_align: Clutter.ActorAlign.CENTER,
                style: sectionLabelStyle(this._scale),
            }));
            return;
        }

        for (const file of files) {
            const base = GLib.path_get_basename(file).replace(/\.[^.]+$/, '');
            const name = base.length > 8 ? `${base.slice(0, 8)}…` : base;
            const group = new St.BoxLayout({reactive: false});
            group.add_child(new St.Button({
                child: new St.Label({
                    text: name,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: sizeBtnStyle(
                    this._backgroundActive(file), this._scale),
                reactive: true,
                can_focus: false,
                track_hover: true,
            }));
            const applyBtn = group.get_last_child();
            applyBtn.connect('clicked', () => this._setBackground(file));

            if (this._pendingDelete === file) {
                // Second step of the confirmation: the ✕ became two buttons.
                const confirm = new St.Button({
                    child: new St.Label({
                        text: T('Delete'),
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                    style: `${sizeBtnStyle(true, this._scale)}`
                        + ' color: #5a1010;',
                    reactive: true,
                    can_focus: false,
                    track_hover: true,
                });
                confirm.connect('clicked', () => this._confirmDeleteBackground(file));
                group.add_child(confirm);

                const cancel = new St.Button({
                    child: new St.Label({
                        text: T('Cancel'),
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                    style: sizeBtnStyle(false, this._scale),
                    reactive: true,
                    can_focus: false,
                    track_hover: true,
                });
                cancel.connect('clicked', () => this._cancelDeleteBackground());
                group.add_child(cancel);
            } else {
                const del = new St.Button({
                    child: new St.Label({
                        text: '✕',
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                    style: `${sizeBtnStyle(false, this._scale)}`
                        + ' color: #ff9a9a;',
                    reactive: true,
                    can_focus: false,
                    track_hover: true,
                });
                del.connect('clicked', () => this._requestDeleteBackground(file));
                group.add_child(del);
            }
            this._bgRow.add_child(group);
        }
    }

    // Deleting a file is destructive and a tablet tap is easy to misfire, so
    // the first ✕ only arms the delete; it needs a second, explicit tap within
    // five seconds.  Anything else (返回, the timer, closing the sheet) cancels.
    _requestDeleteBackground(path) {
        this._cancelDeleteBackground(false);
        this._pendingDelete = path;
        this._pendingDeleteTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 5000, () => {
                this._pendingDeleteTimeoutId = 0;
                this._pendingDelete = null;
                if (this._settingsOpen)
                    this._buildBackgroundRow();
                return GLib.SOURCE_REMOVE;
            });
        this._buildBackgroundRow();
    }

    _cancelDeleteBackground(rebuild = true) {
        if (this._pendingDeleteTimeoutId) {
            GLib.source_remove(this._pendingDeleteTimeoutId);
            this._pendingDeleteTimeoutId = 0;
        }
        if (!this._pendingDelete)
            return;
        this._pendingDelete = null;
        if (rebuild && this._settingsOpen)
            this._buildBackgroundRow();
    }

    _confirmDeleteBackground(path) {
        this._cancelDeleteBackground(false);
        this._deleteBackgroundFile(path);
    }

    _deleteBackgroundFile(path) {
        try {
            Gio.File.new_for_path(path).delete(null);
        } catch (e) {
            log(`pad-osk: delete background failed: ${e}`);
            return;
        }
        const wasCurrent = this._background === path;
        if (wasCurrent) {
            this._background = null;
            this._backgroundOn = false;
            BACKGROUND_URI = null;
        }
        this._applyScale();
        this._saveConfig();
        log(`pad-osk: deleted background ${path}`
            + (wasCurrent ? ' (was in use, cleared)' : ''));
        if (this._settingsOpen)
            this._buildBackgroundRow();
    }

    // Which button in the 背景 row reads as selected: 无 is selected when the
    // backdrop is switched off, an image when it is on *and* that image is the
    // remembered one.
    _backgroundActive(value) {
        if (value === null)
            return !this._backgroundOn;
        return !!this._backgroundOn && this._background === value;
    }

    _updateBackgroundButtons() {
        for (const [key, btn] of Object.entries(this._backgroundBtns ?? {})) {
            const value = key === '__none__' ? null : key;
            btn.style = sizeBtnStyle(this._backgroundActive(value), this._scale);
        }
    }

    // Picking an image turns it on; picking 无 switches it off but keeps the
    // last path, so the picture is one tap away instead of a trip through the
    // file chooser.  Only deleting the file forgets it for good.
    _setBackground(path) {
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        if (path) {
            const uri = this._backgroundUri(path);
            if (!uri)
                return;
            this._background = path;
            this._backgroundOn = true;
            BACKGROUND_URI = uri;
        } else {
            this._backgroundOn = false;
            BACKGROUND_URI = null;
        }
        this._applyScale();
        this._saveConfig();
        this._updateBackgroundButtons();
        log(`pad-osk: background -> ${this._backgroundOn
            ? this._background : `(off, kept ${this._background ?? 'none'})`}`);
        this._reflow(oldHeight);
    }

    // Copies a picture chosen anywhere on disk into the backdrop folder, so it
    // shows up in 管理 (where it can be switched or deleted) and keeps working
    // if the original is moved.  Returns the path to use.
    _importBackground(path) {
        try {
            const dir = this._backgroundDir();
            if (GLib.path_get_dirname(path) === dir)
                return path;             // already in the folder
            GLib.mkdir_with_parents(dir, 0o755);
            const base = GLib.path_get_basename(path);
            const stem = base.replace(/\.[^.]+$/, '');
            const ext = (base.match(/\.[^.]+$/) ?? [''])[0];
            let dest = GLib.build_filenamev([dir, base]);
            for (let n = 1; GLib.file_test(dest, GLib.FileTest.EXISTS); n++)
                dest = GLib.build_filenamev([dir, `${stem}-${n}${ext}`]);
            Gio.File.new_for_path(path).copy(
                Gio.File.new_for_path(dest),
                Gio.FileCopyFlags.OVERWRITE, null, null);
            log(`pad-osk: imported background -> ${dest}`);
            return dest;
        } catch (e) {
            log(`pad-osk: background import failed: ${e}`);
            return path;                 // use the original location instead
        }
    }

    _buildResetRow() {
        const row = new St.BoxLayout({reactive: false});
        row.add_child(this._sectionLabel(T('Defaults')));
        this._resetBtn = new St.Button({
            child: new St.Label({
                text: T('Reset to defaults'),
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: sizeBtnStyle(false, this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._resetBtn.connect('clicked', () => this._resetDefaults());
        row.add_child(this._resetBtn);
        this._settings.add_child(row);
    }

    // Back to the shipping look and the default spot: medium, graphite, fully
    // opaque, no backdrop, bottom centre.  [custom] is left alone -- it is the
    // user's own palette, not a setting this button owns.
    _resetDefaults() {
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._steps = this._readScales();
        this._sizeName = DEFAULT_SIZE;
        this._scale = findStep(this._steps, DEFAULT_SIZE).scale;
        this._themeName = DEFAULT_THEME;
        THEME = this._themes.find(t => t.name === DEFAULT_THEME);
        this._opacity = DEFAULT_OPACITY;
        OPACITY = DEFAULT_OPACITY;
        this._radius = DEFAULT_RADIUS;
        RADIUS = DEFAULT_RADIUS;
        // The backdrop is only switched off, not forgotten: resetting the look
        // should not cost the user the picture they picked.  Deleting it is the
        // 管理 background screen's job.
        this._backgroundOn = false;
        BACKGROUND_URI = null;
        this._applyScale();
        this._saveConfig();
        log('pad-osk: reset to defaults');
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._box && this._placed) {
                this._placeDefault();
                this._saveConfig();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._reflow(oldHeight);
    }

    _sectionLabel(text) {
        const label = new St.Label({
            text,
            y_align: Clutter.ActorAlign.CENTER,
            style: sectionLabelStyle(this._scale),
        });
        this._sectionLabels.push(label);
        return label;
    }

    _toggleSettings() {
        if (!this._settings)
            return;
        if (this._settingsOpen) {
            this._closeSettings();
            return;
        }
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        // Only one sheet at a time: opening settings puts emoji away.
        this._closeEmoji(false);
        // Re-scan the backgrounds folder on every open: dropping a new image in
        // must not require a re-login.
        this._buildBackgroundRow();
        this._settingsOpen = true;
        this._settings.visible = true;
        this._reflow(oldHeight);
    }

    // ---- emoji layer --------------------------------------------------
    // Not a popup and not a separate card: pressing 😀 swaps the four letter
    // rows for the emoji grid, keeping the panel's width and the bottom row
    // (space / enter / 😀 again to come back).  The grid is laid out like keys,
    // one row per line, so it reads as another keyboard layer.
    _buildEmoji() {
        this._emojiPage = 0;
        this._emojiOpen = false;
        this._emojiBtns = [];
        this._emojiPanel = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            x_expand: true,
            style: settingsPanelStyle(this._scale),
        });
        this._box.add_child(this._emojiPanel);
        this._fillEmojiPage();
    }

    _fillEmojiPage() {
        if (!this._emojiPanel)
            return;
        this._emojiPanel.destroy_all_children();
        this._emojiBtns = [];
        const page = EMOJI_PAGES[this._emojiPage] ?? [];
        for (let i = 0; i < page.length; i += 8) {
            const row = new St.BoxLayout({
                reactive: false,
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });
            for (const glyph of page.slice(i, i + 8)) {
                const btn = new St.Button({
                    child: new St.Label({
                        text: glyph,
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                    style: emojiBtnStyle(this._scale),
                    reactive: true,
                    x_expand: true,
                    can_focus: false,
                    track_hover: true,
                });
                btn.connect('clicked', () => this._emitEmoji(glyph));
                row.add_child(btn);
                this._emojiBtns.push(btn);
            }
            this._emojiPanel.add_child(row);
        }

        // Pager: ‹ 1/3 ›
        const pager = new St.BoxLayout({
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._emojiPrev = new St.Button({
            child: new St.Label({text: '‹', y_align: Clutter.ActorAlign.CENTER}),
            style: gripBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._emojiPrev.connect('clicked', () => this._setEmojiPage(-1));
        pager.add_child(this._emojiPrev);
        this._emojiPageLabel = new St.Label({
            text: `${this._emojiPage + 1}/${EMOJI_PAGES.length}`,
            y_align: Clutter.ActorAlign.CENTER,
            style: sectionLabelStyle(this._scale),
        });
        pager.add_child(this._emojiPageLabel);
        this._emojiNext = new St.Button({
            child: new St.Label({text: '›', y_align: Clutter.ActorAlign.CENTER}),
            style: gripBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._emojiNext.connect('clicked', () => this._setEmojiPage(1));
        pager.add_child(this._emojiNext);
        this._emojiPanel.add_child(pager);
    }

    _toggleEmoji() {
        if (!this._emojiPanel)
            return;
        if (this._emojiOpen) {
            this._closeEmoji();
            return;
        }
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._closeSettings(false);
        this._fillEmojiPage();
        this._setEmojiLayer(true);
        this._reflow(oldHeight);
    }

    _closeEmoji(reflow = true) {
        if (!this._emojiPanel || !this._emojiOpen)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._setEmojiLayer(false);
        if (reflow)
            this._reflow(oldHeight);
    }

    // The emoji grid takes the place of the four letter rows; the bottom row
    // stays visible so space, enter and the 😀 key itself remain reachable.
    _setEmojiLayer(show) {
        const rows = this._rowWidgets ?? [];
        const keep = rows.length > 1 ? rows[rows.length - 1] : null;
        for (const row of rows)
            row.visible = !show || row === keep;
        if (this._emojiPanel)
            this._emojiPanel.visible = show;
        this._emojiOpen = show;
    }

    _setEmojiPage(delta) {
        const count = EMOJI_PAGES.length;
        this._emojiPage = (this._emojiPage + delta + count) % count;
        this._fillEmojiPage();
    }

    // Two ways to deliver a character that is not on the XKB keymap:
    //   paste  - put it on the clipboard and send Ctrl+V.  Works everywhere
    //            (Firefox, Chromium, Electron, GTK), which is why it is default.
    //   keysym - notify_keyval(0x01000000|cp).  Cleaner (no clipboard), but the
    //            compositor has to map a keysym that no keycode carries; many
    //            toolkits drop it.  Kept for the apps where it does work.
    // Override with [layout] emoji_mode=keysym|paste in position.kf.
    _emitEmoji(glyph) {
        const mode = (this._emojiMode || 'paste').toLowerCase();
        if (mode === 'keysym')
            this._emitEmojiKeysym(glyph);
        else
            this._emitEmojiPaste(glyph);
    }

    _emitEmojiKeysym(glyph) {
        if (!this._vdev)
            return;
        const code = glyph.codePointAt(0);
        const keysym = Clutter.unicode_to_keysym(code);
        if (!keysym)
            return;
        const t = Clutter.get_current_event_time();
        this._vdev.notify_keyval(t, keysym, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, keysym, Clutter.KeyState.RELEASED);
        this._clearStickyMods();
        log(`pad-osk: emoji U+${code.toString(16).toUpperCase()}`
            + ` via keysym 0x${keysym.toString(16)}`);
    }

    _emitEmojiPaste(glyph) {
        if (!this._vdev)
            return;
        const code = glyph.codePointAt(0);
        try {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD, glyph);
        } catch (e) {
            log(`pad-osk: emoji clipboard failed: ${e}`);
            return;
        }

        const t = Clutter.get_current_event_time();
        const v = Clutter.unicode_to_keysym('v'.codePointAt(0));
        this._vdev.notify_keyval(t, XK.Control_L, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, v, Clutter.KeyState.PRESSED);
        this._vdev.notify_keyval(t, v, Clutter.KeyState.RELEASED);
        this._vdev.notify_keyval(t, XK.Control_L, Clutter.KeyState.RELEASED);
        this._clearStickyMods();
        log(`pad-osk: emoji U+${code.toString(16).toUpperCase()}`
            + ' via clipboard+Ctrl+V');
    }

    // An emoji must never arrive as Ctrl/Alt/Super+something.
    _clearStickyMods() {
        this._mods = {ctrl: false, alt: false, super: false};
        this._shift = false;
        this._updateVisuals();
    }

    // Collapsing the panel or hiding the keyboard both put the sheet away, so a
    // sheet is never left open on top of a keyboard that is not on screen.
    // Callers that reflow themselves pass `false`: two pending reflows would
    // each shift the panel by a height the other already accounted for.
    _closeSettings(reflow = true) {
        if (!this._settings || !this._settingsOpen)
            return;
        this._cancelDeleteBackground(false);
        this._bgMode = 'pick';
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._settingsOpen = false;
        this._settings.visible = false;
        if (reflow)
            this._reflow(oldHeight);
    }

    // ---- theme (深灰 / 浅色 / 暖色 / 高对比 / 自定义) -----------------
    // Restyle in place, exactly like a size change: nothing is rebuilt, so a
    // finger resting on a key keeps the button it started on.
    _setTheme(name) {
        const theme = this._themes.find(t => t.name === name);
        if (!theme || theme.name === this._themeName)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        THEME = theme;
        this._themeName = name;
        this._applyScale();
        this._saveConfig();
        log(`pad-osk: theme -> ${name}`);
        this._reflow(oldHeight);
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
        log(`pad-osk: size -> ${name} (scale ${this._scale})`);

        // Keep the bottom edge where it is: the panel grows upward instead of
        // pushing itself off the bottom of the screen.
        this._reflow(oldHeight);
    }

    // ---- transparency (100% .. 50%) ----------------------------------
    // One actor-level alpha for the whole panel: keys, glyphs, grip bar and the
    // settings sheet fade together, so it reads as a piece of glass rather than
    // a see-through frame with solid keys on it.
    _setOpacity(value) {
        const clamped = Math.min(1, Math.max(OPACITY_MIN, Math.round(value * 100) / 100));
        if (Math.abs(clamped - this._opacity) < 0.001)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._opacity = clamped;
        OPACITY = clamped;
        this._applyScale();
        this._saveConfig();
        log(`pad-osk: opacity -> ${Math.round(clamped * 100)}%`);
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
            log(`pad-osk: panel ${width}x${newHeight} `
                + `(${pct}% of ${mon ? mon.width : 0}px, step ${this._sizeName} `
                + `scale ${this._scale})`);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyScale() {
        const s = this._scale;
        if (this._box) {
            this._box.style = boxStyle(s);
            // Whole-panel transparency (0-255): mutter paints the actor and
            // every child with this alpha, which is exactly "the whole keyboard
            // fades", with no per-key style to keep in sync.
            this._box.opacity = Math.round(OPACITY * 255);
        }
        if (this._grip)
            this._grip.style = gripStyle(s);
        if (this._settingsBtn)
            this._settingsBtn.style = gripBtnStyle(s);
        if (this._collapseBtn)
            this._collapseBtn.style = gripBtnStyle(s);
        if (this._closeBtn)
            this._closeBtn.style = closeBtnStyle(s);
        if (this._settings)
            this._settings.style = settingsPanelStyle(s);
        for (const label of this._sectionLabels ?? [])
            label.style = sectionLabelStyle(s);
        for (const {btn, kind, minW, mod} of this._styledKeys) {
            const active = mod ? this._modActive(mod) : false;
            btn.style = keyStyle(active ? 'on' : kind, minW, s);
        }
        for (const glyph of this._shiftGlyphs)
            glyph.style = shiftGlyphStyle(this._shift, s);
        this._updateSizeButtons();
        this._updateThemeButtons();
        this._updateOpacityButtons();
        this._updateRadiusButtons();
        if (this._resetBtn)
            this._resetBtn.style = sizeBtnStyle(false, s);
        this._styleIfAlive(this._pickBtn, sizeBtnStyle(false, s));
        this._styleIfAlive(this._manageBtn, sizeBtnStyle(false, s));
        this._updateBackgroundButtons();
        for (const btn of this._emojiBtns ?? [])
            this._styleIfAlive(btn, emojiBtnStyle(s));
        this._styleIfAlive(this._emojiPrev, gripBtnStyle(s));
        this._styleIfAlive(this._emojiNext, gripBtnStyle(s));
        this._styleIfAlive(this._emojiPageLabel, sectionLabelStyle(s));
    }

    // A button kept in a member can be destroyed by a row rebuild; touching a
    // disposed actor throws "has been already disposed" inside the shell, so
    // every optional restyle goes through here.
    _styleIfAlive(actor, css) {
        try {
            if (actor)
                actor.style = css;
        } catch (e) {
            log(`pad-osk: restyle skipped (${e.message ?? e})`);
        }
    }

    _updateSizeButtons() {
        for (const step of this._steps) {
            const btn = this._sizeBtns[step.name];
            if (btn)
                btn.style = sizeBtnStyle(step.name === this._sizeName, this._scale);
        }
    }

    _updateThemeButtons() {
        for (const theme of this._themes) {
            const btn = this._themeBtns[theme.name];
            if (btn)
                btn.style = themeBtnStyle(
                    theme.name === this._themeName, this._scale, theme);
        }
    }

    _updateOpacityButtons() {
        for (const step of OPACITY_STEPS) {
            const btn = this._opacityBtns[step.value];
            if (btn)
                btn.style = sizeBtnStyle(
                    Math.abs(step.value - this._opacity) < 0.001, this._scale);
        }
    }

    // ---- corner radius (直角 / 小 / 中 / 大) ---------------------------
    // Same in-place restyle as everything else: the number flows through the
    // style helpers, which derive the panel, grip, button and sheet radii from
    // it so the proportions of the shipped look survive every step.
    _setRadius(value) {
        const clamped = Math.min(RADIUS_MAX,
            Math.max(RADIUS_MIN, Math.round(value)));
        if (Math.abs(clamped - this._radius) < 0.001)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._radius = clamped;
        RADIUS = clamped;
        this._applyScale();
        this._saveConfig();
        log(`pad-osk: radius -> ${clamped}`);
        this._reflow(oldHeight);
    }

    _updateRadiusButtons() {
        for (const step of RADIUS_STEPS) {
            const btn = this._radiusBtns[step.value];
            if (btn)
                btn.style = sizeBtnStyle(
                    Math.abs(step.value - this._radius) < 0.001, this._scale);
        }
    }

    // ---- key rows ----------------------------------------------------
    _buildRows() {
        this._rowWidgets = [];
        for (const row of LAYOUT) {
            const r = new St.BoxLayout({
                reactive: false,
                x_align: Clutter.ActorAlign.CENTER,
            });
            for (const def of row)
                r.add_child(this._key(def));
            this._rowsBox.add_child(r);
            this._rowWidgets.push(r);
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
                text: T(def.label),
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

        if (def.emoji) {
            btn.connect('clicked', () => this._toggleEmoji());
        } else if (def.ime) {
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
        // Collapsing to the thin bar must not leave a sheet behind.
        if (!show) {
            this._closeSettings(false);
            this._closeEmoji(false);
        }
        if (this._collapseBtn) {
            const label = this._collapseBtn.get_child();
            if (label)
                label.text = show ? 'v' : '^';
        }
        this._reflow(oldHeight);
    }

    _setVisible(visible, writeState = true) {
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        if (!visible) {
            this._repeatCancel();
            this._closeSettings(false);
            this._closeEmoji(false);
        }
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
        if (this._qsToggle && this._qsToggle.checked !== visible) {
            // Mark the write as ours so the toggle's handler does not treat it
            // as a user request (which would write the state file behind our
            // back -- see the OskToggle handler).
            this._syncingToggle = true;
            try {
                this._qsToggle.checked = visible;
            } finally {
                this._syncingToggle = false;
            }
        }
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
            log(`pad-osk: read state failed: ${e}`);
        }
        return null;
    }

    _writeState(visible) {
        try {
            const path = this._statePath();
            GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
            GLib.file_set_contents(path, visible ? '1' : '0');
        } catch (e) {
            log(`pad-osk: write state failed: ${e}`);
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
            log(`pad-osk: state watch failed: ${e}`);
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
        log('pad-osk: modal watcher started');
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
            log('pad-osk: modal dialog opened, keyboard yielded');
        } else if (!modal && this._hiddenByModal) {
            this._hiddenByModal = false;
            if (this._readState() !== false) {
                this._setVisible(true, false);
                log('pad-osk: modal dialog closed, keyboard restored');
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
        log(`pad-osk: placed at ${this._posX},${this._posY} size ${w}x${h}`);
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
                log('pad-osk: drag timeout, releasing grab');
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

    // ---- config persistence (position + size + theme) ----------------
    _posPath() {
        return GLib.build_filenamev([GLib.get_user_config_dir(), POS_FILE]);
    }

    // Returns {x, y, size, theme, scale_small, scale_medium, scale_large}.
    // Anything the file does not carry is null: `size` falls back to
    // DEFAULT_SIZE, `theme` to DEFAULT_THEME, the three scale factors to
    // SIZE_STEPS.
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
            // [custom] holds the user's own five colours; missing keys stay null
            // and makeCustomTheme() rejects an incomplete palette.
            const custom = ['panel', 'key', 'mod', 'act', 'on'].reduce((acc, k) => {
                try {
                    acc[k] = kf.get_string('custom', k);
                } catch (e) {
                    acc[k] = null;
                }
                return acc;
            }, {});

            return {
                x: kf.get_integer('position', 'x'),
                y: kf.get_integer('position', 'y'),
                size: str('size'),
                theme: str('theme'),
                opacity: num('opacity'),
                radius: num('radius'),
                background: str('background'),
                backgroundEnabled: num('background_enabled'),
                emoji_mode: str('emoji_mode'),
                custom,
                scale_small: num('scale_small'),
                scale_medium: num('scale_medium'),
                scale_large: num('scale_large'),
            };
        } catch (e) {
            log(`pad-osk: load config failed: ${e}`);
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
            kf.set_string('layout', 'theme', this._themeName || DEFAULT_THEME);
            kf.set_string('layout', 'opacity', String(this._opacity ?? DEFAULT_OPACITY));
            kf.set_string('layout', 'radius', String(this._radius ?? DEFAULT_RADIUS));
            kf.set_string('layout', 'emoji_mode', this._emojiMode || 'paste');
            if (this._background) {
                kf.set_string('layout', 'background', this._background);
                kf.set_string('layout', 'background_enabled',
                    this._backgroundOn ? '1' : '0');
            }
            // No remove_key() here: kf is brand new, so simply not writing the
            // key already drops it.  Calling remove_key() on a fresh KeyFile
            // throws "no such key", which aborted the whole save and silently
            // lost position/size/theme/opacity every time there was no
            // background.
            // The user's palette is their own data: carry it over verbatim.
            if (prev && prev.custom) {
                for (const key of ['panel', 'key', 'mod', 'act', 'on']) {
                    if (prev.custom[key])
                        kf.set_string('custom', key, prev.custom[key]);
                }
            }
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
                theme: this._themeName || DEFAULT_THEME,
                opacity: this._opacity ?? DEFAULT_OPACITY,
                background: this._background ?? null,
                custom: prev ? prev.custom : null,
                scale_small: prev ? prev.scale_small : null,
                scale_medium: prev ? prev.scale_medium : null,
                scale_large: prev ? prev.scale_large : null,
            };
        } catch (e) {
            log(`pad-osk: save config failed: ${e}`);
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
