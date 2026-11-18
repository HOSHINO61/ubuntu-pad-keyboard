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
//   * GJS 1.88's cairo module has no Context.createLinearGradient: gradients are
//     constructed directly (new cairo.LinearGradient(x0, y0, x1, y1), then
//     addColorStopRGB on it).  The old factory-method spelling throws "is not a
//     function" at paint time, inside the shell, with nothing on screen.

import cairo from 'gi://cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
// Namespace import instead of named: gnome-shell exports `gettext` since 45,
// and a named import of something missing would break the whole module.
import * as ShellExtension from 'resource:///org/gnome/shell/extensions/extension.js';

const Extension = ShellExtension.Extension;

// A brand mark is shipped as a picture next to this file and keeps its own
// colours; the drawn icons below are monochrome line art.
const EXTENSION_DIR = GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0]);
const COOLAPK_LOGO = GLib.build_filenamev([EXTENSION_DIR, 'icons', 'coolapk.png']);

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

// 关于页显示的版本号。写在一处，免得两处 label 走散；打包时 packaging/
// DEBIAN/control 的 Version 由这里手动对齐。
const APP_VERSION = '1.1.1';

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

// 自定义配色: the five roles the picker edits.  Only the background of each role
// is chosen -- the glyph colour is derived from its luminance by
// makeCustomTheme(), so a light palette never keeps white text and the user
// never has to spell out both halves of every [bg, fg] pair.
// The roles stay distinguishable because they are separate keys, not because
// they are preset swatches:
//   panel  the sheet behind the keys
//   key    letter and number keys
//   mod    modifiers, keys that carry a label
//   act    the modifiers' darker sibling (Enter, Backspace, arrows)
//   on     the live accent (shift, armed modifiers)
const CUSTOM_ROLES = [
    {key: 'panel', label: 'Panel'},
    {key: 'key', label: 'Keys'},
    {key: 'mod', label: 'Modifiers'},
    {key: 'act', label: 'Actions'},
    {key: 'on', label: 'Accent'},
];
const CUSTOM_DEFAULT = {
    panel: '#1b2026',
    key: '#3a4048',
    mod: '#4a525c',
    act: '#434c56',
    on: '#7cc4ff',
};

// ---- 调色板 ----------------------------------------------------------
// One shared set of 24, not five role-specific rows: the same navy is the same
// navy whether it is wanted for the panel or for a key, and one grid keeps the
// editor to two lines instead of five.  Two rows of twelve line up with the
// spectrum below them (see PICK_W).
const PALETTE = [
    // neutrals, darkest to paper
    '#0f1115', '#1b2026', '#2b3340', '#3a4048', '#4a525c', '#5d6670',
    '#8a929c', '#b9c0c8', '#e9e3d7', '#f5f2ec', '#ffffff', '#000000',
    // colours: cool, green, warm, accent
    '#7cc4ff', '#2f6f9e', '#27566f', '#3f7f63', '#2f5f4a', '#8fe3a1',
    '#ffd479', '#ff9f68', '#8f5a4a', '#ff9db0', '#c7a3ff', '#6ee7d7',
];
const PALETTE_COLS = 12;
const CHIP_PX = 30;
const CHIP_GAP_PX = 4;
// The chip outline is drawn *outside* the CSS width, so it adds to the pitch.
// Leaving it out of PICK_W made the palette row ~1 border wider per chip than
// the spectrum below it, and the right edge came out ragged.
const CHIP_BORDER_PX = 2;
// Width of the picker block: twelve chips wide, so the spectrum, the brightness
// bar and the palette share one straight edge.
const PICK_W = PALETTE_COLS * (CHIP_PX + 2 * CHIP_BORDER_PX + CHIP_GAP_PX);
const SPECTRUM_H = 170;
const VALUE_H = 20;
// The bar is painted below a transparent strip, because the gap between the
// spectrum and the bar is inside the actor: no box spacing, no CSS margin, no
// layout property that might not exist -- the DrawingArea's height carries it.
const VALUE_GAP_PX = 4;

// ---- HSV picker, Windows 11 shape ------------------------------------
// Square: hue across, saturation downwards at full brightness -- the same
// orientation as the picker this keyboard copies.  St has no colour dialog and
// no gradient painter, so both areas are drawn with Cairo into St.DrawingArea.
// The picker only ever produces a hex string, which then goes through the same
// makeCustomTheme() path the config file does.
const hsvToRgb255 = (h, s, v) => {
    const hue = ((h % 360) + 360) % 360;
    const c = v * s;
    const hp = hue / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    let r = 0;
    let g = 0;
    let b = 0;
    if (hp < 1) {
        r = c; g = x;
    } else if (hp < 2) {
        r = x; g = c;
    } else if (hp < 3) {
        g = c; b = x;
    } else if (hp < 4) {
        g = x; b = c;
    } else if (hp < 5) {
        r = x; b = c;
    } else {
        r = c; b = x;
    }
    const m = v - c;
    return [r + m, g + m, b + m].map(channel => Math.round(channel * 255));
};

const hsvToHex = (h, s, v) => rgbToHex(hsvToRgb255(h, s, v));

const hexToHsv = hex => {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return {h: 0, s: 0, v: 0};
    const [r, g, b] = rgb.map(channel => channel / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta > 0) {
        if (max === r)
            h = 60 * (((g - b) / delta) % 6);
        else if (max === g)
            h = 60 * ((b - r) / delta + 2);
        else
            h = 60 * ((r - g) / delta + 4);
    }
    if (h < 0)
        h += 360;
    return {h, s: max === 0 ? 0 : delta / max, v: max};
};

// A ring at the picked point, black under white so it reads on both ends of the
// square -- without it there is no way to tell which colour is current.
const paintRing = (cr, x, y, radius) => {
    cr.setLineWidth(3);
    cr.setSourceRGBA(0, 0, 0, 0.55);
    cr.arc(x, y, radius, 0, 2 * Math.PI);
    cr.stroke();
    cr.setLineWidth(1.5);
    cr.setSourceRGBA(1, 1, 1, 0.95);
    cr.arc(x, y, radius, 0, 2 * Math.PI);
    cr.stroke();
};

// Hue across, white fading in downwards: full hue on the top edge, paper on the
// bottom one.  Blending towards white in alpha is exactly "drop the saturation"
// in sRGB, so two gradients are enough -- no per-pixel loop.
const paintSpectrum = (area, hsv) => {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    if (width > 0 && height > 0) {
        const across = new cairo.LinearGradient(0, 0, width, 0);
        for (let i = 0; i <= 6; i++) {
            const [r, g, b] = hsvToRgb255(i * 60, 1, 1).map(c => c / 255);
            across.addColorStopRGB(i / 6, r, g, b);
        }
        cr.setSource(across);
        cr.rectangle(0, 0, width, height);
        cr.fill();

        const down = new cairo.LinearGradient(0, 0, 0, height);
        down.addColorStopRGBA(0, 1, 1, 1, 0);
        down.addColorStopRGBA(1, 1, 1, 1, 1);
        cr.setSource(down);
        cr.rectangle(0, 0, width, height);
        cr.fill();

        const radius = Math.max(4, Math.round(Math.min(width, height) / 12));
        // Clamped inwards so the ring stays whole: at s=0 it sits on the bottom
        // edge and half of it used to be cut off by the surface.
        paintRing(cr,
            Math.max(radius + 1, Math.min(width - radius - 1,
                ((((hsv.h % 360) + 360) % 360) / 360) * width)),
            Math.max(radius + 1, Math.min(height - radius - 1,
                (1 - Math.max(0, Math.min(1, hsv.s))) * height)), radius);
    }
    cr.$dispose();
};

// Brightness: black on the left, this hue at full brightness on the right.
// Windows 11 keeps a second vertical strip for the same number; two controls for
// one value is one too many, so only the bar under the square is kept.
const paintValueBar = (area, hsv) => {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    // The top VALUE_GAP_PX of the actor is left unpainted, so the bar reads as
    // a separate control under the spectrum.
    const gap = Math.round(height * VALUE_GAP_PX / (VALUE_H + VALUE_GAP_PX));
    const barHeight = height - gap;
    if (width > 0 && barHeight > 1) {
        const [r, g, b] = hsvToRgb255(hsv.h, hsv.s, 1).map(c => c / 255);
        const grad = new cairo.LinearGradient(0, 0, width, 0);
        grad.addColorStopRGB(0, 0, 0, 0);
        grad.addColorStopRGB(1, r, g, b);
        cr.setSource(grad);
        cr.rectangle(0, gap, width, barHeight);
        cr.fill();

        const x = Math.max(0, Math.min(1, hsv.v)) * width;
        const radius = Math.max(3, Math.round(barHeight * 0.42));
        const cx = Math.max(radius + 1, Math.min(width - radius - 1, x));
        const cy = gap + barHeight / 2;
        cr.setLineWidth(3);
        cr.setSourceRGBA(0, 0, 0, 0.55);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
        cr.setLineWidth(2);
        cr.setSourceRGBA(1, 1, 1, 0.95);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
    }
    cr.$dispose();
};

// Settings-row icons, drawn with cairo rather than borrowed from a glyph font:
// one ink colour that follows the page text, strokes only, in a 30x30 box.
// A glyph would be one line of code, but ⌨ and 🎨 change shape per font install
// and a few of them are emoji -- on a tablet they came out with their own
// colours and no shared weight.
const ICON_COLORS = {
    size: '#4C8DFF',
    theme: '#A16BFF',
    opacity: '#35C759',
    radius: '#FF9F0A',
    background: '#30B0C7',
    info: '#8E8E93',
    reset: '#FF6B6B',
    website: '#0A84FF',
    update: '#5E5CE6',
};

const paintSettingIcon = (area, kind) => {
    const cr = area.get_context();
    const [width, height] = area.get_surface_size();
    if (width <= 0 || height <= 0)
        return;
    const size = Math.min(width, height);
    // 固定彩色：每行按功能一个颜色，和 MIUIX 的彩色图标一致。
    const accent = colorParts(ICON_COLORS[kind] ?? ICON_COLORS.info);
    const unit = Math.max(0.9, size / 15);
    cr.setSourceRGBA(accent.r / 255, accent.g / 255, accent.b / 255, 1);
    cr.setLineWidth(unit);
    cr.setLineCap(cairo.LineCap.ROUND);
    cr.translate(width / 2, height / 2);

    const half = size * 0.42;                 // drawing half-extent
    const rounded = (x, y, w, h, r) => {
        cr.moveTo(x + r, y);
        cr.lineTo(x + w - r, y);
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.lineTo(x + w, y + h - r);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.lineTo(x + r, y + h);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.lineTo(x, y + r);
        cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
        cr.closePath();
    };
    const dot = (x, y, r) => {
        cr.arc(x, y, r, 0, Math.PI * 2);
        cr.fill();
    };

    switch (kind) {
    case 'size':                              // keyboard: a frame with keys
        rounded(-half, -half * 0.62, half * 2, half * 1.24, half * 0.24);
        cr.stroke();
        for (let i = 0; i < 3; i++)
            dot(-half * 0.45 + i * half * 0.45, -half * 0.16, size / 24);
        cr.rectangle(-half * 0.6, half * 0.16, half * 1.2, half * 0.22);
        cr.fill();
        break;
    case 'theme':                             // palette: disc with paint dabs
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.stroke();
        dot(-half * 0.32, -half * 0.2, size / 20);
        dot(half * 0.28, -half * 0.3, size / 26);
        dot(half * 0.32, half * 0.28, size / 23);
        break;
    case 'opacity': {                         // half-filled disc
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.clip();
        cr.rectangle(-half, -half, half, half * 2);
        cr.fill();
        cr.resetClip();
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.stroke();
        break;
    }
    case 'radius':                            // a square with one soft corner
        rounded(-half, -half, half * 2, half * 2, half * 0.55);
        cr.stroke();
        break;
    case 'background':                        // a picture: frame, hills, sun
        rounded(-half, -half * 0.78, half * 2, half * 1.56, half * 0.2);
        cr.stroke();
        cr.arc(half * 0.52, -half * 0.36, size / 22, 0, Math.PI * 2);
        cr.fill();
        cr.moveTo(-half * 0.78, half * 0.5);
        cr.lineTo(-half * 0.2, -half * 0.02);
        cr.lineTo(half * 0.22, half * 0.34);
        cr.lineTo(half * 0.55, half * 0.1);
        cr.lineTo(half * 0.78, half * 0.5);
        cr.stroke();
        break;
    case 'info':                              // circled i
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.stroke();
        dot(0, -half * 0.42, size / 24);
        cr.moveTo(0, -half * 0.1);
        cr.lineTo(0, half * 0.45);
        cr.stroke();
        break;
    case 'reset':                             // circular arrow
        cr.arc(0, 0, half * 0.85, -Math.PI * 0.85, Math.PI * 0.62);
        cr.stroke();
        cr.moveTo(half * 0.85, -half * 0.95);
        cr.lineTo(half * 0.85, -half * 0.35);
        cr.lineTo(half * 0.28, -half * 0.6);
        cr.fill();
        break;
    case 'website':                           // globe: circle + two meridians
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.stroke();
        cr.save();
        cr.translate(0, 0);
        cr.scale(0.55, 1);
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.restore();
        cr.stroke();
        cr.moveTo(-half, 0);
        cr.lineTo(half, 0);
        cr.stroke();
        break;
    case 'update':                            // arrow into a tray
        cr.moveTo(0, -half * 0.9);
        cr.lineTo(0, half * 0.25);
        cr.stroke();
        cr.moveTo(-half * 0.42, -half * 0.18);
        cr.lineTo(0, half * 0.28);
        cr.lineTo(half * 0.42, -half * 0.18);
        cr.stroke();
        cr.moveTo(-half * 0.9, half * 0.55);
        cr.lineTo(-half * 0.9, half * 0.85);
        cr.lineTo(half * 0.9, half * 0.85);
        cr.lineTo(half * 0.9, half * 0.55);
        cr.stroke();
        break;
    case 'author': {
        // Unused: the Coolapk mark is a shipped PNG, painted by St.Icon.
        break;
    }
    default:
        cr.arc(0, 0, half, 0, Math.PI * 2);
        cr.stroke();
        break;
    }
    cr.$dispose();
};
const paletteChipStyle = (color, active, scale) => {
    const size = Math.max(16, Math.round(CHIP_PX * scale));
    const rgb = hexToRgb(color);
    const edge = !rgb
        ? 'rgba(128,128,128,0.45)'
        : luminance(rgb) < 0.22
            ? 'rgba(255,255,255,0.38)'
            : shade(color, -0.35);
    return `background-color: ${color};`
        + ` border: ${px(CHIP_BORDER_PX, scale)} solid ${active ? THEME.accent : edge};`
        + ` border-radius: ${pxSoft(6, scale)};`
        + ` width: ${size}px; height: ${size}px;`
        + ` padding: 0; margin: ${px(CHIP_GAP_PX / 2, scale)};`;
};

// A key of the 0-9A-F pad: eight per row across the picker block, so the pad
// lines up with the palette above it.  `active` marks the key under a press.
const HEX_KEY_H = 36;
const HEX_KEY_W = PICK_W / 8 - CHIP_GAP_PX;
const hexKeyStyle = (scale, active = false) =>
    `background-color: ${active ? THEME.on[0] : THEME.key[0]};`
    + ` color: ${active ? THEME.on[1] : THEME.key[1]};`
    + ` border-radius: ${pxSoft(6, scale)};`
    + ` padding: 0; margin: ${px(CHIP_GAP_PX / 2, scale)};`
    + ` font-size: ${px(15, scale)};`
    + ` width: ${Math.max(18, Math.round(HEX_KEY_W * scale))}px;`
    + ` height: ${Math.max(18, Math.round(HEX_KEY_H * scale))}px;`;


// Set by the extension from [layout] background=<path>; kept as a plain URI
// string so this section stays free of gi:// imports (the style test slices it
// out and runs it in bare Node).
let BACKGROUND_URI = null;

// LICENSE 全文（MIT）。弹窗里要能直接读完，所以贴一份在这里；打包时
// LICENSE 文件也随 deb 一起走，两处内容保持一致。
const LICENSE_TEXT = `MIT License

Copyright (c) 2026 HOSHINO6

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

// Procedurally drawn presets (512x288 PNG, generated once with Pillow):
// no third-party artwork, nothing to license, and they stay readable under
// the white key glyphs because every one of them is dark and low-contrast.
const PRESET_BACKGROUNDS = [
    {
        key: 'dusk',
        label: 'Dusk',
        data: [
            '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',
            'yf8DjM9TgSG7FW0AAAAASUVORK5CYII=',
        ].join(''),
    },
    {
        key: 'neon',
        label: 'Neon',
        data: [
            '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',
        ].join(''),
    },
    {
        key: 'slate',
        label: 'Slate',
        data: [
            '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',
        ].join(''),
    },
];

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
// Each step means a fraction of the monitor width, not a fixed scale: on a
// 1696px tablet 55% is 927px and on a 1920px desktop it is 1056px, so the
// keyboard keeps the same visual weight everywhere.  `scale` is the seed value
// measured on the 1696px tablet; _setSize() turns the fraction into a scale and
// _reflow() corrects it once from the real panel width (text labels make the
// width slightly non-linear in the scale).
const SIZE_STEPS = [
    {name: 'xsmall', label: 'Smaller', scale: 0.60, fraction: 0.45},
    {name: 'small', label: 'Small', scale: 0.72, fraction: 0.55},
    {name: 'medium', label: 'Medium', scale: 0.85, fraction: 0.66},
    {name: 'large', label: 'Large', scale: 0.99, fraction: 0.76},
    {name: 'xlarge', label: 'Larger', scale: 1.08, fraction: 0.85},
];
const DEFAULT_SIZE = 'medium';
const SCALE_MIN = 0.40;
const SCALE_MAX = 2.00;
// Panel width at scale 1.00, from the 1.0 measurements (1120px at 0.85).
const REFERENCE_PANEL_WIDTH = 1310;

function clampScale(value) {
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN,
        Math.round(value * 100) / 100));
}

function findStep(steps, name) {
    return steps.find(s => s.name === name)
        ?? steps.find(s => s.name === DEFAULT_SIZE)
        ?? steps[0];
}

// The scale that should make `step` occupy its fraction of this monitor.
// A step with an explicit scale_<name>= override keeps that exact value.
function scaleForStep(step) {
    if (step.scaleFixed || !step.fraction)
        return step.scale;
    const mon = Main.layoutManager.primaryMonitor;
    if (!mon || !mon.width)
        return step.scale;
    return clampScale(step.fraction * mon.width / REFERENCE_PANEL_WIDTH);
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
// RADIUS 0 means square everywhere -- including the panel, the grip bar and
// the settings sheet, which used to keep a 10-16px rounding and made the
// "square" step look half-done.  Anything above 0 keeps the proportion of the
// shipped design (keys 8, panel 16, grip 10, small buttons 8, sheet 12).
const radiusKey = () => RADIUS;
const radiusPanel = () => (RADIUS === 0 ? 0 : Math.max(16, RADIUS * 2));
const radiusGrip = () => (RADIUS === 0 ? 0 : Math.max(10, RADIUS + 2));
const radiusSmall = () => (RADIUS === 0 ? 0 : Math.max(8, RADIUS));
const radiusSheet = () => (RADIUS === 0 ? 0 : Math.max(12, RADIUS + 4));

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

// The size selector reads as a segmented control: the active step gets a
// subtle fill, the others stay outlined so they never compete with the keys.
const sizeBtnStyle = (active, scale) => {
    const fg = colorParts(panelFgFor(THEME));
    const dark = (fg.r + fg.g + fg.b) <= 382;
    const selBg = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.08)';
    const border = active
        ? ''
        : ` border: ${px(1, scale)} solid rgba(128,128,128,0.35);`;
    return `background-color: ${active ? selBg : 'transparent'};`
        + ` color: ${pageFg()};`
        + border
        + ` border-radius: ${pxSoft(radiusSmall(), scale)};`
        + ` padding: ${px(6, scale)} ${px(16, scale)};`
        + ` margin: ${px(3, scale)}; font-size: ${px(20, scale)};`;
};

// A theme button carries its own colours (that is the preview); the border is
// what marks the active one.  The border is always drawn, in the swatch colour
// when idle, so switching themes cannot leave a stale outline behind.
// Win11-style theme picker: a preview card rather than a text button.  Each
// card paints its own panel colour and shows a row of key chips, so the palette
// is visible before it is applied.
const themeCardStyle = (active, scale, theme) =>
    `background-color: rgb(${theme.panel});`
    + ` border: ${px(2, scale)} solid `
    + `${active ? THEME.accent : 'rgba(128,128,128,0.45)'};`
    + ` border-radius: ${pxSoft(Math.max(8, radiusSmall() + 4), scale)};`
    + ` padding: ${px(7, scale)} ${px(10, scale)};`
    + ` margin: ${px(3, scale)};`;

const themeChipStyle = (color, wide, scale) =>
    `background-color: ${color};`
    + ` border-radius: ${pxSoft(Math.max(3, radiusSmall() - 3), scale)};`
    + ` width: ${Math.round((wide ? 28 : 13) * scale)}px;`
    + ` height: ${Math.round(13 * scale)}px;`
    + ` margin: ${px(2, scale)};`;

// The card paints itself in the panel colour, so anything written on it has to
// contrast with the *panel*, not with the key colour.  theme.key[1] used to be
// used for this and works for the four presets only because their key and panel
// brightness agree; a custom palette can pair a white panel with a dark key
// whose glyph colour is white, and then the name is white on white.
const panelFgFor = theme => {
    const panel = String(theme.panel ?? '');
    // theme.panel is 'r,g,b' for the presets and '#rrggbb' for the custom
    // palette; a bare rrggbb is accepted too so this never silently turns into
    // black (which would put white on white again).
    const hex = /^#/.test(panel) ? panel
        : /^[0-9a-f]{6}$/i.test(panel) ? `#${panel}`
        : `#${panel.split(',').map(v => {
            const n = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
            return n.toString(16).padStart(2, '0');
        }).join('')}`;
    return fgFor(hex);
};

// The emoji grid is a layer *inside* the panel, so it needs its own tint to
// read as a separate surface; panelAlt is that tint per theme.
const settingsPanelStyle = scale =>
    `background-color: ${THEME.panelAlt};`
    + ` border-radius: ${pxSoft(radiusSheet(), scale)};`
    + ` padding: ${px(8, scale)};`
    + ` margin: ${px(3, scale)} ${px(3, scale)} 0 ${px(3, scale)};`;

// Settings are a card that floats over the application, not a strip inside the
// keyboard: same tint, but with a border and a shadow so it reads as a dialog.
// The close button and the padding live on the card, not on the scrolling
// contents, so the header stays put while the body scrolls.
// The panel tint is translucent on purpose: it sits on the slab, which already
// paints the panel colour behind it.  A card that floats over the desktop has
// nothing behind it, so the two have to be flattened into one colour -- used
// as-is, panelAlt let the wallpaper and the keyboard read through the card.
const colorParts = css => {
    const text = String(css ?? '').trim();
    const rgba = text.match(/^rgba?\(([^)]+)\)$/i);
    if (rgba) {
        const parts = rgba[1].split(',').map(v => Number(v.trim()));
        return {
            r: parts[0] || 0,
            g: parts[1] || 0,
            b: parts[2] || 0,
            a: parts.length > 3 ? Math.max(0, Math.min(1, parts[3])) : 1,
        };
    }
    const hex = text.replace('#', '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 1,
        };
    }
    const tri = text.split(',').map(v => Number(v.trim()));
    if (tri.length === 3 && tri.every(n => Number.isFinite(n)))
        return {r: tri[0], g: tri[1], b: tri[2], a: 1};
    return {r: 0, g: 0, b: 0, a: 1};
};

const cardBg = theme => {
    const base = colorParts(theme.panel);
    const over = colorParts(theme.panelAlt);
    const mix = channel =>
        Math.round(over[channel] * over.a + base[channel] * (1 - over.a));
    const alpha = theme.panelAlpha ?? 0.98;
    return `rgba(${mix('r')}, ${mix('g')}, ${mix('b')}, ${alpha})`;
};

const settingsCardStyle = scale =>
    `background-color: ${cardBg(THEME)};`
    + ` border-radius: ${pxSoft(radiusSheet(), scale)};`
    + ` padding: ${px(12, scale)};`
    + ` box-shadow: 0 ${px(6, scale)} ${px(18, scale)} rgba(0, 0, 0, 0.28);`;

// The card already paints the surface, so the contents inside only carry layout.
const settingsContentStyle = () => 'padding: 0; margin: 0;';

// MIUIX-shaped page: one large title, then rounded cards of rows.  A row is an
// icon, a title over a hint, the current value and a chevron; the controls the
// row hides open underneath it.  The block tint follows the text colour, so a
// light theme gets a slightly darker card and a dark theme a slightly lighter
// one -- the same relationship MIUIX keeps between page and group.
const pageFg = () => panelFgFor(THEME);

// Secondary text: the same ink as the page, thinned until it stops competing
// with the row title.  Mixing the accent in here was the mistake that made the
// current value unreadable on a light card.
const pageFgSoft = (alpha) => {
    const c = colorParts(panelFgFor(THEME));
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
};

const groupBg = () => {
    const fg = colorParts(panelFgFor(THEME));
    // 判断依据是页面文字色的明暗：浅色页上文字是深色，组卡要比页面更白；
    // 深色页上文字是浅色，组卡只是比页面亮一点点。
    return (fg.r + fg.g + fg.b) > 382
        ? 'rgba(255, 255, 255, 0.09)'
        : 'rgba(255, 255, 255, 0.88)';
};

const settingsPageTitleStyle = scale =>
    `color: ${pageFg()};`
    + ` font-size: ${px(30, scale)};`
    + ` font-weight: bold;`
    + ` margin: ${px(6, scale)} ${px(2, scale)} ${px(10, scale)} ${px(4, scale)};`;

const settingsGroupStyle = scale =>
    `background-color: ${groupBg()};`
    + ` border-radius: ${pxSoft(20, scale)};`
    + ` padding: ${px(4, scale)} 0;`
    + ` margin: ${px(8, scale)} 0;`;

const settingsRowStyle = scale =>
    `padding: ${px(16, scale)} ${px(16, scale)};`
    + ` border-radius: ${pxSoft(18, scale)};`;

// Row text keeps its desktop size: the page scales with the keyboard, and a
// 12px hint that follows the 0.55 size step lands at 10px, which reads as grey
// noise rather than a second line.
const settingsRowTitleStyle = scale =>
    `color: ${pageFg()}; font-size: ${Math.round(15 + 1.5 * scale)}px;`
    + ' font-weight: bold;';

const settingsRowHintStyle = scale =>
    `color: ${pageFgSoft(0.62)}; font-size: 12px;`;

const settingsRowValueStyle = scale =>
    `color: ${pageFgSoft(0.78)}; font-size: ${px(14, scale)};`
    + ` margin: 0 ${px(8, scale)} 0 ${px(10, scale)};`;

const settingsRowChevronStyle = scale =>
    `color: ${pageFgSoft(0.42)}; font-size: ${px(18, scale)};`
    + ` margin: 0 ${px(2, scale)} 0 0;`;

const settingsSeparatorStyle = scale =>
    'background-color: transparent;'
    + ' height: 0; margin: 0;';

// The grip's ✕ is a chunky filled pill because it sits on keys; on the sheet
// it is a quiet glyph, so the card does not grow a second title bar.
const settingsCloseBtnStyle = scale =>
    `color: ${pageFgSoft(0.6)}; background-color: transparent;`
    + ` border-radius: ${pxSoft(10, scale)};`
    + ` padding: ${px(1, scale)} ${px(8, scale)};`
    + ` margin: ${px(2, scale)} ${px(4, scale)} 0 0;`
    + ` font-size: ${px(18, scale)};`;

// The sub-page's way back, sitting where MIUIX puts it: a bare chevron to the
// left of the page title, in the page's own ink so it reads as navigation and
// not as another button.
const settingsBackBtnStyle = scale =>
    `color: ${pageFgSoft(0.85)}; background-color: transparent;`
    + ` border-radius: ${pxSoft(10, scale)};`
    + ` padding: ${px(2, scale)} ${px(16, scale)} ${px(2, scale)} ${px(4, scale)};`
    + ` font-size: ${px(38, scale)};`;

const settingsDetailsStyle = scale =>
    `padding: ${px(4, scale)} ${px(12, scale)} ${px(12, scale)} ${px(12, scale)};`;

const sectionLabelStyle = scale =>
    `color: ${THEME.grip[1]};`
    + ` font-size: ${px(16, scale)};`
    + ` padding: ${px(2, scale)} ${px(12, scale)} ${px(2, scale)} ${px(4, scale)};`;

// A role button in the palette editor: filled with the colour that role has
// right now, outlined with the theme accent while it is the role the picker
// edits, and its label in the contrasting glyph colour so it stays readable on
// a light palette.
const roleBtnStyle = (color, active, scale) =>
    `background-color: ${color}; color: ${fgFor(color)};`
    + ` border: ${px(2, scale)} solid `
    + `${active ? THEME.accent : shade(color, -0.35)};`
    + ` border-radius: ${pxSoft(6, scale)};`
    + ` padding: ${px(4, scale)} ${px(10, scale)};`
    + ` margin: ${px(2, scale)}; font-size: ${px(15, scale)};`;

// The hex readout under the picker is data, not a preview of the colour, so it
// uses the sheet's own label colour.
const hexReadoutStyle = scale =>
    `color: ${THEME.grip[1]}; font-size: ${px(15, scale)};`
    + ` padding: ${px(2, scale)} ${px(4, scale)};`;

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
            this._scale = scaleForStep(findStep(this._steps, this._sizeName));

            // The custom palette has to exist before the remembered theme name
            // is resolved, because 'custom' is only a valid choice once it does.
            this._customHex = {...CUSTOM_DEFAULT};
            if (cfg && cfg.custom) {
                for (const role of Object.keys(CUSTOM_DEFAULT)) {
                    const value = cfg.custom[role];
                    if (typeof value === 'string' && hexToRgb(value))
                        this._customHex[role] = value;
                }
            }
            this._custom = makeCustomTheme(this._customHex);
            this._themes = [...THEMES, this._custom];
            // The picker starts on the panel colour, which is the one a user
            // most often wants to change first.
            this._pickerRole = 'panel';
            this._pickerHsv = hexToHsv(this._customHex.panel);
            this._pickDrag = false;
            this._hexInput = null;
            this._paletteSnapshot = null;
            this._paletteId = 0;
            this._saveId = 0;
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
            this._monitorFitId = 0;
            this._dragging = false;
            this._panelDrag = null;
            this._grabId = 0;
            this._scrollDrag = null;
            this._scrollSwallowRelease = false;
            this._cardDrag = null;
            this._cardDragSwallowRelease = false;
            this._cardOffsetX = 0;
            this._cardOffsetY = 0;
            this._cardPlaced = false;
            this._cardHeaderH = 0;
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

            // Above the slab in z-order: the card is opened deliberately and
            // must never end up behind the keyboard it was detached from.  It
            // lives on uiGroup rather than inside the top-chrome container:
            // that container is only as big as its children's preferred size,
            // so a card painted outside it is also outside the chrome's input
            // region and takes no clicks at all.  Added after the chrome on
            // purpose -- children stack in insertion order, and adding it first
            // put the translucent keyboard on top of the card.
            Main.uiGroup.add_child(this._settingsCard);

            this._box.connect('notify::allocation',
                this._onAllocation.bind(this));
            // 整块面板都能拖：只要按下的地方不是按键/按钮，就按拖动处理。
            this._box.connect('captured-event',
                this._onPanelDragEvent.bind(this));
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
        if (this._monitorFitId) {
            GLib.source_remove(this._monitorFitId);
            this._monitorFitId = 0;
        }
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        if (this._paletteId) {
            GLib.source_remove(this._paletteId);
            this._paletteId = 0;
        }
        if (this._monitorId) {
            Main.layoutManager.disconnect(this._monitorId);
            this._monitorId = 0;
        }
        if (this._settingsLayoutId) {
            GLib.source_remove(this._settingsLayoutId);
            this._settingsLayoutId = 0;
        }
        if (this._settingsCard) {
            try {
                const parent = this._settingsCard.get_parent();
                if (parent)
                    parent.remove_child(this._settingsCard);
            } catch (e) {
                log(`pad-osk: card detach failed: ${e}`);
            }
        }
        if (this._licenseCard) {
            try {
                const parent = this._licenseCard.get_parent();
                if (parent)
                    parent.remove_child(this._licenseCard);
                this._licenseCard.destroy();
            } catch (e) {
                log(`pad-osk: license detach failed: ${e}`);
            }
            this._licenseCard = null;
            this._licenseScroll = null;
            this._licenseBody = null;
            this._licenseTitle = null;
            this._licenseCloseBtn = null;
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
        this._settingsCard = null;
        this._settingsScroll = null;
        this._settingsTitle = null;
        this._settingsCloseBtn = null;
        this._settingsBtn = null;
        this._emojiPanel = null;
        this._emojiBtns = [];
        this._emojiPrev = null;
        this._emojiNext = null;
        this._emojiPageLabel = null;
        this._emojiOpen = false;
        this._savedConfig = null;
        this._custom = null;
        this._customBox = null;
        this._roleBtns = {};
        this._paletteBtns = [];
        this._spectrum = null;
        this._valueBar = null;
        this._hexPad = null;
        this._hexKeys = [];
        this._hexLabel = null;
        this._hexBack = null;
        this._hexInput = null;
        this._moreBtn = null;
        this._doneBtn = null;
        this._revertBtn = null;
        this._paletteSnapshot = null;
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

        // 面板整体可拖了，这里不再放「拖动」按钮：把手只留 ⚙ / ⌄ / ✕。
        // ⚙ -- the size and the palette both moved in here; the grip bar only
        // keeps the controls you reach for mid-sentence.
        this._settingsBtn = new St.Button({
            child: new St.Label({
                text: `⚙ ${T('Settings')}`,
                y_align: Clutter.ActorAlign.CENTER,
            }),
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

    // ---- settings page (⚙) --------------------------------------------
    // MIUIX-shaped, not a stack of button rows: a large title, then cards of
    // rows.  Each row is [icon] [title over a hint] .... [value] [›], and tapping
    // it reveals the controls that used to sit in the open -- one row at a time,
    // so the page stays short on an 800px tablet and nothing has to be scrolled
    // past to reach the bottom.
    //
    // Still not a St.PopupMenu: a popup takes a shell grab, and grabs are exactly
    // what makes touch unreliable here (see the click-gesture note in
    // _attachRepeat).
    _buildSettings() {
        this._settings = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: true,
            style: settingsContentStyle(),
        });
        this._sectionLabels = [];
        this._sections = {};
        this._groups = [];
        this._rows = [];
        this._rowTitles = [];
        this._rowHints = [];
        this._rowTexts = [];
        this._rowValues = [];
        this._rowChevrons = [];
        this._rowSeparators = [];
        this._iconAreas = [];

        // The card carries two pages: the settings list, and a 关于 sub-page
        // reached from its last row.  The three link rows and the reset button
        // live on the sub-page so the list stays short enough to fit above a
        // keyboard on a 1080p screen without scrolling.
        this._pages = new St.BoxLayout({vertical: true, reactive: false});
        this._pages.add_child(this._settings);

        this._pageTitle = new St.Label({
            text: T('Settings'),
            x_align: Clutter.ActorAlign.START,
            style: settingsPageTitleStyle(this._scale),
        });
        this._settings.add_child(this._pageTitle);

        // ---- 外观: size / theme / opacity / radius -------------------
        const lookGroup = this._newGroup();

        const sizeDetails = this._newSection(lookGroup, 'size',
            T('Size'), T('Size hint'), 'size');
        const sizeRow = new St.BoxLayout({reactive: false});
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
        sizeDetails.add_child(sizeRow);

        const themeDetails = this._newSection(lookGroup, 'theme',
            T('Theme'), T('Theme hint'), 'theme');
        this._themeGrid = new Clutter.GridLayout({
            column_spacing: Math.round(6 * this._scale),
            row_spacing: Math.round(6 * this._scale),
        });
        const themeGrid = new St.Widget({
            layout_manager: this._themeGrid,
            reactive: false,
            x_expand: true,
        });
        // Three across: the page is as wide as a phone, not as wide as the
        // keyboard it belongs to, so five cards in one line squeezed the labels.
        this._themeCols = 3;
        this._themes.forEach((theme, index) => {
            const btn = this._themeCard(theme);
            this._themeGrid.attach(btn,
                index % this._themeCols,
                Math.floor(index / this._themeCols), 1, 1);
            this._themeBtns[theme.name] = btn;
        });
        themeDetails.add_child(themeGrid);

        // 自定义配色: the shape of the Windows 11 picker, adapted to a card.  Two
        // things cannot be copied: the code is typed on an in-panel 0-9A-F pad
        // (nothing in top chrome can take the real keyboard), and 完成/取消 only
        // close the picker / put the palette back, because the keyboard behind
        // the card is already the preview.
        this._customBox = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
            visible: this._themeName === CUSTOM_THEME,
        });

        const roleRow = new St.BoxLayout({reactive: false});
        this._roleBtns = {};
        for (const role of CUSTOM_ROLES) {
            const btn = new St.Button({
                child: new St.Label({
                    text: T(role.label),
                    y_align: Clutter.ActorAlign.CENTER,
                }),
                style: roleBtnStyle(this._customHex[role.key],
                    role.key === this._pickerRole, this._scale),
                reactive: true,
                can_focus: false,
                track_hover: true,
            });
            btn.connect('clicked', () => this._pickRole(role.key));
            roleRow.add_child(btn);
            this._roleBtns[role.key] = btn;
        }
        this._customBox.add_child(roleRow);

        // 调色板: one shared set of 24, two rows of twelve.
        this._paletteBtns = [];
        const paletteBox = new St.BoxLayout({vertical: true, reactive: false});
        for (let row = 0; row < Math.ceil(PALETTE.length / PALETTE_COLS); row++) {
            const line = new St.BoxLayout({reactive: false});
            for (let col = 0; col < PALETTE_COLS; col++) {
                const color = PALETTE[row * PALETTE_COLS + col];
                if (!color)
                    continue;
                const btn = new St.Button({
                    style: paletteChipStyle(color, false, this._scale),
                    reactive: true,
                    can_focus: false,
                    track_hover: true,
                });
                btn.connect('clicked', () => this._pickHex(color));
                line.add_child(btn);
                this._paletteBtns.push({btn, color});
            }
            paletteBox.add_child(line);
        }
        this._customBox.add_child(paletteBox);

        // The spectrum: hue across, saturation down.  Size comes from
        // _syncCustomEditor(), together with the palette pitch it has to line
        // up with, so a size step keeps the block square-edged.  x_align START
        // is what makes the box honour that width instead of filling the card.
        this._spectrum = new St.DrawingArea({
            reactive: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._spectrum.connect('repaint', () =>
            paintSpectrum(this._spectrum, this._pickerHsv));
        this._customBox.add_child(this._spectrum);
        this._bindPick(this._spectrum, (fx, fy) => {
            this._pickerHsv.h = fx * 360;
            this._pickerHsv.s = Math.max(0, Math.min(1, 1 - fy));
            this._pickColor(true);
        });

        this._valueBar = new St.DrawingArea({
            reactive: true,
            x_align: Clutter.ActorAlign.START,
        });
        this._valueBar.connect('repaint', () =>
            paintValueBar(this._valueBar, this._pickerHsv));
        this._customBox.add_child(this._valueBar);
        this._bindPick(this._valueBar, fx => {
            this._pickerHsv.v = fx;
            this._pickColor(true);
        });

        // 色号: the code in use, a backspace for the pad, and 更多.
        const hexRow = new St.BoxLayout({reactive: false});
        this._hexLabel = new St.Label({
            text: this._customHex[this._pickerRole] ?? '',
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            style: hexReadoutStyle(this._scale),
        });
        hexRow.add_child(this._hexLabel);

        this._hexBack = new St.Button({
            child: new St.Label({
                text: '⌫',
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: hexKeyStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._hexBack.connect('clicked', () => this._hexBackspace());
        hexRow.add_child(this._hexBack);

        this._moreBtn = new St.Button({
            child: new St.Label({
                text: T('More'),
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: sizeBtnStyle(false, this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._moreBtn.connect('clicked', () => this._toggleHexPad());
        hexRow.add_child(this._moreBtn);
        this._customBox.add_child(hexRow);

        // The 0-9A-F pad, hidden until 更多 is tapped.  Six digits, then the code
        // applies by itself -- no 应用 button to forget.
        this._hexPad = new St.BoxLayout({
            vertical: true,
            reactive: false,
            visible: false,
        });
        this._hexKeys = [];
        const padChars = '0123456789ABCDEF';
        for (let row = 0; row < 2; row++) {
            const line = new St.BoxLayout({reactive: false});
            for (let col = 0; col < 8; col++) {
                const char = padChars[row * 8 + col];
                const btn = new St.Button({
                    child: new St.Label({
                        text: char,
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                    style: hexKeyStyle(this._scale),
                    reactive: true,
                    can_focus: false,
                    track_hover: true,
                });
                btn.connect('clicked', () => this._hexType(char));
                line.add_child(btn);
                this._hexKeys.push({btn, char});
            }
            this._hexPad.add_child(line);
        }
        this._customBox.add_child(this._hexPad);

        // 完成 / 取消, as in the picker this copies.  完成 closes the page;
        // 取消 puts the palette back, which only matters because every touch
        // has already changed the keyboard behind the card.
        const doneRow = new St.BoxLayout({reactive: false});
        this._doneBtn = new St.Button({
            child: new St.Label({
                text: T('Done'),
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: sizeBtnStyle(true, this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._doneBtn.connect('clicked', () => this._closeSettings());
        doneRow.add_child(this._doneBtn);

        this._revertBtn = new St.Button({
            child: new St.Label({
                text: T('Cancel'),
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: sizeBtnStyle(false, this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._revertBtn.connect('clicked', () => this._revertPalette());
        doneRow.add_child(this._revertBtn);
        this._customBox.add_child(doneRow);

        themeDetails.add_child(this._customBox);

        const opacityDetails = this._newSection(lookGroup, 'opacity',
            T('Opacity'), T('Opacity hint'), 'opacity');
        const opacityRow = new St.BoxLayout({reactive: false});
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
        opacityDetails.add_child(opacityRow);

        const radiusDetails = this._newSection(lookGroup, 'radius',
            T('Radius'), T('Radius hint'), 'radius');
        const radiusRow = new St.BoxLayout({reactive: false});
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
        radiusDetails.add_child(radiusRow);

        // ---- 背景 ---------------------------------------------------
        const backgroundGroup = this._newGroup();
        const backgroundDetails = this._newSection(backgroundGroup,
            'background', T('Background'), T('Background hint'), 'background');
        // Refilled every time the page opens, so a picture dropped into the
        // folder shows up without a re-login.
        this._bgRow = new St.BoxLayout({vertical: true, reactive: false});
        backgroundDetails.add_child(this._bgRow);

        // ---- 关于: one row here, everything else on its own page -----
        const aboutGroup = this._newGroup();
        const aboutRow = this._rowBase(T('About'), T('About hint'), 'info');
        aboutRow.value.text = APP_VERSION;
        aboutRow.btn.connect('clicked', () => this._showAbout(true));
        aboutGroup.add_child(aboutRow.btn);

        // ---- the 关于 page -------------------------------------------
        // 项目网站 / 版本发布 / 作者酷安 + version and reset: it is the copyright
        // block, and it opens from one row instead of pushing the settings list
        // past the bottom of a 1080p screen.
        this._aboutPage = new St.BoxLayout({
            vertical: true,
            reactive: false,
            visible: false,
            x_expand: true,
        });
        this._pages.add_child(this._aboutPage);

        const aboutHead = new St.BoxLayout({reactive: false, x_expand: true});
        this._aboutBackBtn = new St.Button({
            child: new St.Label({
                text: '‹',
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: settingsBackBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._aboutBackBtn.connect('clicked', () => this._showAbout(false));
        aboutHead.add_child(this._aboutBackBtn);
        this._aboutTitle = new St.Label({
            text: T('About'),
            y_align: Clutter.ActorAlign.CENTER,
            style: settingsPageTitleStyle(this._scale),
        });
        aboutHead.add_child(this._aboutTitle);
        this._aboutPage.add_child(aboutHead);

        // 版本号 reads as a row like everything else on the page: the label on
        // the left, the number on the right, no chevron because there is
        // nothing to open.
        const infoGroup = this._newGroup(this._aboutPage);
        const versionRow = new St.BoxLayout({
            reactive: false,
            x_expand: true,
            style: settingsRowStyle(this._scale),
        });
        this._versionLabel = new St.Label({
            text: T('Version'),
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: settingsRowTitleStyle(this._scale),
        });
        versionRow.add_child(this._versionLabel);
        this._versionValue = new St.Label({
            text: APP_VERSION,
            y_align: Clutter.ActorAlign.CENTER,
            style: settingsRowValueStyle(this._scale),
        });
        versionRow.add_child(this._versionValue);
        infoGroup.add_child(versionRow);
        this._newSeparator(infoGroup);

        const resetBox = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_expand: true,
            style: settingsDetailsStyle(this._scale),
        });
        infoGroup.add_child(resetBox);
        this._buildResetRow(resetBox);

        // The address the README hands out: a page that does not move when a
        // repository or a package host does.  Release notes stay on GitHub,
        // which is where the update announcements are written.  The Coolapk
        // profile comes last: it is the credit line of this block.
        const linkGroup = this._newGroup(this._aboutPage);
        this._linkRow(linkGroup, T('Project site'),
            T('Project site hint'), 'website', 'https://mybailu.cn/osk/');
        this._linkRow(linkGroup, T('Release notes'),
            T('Release notes hint'), 'update',
            'https://github.com/HOSHINO61/ubuntu-pad-keyboard/releases');
        // The credit line keeps a one-word subtitle: it is the last row of the
        // block, and the logo already says whose page it opens.
        this._linkRow(linkGroup, T('Author'), T('Author hint'), COOLAPK_LOGO,
            'https://www.coolapk.com/u/41024424');
        // 许可放在版权块的最后一行：它读的是随包分发的 LICENSE 全文，
        // 打开的是自己的弹窗，不跳浏览器。
        this._aboutActionRow(linkGroup, T('License'), T('License hint'), 'info',
            () => this._openLicense());

        // The separator after the last row of each card would be a stray line
        // inside the rounded block; only the gaps between rows get one.
        for (const group of this._groups) {
            const seps = group._seps ?? [];
            if (seps.length)
                seps[seps.length - 1].visible = false;
        }

        // The picker's two drawing areas have no natural size of their own: the
        // page is built before anything calls _applyScale(), so give them theirs
        // here or they allocate 0x0 and never paint.
        this._syncCustomEditor();
        this._syncSectionValues();

        // ---- the card: close button on top, scrolling body below ------
        this._settingsCard = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style: settingsCardStyle(this._scale),
        });

        const header = new St.BoxLayout({reactive: false, x_expand: true});
        header.add_child(new St.Widget({x_expand: true}));
        this._settingsCloseBtn = new St.Button({
            child: new St.Label({
                text: '✕',
                y_align: Clutter.ActorAlign.CENTER,
            }),
            style: settingsCloseBtnStyle(this._scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._settingsCloseBtn.connect('clicked', () => this._closeSettings());
        header.add_child(this._settingsCloseBtn);
        this._settingsCard.add_child(header);

        // Height is set by _fitSettingsCard(); the view scrolls whatever does
        // not fit, so an 800px tablet never loses the lower half of the page.
        this._settingsScroll = new St.ScrollView({
            reactive: true,
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._settingsScroll.set_child(this._pages);
        // 手指竖着拖应该滚动内容。卡片里每一行都是 St.Button，普通的
        // touch-event 早就被按钮的 click 手势吃掉，只有捕获阶段看得到；
        // 阈值以内仍然放行，点按不受影响。
        this._settingsScroll.connect('captured-event',
            this._onSettingsScrollEvent.bind(this));
        this._settingsCard.connect('captured-event',
            this._onSettingsCardDrag.bind(this));
        this._settingsCard.add_child(this._settingsScroll);
    }

    // One card of rows, in the MIUIX shape: a rounded block of its own.  The
    // parent defaults to the main list; the 关于 sub-page passes its own box so
    // both pages share the same shape, separator trimming and restyling.
    _newGroup(parent = this._settings) {
        const group = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_expand: true,
            style: settingsGroupStyle(this._scale),
        });
        parent.add_child(group);
        this._groups.push(group);
        return group;
    }

    // The 1px hairline between two rows of a card.  Kept as its own helper so
    // link rows can separate themselves the same way sections do.
    _newSeparator(group) {
        const separator = new St.Widget({
            x_expand: true,
            height: 1,
            // Without this the vertical box hands the zero-preferred-height
            // separator the group's leftover space and it paints a grey band
            // over the last line of the hint.
            y_align: Clutter.ActorAlign.START,
            style: settingsSeparatorStyle(this._scale),
        });
        group.add_child(separator);
        this._rowSeparators.push(separator);
        if (!group._seps)
            group._seps = [];
        group._seps.push(separator);
        return separator;
    }

    // A collapsed row plus the controls it hides.  Returns the box those
    // controls go into.
    _newSection(group, key, title, hint, icon) {
        const {btn, value, chevron} = this._settingsRow(key, title, hint, icon);
        group.add_child(btn);

        const separator = this._newSeparator(group);

        const details = new St.BoxLayout({
            vertical: true,
            reactive: false,
            visible: false,
            x_expand: true,
            style: settingsDetailsStyle(this._scale),
        });
        group.add_child(details);

        this._sections[key] = {btn, value, chevron, details, separator};
        return details;
    }

    // icon | title+hint | value | ›
    _settingsRow(key, title, hint, icon) {
        const row = this._rowBase(title, hint, icon);
        row.btn.connect('clicked', () => this._toggleSection(key));
        return {btn: row.btn, value: row.value, chevron: row.chevron};
    }

    // A visitor row: same shape as a setting, but the chevron points out of the
    // page and the click opens the browser instead of expanding controls.
    _linkRow(group, title, hint, icon, url) {
        const row = this._rowBase(title, hint, icon);
        row.chevron.text = '↗';
        row.btn.connect('clicked', () => {
            try {
                Gio.AppInfo.launch_default_for_uri(url, null);
            } catch (e) {
                log(`pad-osk: open ${url} failed: ${e}`);
            }
        });
        group.add_child(row.btn);
        this._newSeparator(group);
        return row;
    }

    // A visitor row that stays inside the extension: same shape as a link,
    // but the chevron is the ordinary › and the click opens a panel of our
    // own instead of a browser.
    _aboutActionRow(group, title, hint, icon, onActivate) {
        const row = this._rowBase(title, hint, icon);
        row.btn.connect('clicked', onActivate);
        group.add_child(row.btn);
        this._newSeparator(group);
        return row;
    }

    _rowBase(title, hint, icon) {
        const scale = this._scale;
        const box = Math.round(30 * scale);
        let iconActor;
        // A brand mark ships as a picture and keeps its own colours; drawn
        // icons are monochrome line art on a transparent surface.
        if (typeof icon === 'string' && icon.startsWith('/')) {
            iconActor = new St.Bin({
                width: box,
                height: box,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    gicon: Gio.icon_new_for_string(icon),
                    icon_size: Math.round(box * 0.82),
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            });
        } else {
            const iconArea = new St.DrawingArea({
                reactive: false,
                width: box,
                height: box,
                y_align: Clutter.ActorAlign.CENTER,
            });
            iconArea.connect('repaint', () => paintSettingIcon(iconArea, icon));
            this._iconAreas.push({area: iconArea, kind: icon});
            iconActor = iconArea;
        }

        const texts = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_expand: true,
        });
        const titleLabel = new St.Label({
            text: title,
            x_align: Clutter.ActorAlign.START,
            style: settingsRowTitleStyle(scale),
        });
        // A row may carry only a title.  Some visitors are self-explanatory
        // (the Coolapk line), and a second line there is just noise -- and an
        // empty St.Label would still reserve the hint's line height.
        texts.add_child(titleLabel);
        this._rowTitles.push(titleLabel);
        if (hint) {
            const hintLabel = new St.Label({
                text: hint,
                x_align: Clutter.ActorAlign.START,
                style: settingsRowHintStyle(scale),
            });
            texts.add_child(hintLabel);
            this._rowHints.push(hintLabel);
        }
        const value = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style: settingsRowValueStyle(scale),
        });
        const chevron = new St.Label({
            text: '›',
            y_align: Clutter.ActorAlign.CENTER,
            style: settingsRowChevronStyle(scale),
        });
        this._rowValues.push(value);
        this._rowChevrons.push(chevron);

        const content = new St.BoxLayout({
            reactive: false,
            x_expand: true,
        });
        content.add_child(iconActor);
        content.add_child(texts);
        content.add_child(value);
        content.add_child(chevron);

        const btn = new St.Button({
            child: content,
            style: settingsRowStyle(scale),
            reactive: true,
            x_expand: true,
            can_focus: false,
            track_hover: true,
        });
        this._rows.push(btn);
        return {btn, value, chevron};
    }

    // ---- license dialog ----------------------------------------------
    // 许可全文单独一张卡片：标题和 ✕ 固定在顶部，正文滚动。不塞进设置页，
    // 否则整页会被一大段条款撑长，每次打开都要滚半天。
    _buildLicenseCard() {
        const scale = this._scale;
        this._licenseCard = new St.BoxLayout({
            vertical: true,
            reactive: true,
            visible: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
            style: settingsCardStyle(scale),
        });

        const header = new St.BoxLayout({reactive: false, x_expand: true});
        this._licenseTitle = new St.Label({
            text: T('License'),
            x_align: Clutter.ActorAlign.START,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: settingsPageTitleStyle(scale),
        });
        header.add_child(this._licenseTitle);
        this._licenseCloseBtn = new St.Button({
            child: new St.Label({text: '✕', y_align: Clutter.ActorAlign.CENTER}),
            style: settingsCloseBtnStyle(scale),
            reactive: true,
            can_focus: false,
            track_hover: true,
        });
        this._licenseCloseBtn.connect('clicked', () => this._closeLicense());
        header.add_child(this._licenseCloseBtn);
        this._licenseCard.add_child(header);

        this._licenseScroll = new St.ScrollView({
            reactive: true,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
        });
        this._licenseBody = new St.Label({
            text: LICENSE_TEXT,
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            style: `color: ${pageFgSoft(0.86)};`
                + ` font-size: ${Math.round(13 + scale)}px;`,
        });
        this._licenseBody.clutter_text.line_wrap = true;
        this._licenseBody.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        // 不显式关掉省略号，Label 会被 St 主题按 END 截断，正文末尾直接变
        // 成「…」而且高度锁死在视口里，滚动条便没有可滚的内容。
        try {
            this._licenseBody.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        } catch (e) {
            log(`pad-osk: license ellipsize failed: ${e}`);
        }
        // ScrollView 的 child 必须是它认得的滚动容器，裸 Label 会直接报
        // “cannot convert to StScrollable”，所以套一层 BoxLayout。
        this._licenseBodyBox = new St.BoxLayout({
            vertical: true,
            reactive: false,
            x_expand: true,
        });
        this._licenseBodyBox.add_child(this._licenseBody);
        this._licenseScroll.set_child(this._licenseBodyBox);
        this._licenseScroll.connect('captured-event',
            this._onSettingsScrollEvent.bind(this));
        this._licenseCard.add_child(this._licenseScroll);

        Main.uiGroup.add_child(this._licenseCard);
    }

    _openLicense() {
        if (!this._licenseCard)
            this._buildLicenseCard();
        if (!this._licenseCard)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const area = this._workArea(mon);
        const scale = this._scale;
        const w = Math.min(Math.round(640 * scale), area.width - 48);
        const h = Math.min(Math.round(560 * scale), area.height - 96);
        if (w <= 0 || h <= 0)
            return;
        this._licenseCard.set_size(w, h);
        this._licenseCard.set_translation(
            Math.round(area.x + (area.width - w) / 2),
            Math.round(area.y + (area.height - h) / 2), 0);
        const pad = Math.round(22 * scale);
        const innerW = Math.max(120, w - 2 * pad);
        this._licenseBody.style = `color: ${pageFgSoft(0.86)};`
            + ` font-size: ${Math.round(13 + scale)}px;`
            + ` width: ${innerW}px`;
        const adj = this._licenseScroll.get_vadjustment();
        if (adj)
            adj.set_value(0);
        this._licenseCard.visible = true;
        this._raiseActor(this._licenseCard);
        log('pad-osk: license dialog opened');
    }

    // 这个 Clutter 版本里 Actor 没有 raise()/raise_top()，只能对父容器做
    // set_child_above_sibling。
    _raiseActor(actor) {
        if (!actor)
            return;
        try {
            if (typeof actor.raise_top === 'function') {
                actor.raise_top();
                return;
            }
            const parent = actor.get_parent();
            if (parent && typeof parent.set_child_above_sibling === 'function')
                parent.set_child_above_sibling(actor, null);
        } catch (e) {
            log(`pad-osk: raise failed: ${e}`);
        }
    }

    _closeLicense() {
        if (this._licenseCard)
            this._licenseCard.visible = false;
    }

    // Switch the card between the settings list and the 关于 sub-page.  The two
    // pages do not share a top, so the scroll position goes back to zero, and
    // the card refits because the sub-page is much shorter than the list.
    _showAbout(open) {
        if (!this._pages || !this._aboutPage || !this._settings)
            return;
        const shown = !!open;
        this._aboutPage.visible = shown;
        this._settings.visible = !shown;
        const adj = this._settingsScroll?.get_vadjustment();
        if (adj)
            adj.set_value(0);
        if (this._settingsOpen)
            this._scheduleSettingsLayout(true);
    }

    _toggleSection(key) {
        const target = this._sections?.[key];
        if (!target)
            return;
        const open = !target.details.visible;
        for (const [name, section] of Object.entries(this._sections)) {
            const shown = name === key && open;
            section.details.visible = shown;
            section.chevron.text = shown ? '⌄' : '›';
        }
        this._scheduleSettingsLayout(true);
    }

    // The value at the right of each row: the setting's current state in one
    // word, so the row answers "what is it now" without being opened.
    _syncSectionValues() {
        if (!this._sections)
            return;
        const step = findStep(this._steps, this._sizeName);
        this._setSectionValue('size', T(step ? step.label : this._sizeName));
        const theme = this._themes.find(t => t.name === this._themeName);
        this._setSectionValue('theme', T(theme ? theme.label : this._themeName));
        this._setSectionValue('opacity', `${Math.round(this._opacity * 100)}%`);
        const radius = RADIUS_STEPS.find(
            s => Math.abs(s.value - this._radius) < 0.001);
        this._setSectionValue('radius', radius ? T(radius.label) : '');
        this._setSectionValue('background', this._backgroundValueText());
        // 关于 has no section of its own any more: it is a row that opens its
        // sub-page, and the value there is the version number.
    }

    _setSectionValue(key, text) {
        const section = this._sections?.[key];
        if (section && section.value)
            section.value.text = text;
    }

    // 当前背景若是预置，返回它；路径比较走同一套 _presetPath，避免
    // 预置被当成用户自己选的图重复列出来。
    _presetForPath(path) {
        if (!path)
            return null;
        return PRESET_BACKGROUNDS.find(p => this._presetPath(p) === path) ?? null;
    }

    _backgroundValueText() {
        if (!this._backgroundOn || !this._background)
            return T('None');
        const preset = this._presetForPath(this._background);
        if (preset)
            return T(preset.label);
        const base = this._background.split('/').pop();
        return base.length > 18 ? `${base.slice(0, 16)}…` : base;
    }

    // Restyle everything the page draws itself: the CSS classes are built from
    // the scale, so a size step has to be pushed through them again.
    _syncSettingsChrome() {
        const scale = this._scale;
        if (this._pageTitle)
            this._pageTitle.style = settingsPageTitleStyle(scale);
        if (this._versionLabel)
            this._versionLabel.style = settingsRowTitleStyle(scale);
        if (this._versionValue)
            this._versionValue.style = settingsRowValueStyle(scale);
        for (const group of this._groups ?? [])
            group.style = settingsGroupStyle(scale);
        for (const row of this._rows ?? [])
            row.style = settingsRowStyle(scale);
        for (const label of this._rowTitles ?? [])
            label.style = settingsRowTitleStyle(scale);
        for (const label of this._rowHints ?? [])
            label.style = settingsRowHintStyle(scale);
        for (const label of this._rowValues ?? [])
            label.style = settingsRowValueStyle(scale);
        for (const label of this._rowChevrons ?? [])
            label.style = settingsRowChevronStyle(scale);
        if (this._settingsCloseBtn)
            this._settingsCloseBtn.style = settingsCloseBtnStyle(scale);
        if (this._aboutBackBtn)
            this._aboutBackBtn.style = settingsBackBtnStyle(scale);
        if (this._aboutTitle)
            this._aboutTitle.style = settingsPageTitleStyle(scale);
        for (const separator of this._rowSeparators ?? [])
            separator.style = settingsSeparatorStyle(scale);
        for (const section of Object.values(this._sections ?? {}))
            section.details.style = settingsDetailsStyle(scale);
        for (const {area, kind} of this._iconAreas ?? []) {
            area.set_width(Math.round(30 * scale));
            area.set_height(Math.round(30 * scale));
            area.queue_repaint();
        }
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

    // 预置背景存在单独的目录里，和用户自己选的图分开：清空 backgrounds
    // 不会把预置一起删掉，管理页也不会把它们当成用户图。
    _presetDir() {
        return GLib.build_filenamev(
            [GLib.get_user_config_dir(), 'pad-osk', 'presets']);
    }

    _presetPath(preset) {
        return GLib.build_filenamev(
            [this._presetDir(), `preset-${preset.key}.png`]);
    }

    // 第一次选中时才落盘；之后直接复用，改主题/改尺寸都不会重写。
    _ensurePresetBackground(preset) {
        try {
            const path = this._presetPath(preset);
            if (GLib.file_test(path, GLib.FileTest.EXISTS))
                return path;
            const dir = this._presetDir();
            GLib.mkdir_with_parents(dir, 0o755);
            const bytes = GLib.base64_decode(preset.data);
            GLib.file_set_contents(path, bytes);
            return path;
        } catch (e) {
            log(`pad-osk: preset background failed: ${e}`);
            return null;
        }
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
            x_align: Clutter.ActorAlign.START,
            style: sectionLabelStyle(this._scale),
        }));

        // 按钮按行排、每行四个：预置 + 用户图 + 选图/管理一起出现时，一行
        // 塞不下会把标签挤成省略号，改成换行排布。
        let line = null;
        let perLine = 0;
        const newLine = () => {
            line = new St.BoxLayout({reactive: false, x_expand: true});
            this._bgRow.add_child(line);
            perLine = 0;
        };
        newLine();

        const button = (label, active, onActivate, extraStyle = '') => {
            if (perLine >= 4)
                newLine();
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
            line.add_child(btn);
            perLine++;
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

        // 三张预置：程序画的，自带在扩展里，选中时才写到 config 目录。
        for (const preset of PRESET_BACKGROUNDS) {
            const path = this._presetPath(preset);
            const btn = button(T(preset.label), this._backgroundActive(path),
                () => {
                    const file = this._ensurePresetBackground(preset);
                    if (file)
                        this._setBackground(file);
                });
            this._backgroundBtns[path] = btn;
        }

        const files = this._backgroundFiles();
        // A picture picked with the system chooser can live anywhere, so show it
        // even when it is not inside the backgrounds folder -- but a preset is
        // already its own button, and must not show up a second time here.
        if (this._background && !this._presetForPath(this._background)
            && !files.includes(this._background))
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
        // position.kf by hand), and it must still be listed and deletable --
        // presets excepted: they belong to the extension, not to this folder.
        if (this._background && !this._presetForPath(this._background)
            && !files.includes(this._background))
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
        // One more picture is one more button row: the card must re-measure.
        this._scheduleSettingsLayout(true);
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

    _buildResetRow(parent) {
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
        parent.add_child(this._resetBtn);
    }

    // Back to the shipping look and the default spot: medium, graphite, fully
    // opaque, no backdrop, bottom centre.  [custom] is left alone -- it is the
    // user's own palette, not a setting this button owns.
    _resetDefaults() {
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._steps = this._readScales();
        this._sizeName = DEFAULT_SIZE;
        this._scale = scaleForStep(findStep(this._steps, DEFAULT_SIZE));
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
        // Only one surface at a time: opening settings puts emoji away.
        this._closeEmoji(false);
        // Re-scan the backgrounds folder on every open: dropping a new image in
        // must not require a re-login.
        this._buildBackgroundRow();
        // What 取消 goes back to: the palette as it is before any touch.
        this._paletteSnapshot = {...this._customHex};
        // A half-typed code from last time is not a colour anyone meant to keep.
        this._hexInput = null;
        this._syncCustomEditor();
        this._settingsOpen = true;
        this._settingsCard.visible = true;
        // 每次打开都回到默认位置：上次拖到哪里只对那一次有效。
        this._cardOffsetX = 0;
        this._cardOffsetY = 0;
        this._cardPlaced = false;
        // The card is on uiGroup, outside the chrome's stacking order; raising
        // it here keeps it above the keyboard even after other chrome is added.
        try {
            this._raiseActor(this._settingsCard);
        } catch (e) {
            log(`pad-osk: card raise failed: ${e}`);
        }
        // No reflow: the keyboard keeps its height, the card is placed on its
        // own.
        this._scheduleSettingsLayout(true);
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

    // Collapsing the panel or hiding the keyboard both put the card away, so a
    // card is never left floating over an application with no keyboard under
    // it.  The parameter is kept for the old call sites: the card no longer
    // changes the slab's height, so there is nothing left to reflow.
    _closeSettings(_reflow = true) {
        if (!this._settings || !this._settingsOpen)
            return;
        this._cancelDeleteBackground(false);
        this._bgMode = 'pick';
        this._settingsOpen = false;
        if (this._settingsCard)
            this._settingsCard.visible = false;
        // The next open starts on the list again, not on the page that was left
        // behind last time.
        if (this._aboutPage && !this._settings.visible)
            this._showAbout(false);
        if (this._settingsLayoutId) {
            GLib.source_remove(this._settingsLayoutId);
            this._settingsLayoutId = 0;
        }
    }

    // ---- custom palette (调色板 / 取色器 / 色号) ------------------------
    // A DrawingArea is not a St.Button: there is no click gesture to lean on, so
    // press-to-release is followed by hand.  Touch keeps delivering updates
    // while the finger is down (implicit grab); a mouse drag that leaves the
    // actor stops where it left, which is why 'leave-event' clears the flag
    // instead of taking a stage grab.
    _bindPick(area, onPoint) {
        const point = event => {
            const [stageX, stageY] = this._coords(event);
            const [areaX, areaY] = area.get_transformed_position();
            // get_surface_size() is only valid inside a repaint -- the cairo
            // surface lives just for the paint and reads 0x0 from an event
            // handler, which swallowed every press.  The actor allocation is
            // what the surface is sized from, so use that.
            const [width, height] = [area.width, area.height];
            if (width <= 0 || height <= 0)
                return Clutter.EVENT_STOP;
            onPoint(
                Math.max(0, Math.min(1, (stageX - areaX) / width)),
                Math.max(0, Math.min(1, (stageY - areaY) / height)));
            return Clutter.EVENT_STOP;
        };
        area.connect('button-press-event', (_actor, event) => {
            this._pickDrag = true;
            return point(event);
        });
        area.connect('motion-event', (_actor, event) =>
            this._pickDrag ? point(event) : Clutter.EVENT_PROPAGATE);
        area.connect('leave-event', () => {
            this._pickDrag = false;
            return Clutter.EVENT_PROPAGATE;
        });
        area.connect('button-release-event', () => {
            this._endPick();
            return Clutter.EVENT_STOP;
        });
        area.connect('touch-event', (_actor, event) => {
            const type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN
                || type === Clutter.EventType.TOUCH_UPDATE) {
                this._pickDrag = true;
                return point(event);
            }
            if (type === Clutter.EventType.TOUCH_END
                || type === Clutter.EventType.TOUCH_CANCEL) {
                this._endPick();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    // Which role the editor acts on: the palette outline, the square, the bar
    // and the code all follow that role's current colour.
    _pickRole(role) {
        if (!CUSTOM_ROLES.some(r => r.key === role))
            return;
        this._pickerRole = role;
        this._pickerHsv = hexToHsv(
            this._customHex[role] ?? CUSTOM_DEFAULT[role]);
        // A half-typed code belongs to the role it was started on.
        this._hexInput = null;
        this._syncCustomEditor();
    }

    // Every path -- palette chip, spectrum, brightness bar, typed code -- ends
    // here with one #rrggbb.  A drag samples at frame rate and there are 120
    // keys to restyle, so a live sample only queues the restyle for the next
    // idle cycle and saves once the finger stops.
    _setPaletteColor(hex, live) {
        if (!hexToRgb(hex))
            return;
        const next = {...this._customHex, [this._pickerRole]: hex};
        const theme = makeCustomTheme(next);
        if (!theme)
            return;
        this._customHex = next;
        this._custom = theme;
        this._themes[this._themes.length - 1] = theme;
        THEME = theme;
        this._themeName = CUSTOM_THEME;
        this._syncCustomEditor();
        if (live) {
            this._queueRestyle();
            this._queueSave();
            return;
        }
        this._applyScale();
        this._saveConfig();
        log(`pad-osk: custom ${this._pickerRole} -> ${hex}`);
    }

    _pickColor(live) {
        this._setPaletteColor(hsvToHex(
            this._pickerHsv.h, this._pickerHsv.s, this._pickerHsv.v), live);
    }

    // A palette chip or a finished code: the picker follows the colour it was
    // given, so the marker and the bar stay on the value that is in use.
    _pickHex(hex) {
        if (!hexToRgb(hex))
            return;
        this._pickerHsv = hexToHsv(hex);
        this._hexInput = null;
        this._setPaletteColor(hex, false);
    }

    _toggleHexPad() {
        if (!this._hexPad)
            return;
        const show = !this._hexPad.visible;
        this._hexPad.visible = show;
        // Opening the pad always starts a fresh code for the current role,
        // prefilled with nothing: the readout already shows the colour in use.
        this._hexInput = show ? '' : null;
        this._syncCustomEditor();
        // The pad changes the card's height: re-measure and re-place it.
        this._scheduleSettingsLayout(true);
    }

    // Six digits and it applies by itself -- no 应用 button to forget.
    _hexType(char) {
        if (this._hexInput === null)
            this._hexInput = '';
        if (this._hexInput.length >= 6)
            return;
        this._hexInput += char;
        this._syncCustomEditor();
        if (this._hexInput.length === 6)
            this._pickHex(`#${this._hexInput}`);
    }

    _hexBackspace() {
        if (this._hexInput === null)
            return;
        this._hexInput = this._hexInput.slice(0, -1);
        this._syncCustomEditor();
    }

    _queueRestyle() {
        if (this._paletteId || !this._box)
            return;
        this._paletteId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._paletteId = 0;
            if (this._box)
                this._applyScale();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Saving on a timer rather than on release: a touch that ends outside the
    // area never reaches the release handler, but the timer still fires.
    _queueSave() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._saveId = 0;
            this._saveConfig();
            return GLib.SOURCE_REMOVE;
        });
    }

    // End of a press: flush whatever the live samples left queued, so what is on
    // disk matches what is on screen the moment the finger lifts.
    _endPick() {
        this._pickDrag = false;
        if (!this._paletteId && !this._saveId)
            return;
        if (this._paletteId) {
            GLib.source_remove(this._paletteId);
            this._paletteId = 0;
        }
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        if (this._box)
            this._applyScale();
        this._saveConfig();
        log(`pad-osk: custom ${this._pickerRole} -> `
            + `${this._customHex[this._pickerRole]}`);
    }

    // 取消: back to the palette as it was when the sheet was opened.  The live
    // samples have already repainted the keyboard, so this has to reapply -- and
    // only the colours come back, not the theme the user picked in the meantime.
    _revertPalette() {
        const snapshot = this._paletteSnapshot;
        const theme = snapshot ? makeCustomTheme(snapshot) : null;
        if (theme) {
            this._customHex = {...snapshot};
            this._custom = theme;
            this._themes[this._themes.length - 1] = theme;
            if (this._themeName === CUSTOM_THEME)
                THEME = theme;
        }
        this._pickerHsv = hexToHsv(
            this._customHex[this._pickerRole] ?? CUSTOM_DEFAULT[this._pickerRole]);
        this._hexInput = null;
        this._applyScale();
        this._syncCustomEditor();
        this._saveConfig();
        this._closeSettings();
        log('pad-osk: palette reverted');
    }

    // Visible only for the custom palette, because the keyboard behind the sheet
    // is the preview.  The one place that sizes the picker and reflects the five
    // role colours, the palette outline and the code -- so a size step change
    // (_applyScale -> _restylePalette) keeps all of it in proportion.
    _syncCustomEditor() {
        if (!this._customBox)
            return;
        this._customBox.visible = this._themeName === CUSTOM_THEME;
        const scale = this._scale;
        const current = String(this._customHex[this._pickerRole] ?? '');

        for (const role of CUSTOM_ROLES) {
            const btn = this._roleBtns?.[role.key];
            if (btn) {
                btn.style = roleBtnStyle(
                    this._customHex[role.key] ?? CUSTOM_DEFAULT[role.key],
                    role.key === this._pickerRole, scale);
            }
        }
        for (const item of this._paletteBtns ?? []) {
            item.btn.style = paletteChipStyle(item.color,
                item.color.toLowerCase() === current.toLowerCase(), scale);
        }
        // The spectrum and the bar are twelve chips wide so the block keeps one
        // straight right edge at every size step.
        if (this._spectrum) {
            this._spectrum.set_width(
                Math.max(120, Math.round(PICK_W * scale)));
            this._spectrum.set_height(
                Math.max(60, Math.round(SPECTRUM_H * scale)));
            this._spectrum.queue_repaint();
        }
        if (this._valueBar) {
            this._valueBar.set_width(
                Math.max(120, Math.round(PICK_W * scale)));
            this._valueBar.set_height(
                Math.max(12, Math.round((VALUE_H + VALUE_GAP_PX) * scale)));
            this._valueBar.queue_repaint();
        }
        for (const item of this._hexKeys ?? [])
            item.btn.style = hexKeyStyle(scale);
        if (this._hexBack) {
            this._hexBack.visible = this._hexInput !== null;
            this._hexBack.style = hexKeyStyle(scale);
        }
        if (this._moreBtn)
            this._moreBtn.style = sizeBtnStyle(false, scale);
        if (this._doneBtn)
            this._doneBtn.style = sizeBtnStyle(true, scale);
        if (this._revertBtn)
            this._revertBtn.style = sizeBtnStyle(false, scale);
        const moreLabel = this._moreBtn?.get_child();
        if (moreLabel)
            moreLabel.text = this._hexPad?.visible ? T('Less') : T('More');
        if (this._hexLabel) {
            // While a code is being typed the readout shows the digits so far
            // and dots for the rest; otherwise it is the colour in use.
            this._hexLabel.text = this._hexInput === null
                ? current
                : `#${this._hexInput}`
                    + '·'.repeat(Math.max(0, 6 - this._hexInput.length));
            this._hexLabel.style = hexReadoutStyle(scale);
        }
    }

    _restylePalette() {
        this._syncCustomEditor();
    }

    // One preview card: panel colour as the card, a row of key chips, the
    // theme name on top of its own key colour.
    _themeCard(theme) {
        const s = this._scale;
        const content = new St.BoxLayout({vertical: true, reactive: false});

        const chips = new St.BoxLayout({
            reactive: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        chips.add_child(new St.Widget({style: themeChipStyle(theme.key[0], false, s)}));
        chips.add_child(new St.Widget({style: themeChipStyle(theme.key[0], true, s)}));
        chips.add_child(new St.Widget({style: themeChipStyle(theme.mod[0], false, s)}));
        chips.add_child(new St.Widget({style: themeChipStyle(theme.on[0], false, s)}));
        content.add_child(chips);

        content.add_child(new St.Label({
            text: T(theme.label),
            style: `color: ${panelFgFor(theme)}; font-size: ${px(13, s)};`,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        const btn = new St.Button({
            child: content,
            style: themeCardStyle(
                theme.name === this._themeName, s, theme),
            reactive: true,
            x_expand: true,
            can_focus: false,
            track_hover: true,
        });
        btn.connect('clicked', () => this._setTheme(theme.name));
        return btn;
    }

    _setTheme(name) {
        const theme = this._themes.find(t => t.name === name);
        if (!theme || theme.name === this._themeName)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        THEME = theme;
        this._themeName = name;
        this._applyScale();
        this._syncCustomEditor();
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
        const target = scaleForStep(step);
        // Same step *and* same factor: nothing to do.  A retuned factor for
        // the step already in use still gets applied, on the next click.
        if (name === this._sizeName && target === this._scale)
            return;
        this._fitBest = null;
        this._fitDone = false;
        this._fitTries = 0;

        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._sizeName = name;
        this._scale = target;
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
            if (typeof raw === 'number' && raw >= SCALE_MIN && raw <= SCALE_MAX) {
                step.scale = Math.round(raw * 100) / 100;
                step.scaleFixed = true;
            }
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
            // Collapsed to the thin grip bar, or hidden: the width we just
            // measured is not a keyboard width, so neither log it as one nor
            // feed it to the fraction fit.
            const collapsed = !this._rowsBox || !this._rowsBox.visible;
            log(`pad-osk: panel ${width}x${newHeight} `
                + `(${pct}% of ${mon ? mon.width : 0}px, step ${this._sizeName} `
                + `scale ${this._scale}${collapsed ? ', collapsed' : ''})`);
            if (!collapsed && !this._hidden)
                this._fitWidth(width, mon);
            return GLib.SOURCE_REMOVE;
        });
    }

    // The scale->width curve is not perfectly linear (a wider 'Shift' label
    // stops a row from shrinking), so take one correction from the width that
    // was actually allocated.  Runs at most twice per size change: after the
    // correction the ratio is inside the tolerance.
    _fitWidth(width, mon) {
        const step = findStep(this._steps, this._sizeName);
        if (!step || step.scaleFixed || !mon || !mon.width || !width)
            return;
        // A bar a third of the screen wide is not the keyboard: never let a
        // collapsed measurement drag the scale to its clamp.
        if (width < mon.width * 0.3)
            return;
        if (!step.fraction)
            return;
        const target = mon.width * step.fraction;
        if (target <= 0)
            return;

        // Panel width moves in whole-pixel steps (key widths are rounded), so
        // the target can sit exactly between two achievable widths: 54% then
        // 56% then 54% ... forever.  Keep the best measurement for the current
        // size step, and when a correction cannot improve on it, put the best
        // scale back and stop.
        const err = Math.abs(width - target);
        const best = this._fitBest;
        if (!best || err < best.err) {
            this._fitBest = {width, scale: this._scale, err};
        } else {
            // Both ends of the correction have now been measured and neither
            // is inside the tolerance: the reachable widths jump over the
            // target because whole-pixel key widths round.  The scale ratio
            // that produced these two is linear, but the curve is not -- the
            // width that lands closest can sit between them (2558: 1.07 gives
            // 54%, 1.09 gives 56%, 1.08 gives 55%).  Probe the midpoint once
            // before settling for the better of the two.
            const gap = Math.abs(this._scale - best.scale);
            const tries = this._fitTries || 0;
            if (gap >= 0.02 && tries < 2) {
                const probe = clampScale((this._scale + best.scale) / 2);
                const distinct = Math.abs(probe - this._scale) >= 0.01
                    && Math.abs(probe - best.scale) >= 0.01;
                if (distinct) {
                    const [, probeOldHeight] = this._box
                        ? this._box.get_size() : [0, 0];
                    this._fitTries = tries + 1;
                    const from = this._scale;
                    this._scale = probe;
                    this._applyScale();
                    log(`pad-osk: fit probe ${probe} `
                        + `(between ${best.scale} and ${from})`);
                    this._reflow(probeOldHeight);
                    return;
                }
            }
            if (best.scale !== this._scale) {
                this._scale = best.scale;
                this._applyScale();
                log(`pad-osk: fit keep ${best.scale} (${best.width}px is `
                    + `${Math.round(best.err / target * 100)}% off)`);
            }
            this._fitDone = true;
            return;
        }
        if (this._fitDone)
            return;
        if (err / target < 0.02)
            return;
        const next = clampScale(this._scale * (target / width));
        if (Math.abs(next - this._scale) < 0.01)
            return;
        const [, oldHeight] = this._box ? this._box.get_size() : [0, 0];
        this._scale = next;
        this._applyScale();
        log(`pad-osk: fit ${width} -> ${Math.round(target)}px `
            + `(${Math.round(target / width * 100)}%), scale ${next}`);
        this._reflow(oldHeight);
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
            this._settings.style = settingsContentStyle();
        if (this._settingsCard)
            this._settingsCard.style = settingsCardStyle(s);
        if (this._settingsCloseBtn)
            this._settingsCloseBtn.style = closeBtnStyle(s);
        this._syncSettingsChrome();
        this._syncSectionValues();
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
        this._restylePalette();
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
        // Contents changed size (labels, chips, the sheet's own metrics), so the
        // floating card has to re-measure and re-place itself.
        if (this._settingsOpen)
            this._scheduleSettingsLayout(true);
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
            if (btn) {
                btn.style = themeCardStyle(
                    theme.name === this._themeName, this._scale, theme);
            }
        }
        if (this._themeGrid) {
            const gap = Math.round(6 * this._scale);
            this._themeGrid.column_spacing = gap;
            this._themeGrid.row_spacing = gap;
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
                    step.value === this._radius, this._scale);
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
        const btn = def.kind === 'key'
            ? this._charKey(def)
            : this._plainKey(def);
        if (btn)
            this._attachFeedback(btn, def);
        return btn;
    }

    // ---- press feedback ------------------------------------------------
    // A pressed key flashes to the "on" colour and falls back to whatever style
    // it had.  Visual only: this tablet's mainline kernel exposes neither a
    // vibrator device nor force feedback, so haptics have no path here.
    _attachFeedback(btn, def) {
        btn.connect('button-press-event', () => {
            this._flash(btn, def);
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('button-release-event', () => {
            this._unflash(btn, def);
            return Clutter.EVENT_PROPAGATE;
        });
        btn.connect('touch-event', (_a, event) => {
            const type = event.type();
            if (type === Clutter.EventType.TOUCH_BEGIN) {
                this._flash(btn, def);
            } else if (type === Clutter.EventType.TOUCH_END
                       || type === Clutter.EventType.TOUCH_CANCEL) {
                this._unflash(btn, def);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        // St.Button's internal click gesture owns the touch sequence, so once
        // it takes over the actor never sees TOUCH_END or a button release --
        // the same reason _attachRepeat stops its timer here.  Without this a
        // key stays lit until something else restyles it.
        btn.connect('clicked', () => this._unflash(btn, def));
    }

    _flash(btn, def) {
        if (!btn || btn._flashed)
            return;
        btn._flashed = true;
        // Belt and braces: if no release signal ever arrives, do not leave the
        // key lit forever.
        btn._flashTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 1500, () => {
                btn._flashTimeoutId = 0;
                this._unflash(btn, def);
                return GLib.SOURCE_REMOVE;
            });
        try {
            btn.style = keyStyle('on', def.minW ?? 82, this._scale);
        } catch (e) {
            /* disposed */
        }
    }

    _unflash(btn, def) {
        if (!btn || !btn._flashed)
            return;
        btn._flashed = false;
        if (btn._flashTimeoutId) {
            GLib.source_remove(btn._flashTimeoutId);
            btn._flashTimeoutId = 0;
        }
        try {
            // Recompute rather than restoring a saved string: the key may have
            // become "armed" (sticky modifier) or the size may have changed
            // while it was down.
            const kind = def.kind ?? 'key';
            const active = def.mod ? this._modActive(def.mod) : false;
            btn.style = keyStyle(active ? 'on' : kind, def.minW ?? 82, this._scale);
        } catch (e) {
            /* disposed */
        }
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
        // Not until the keys exist: the panel is allocated once with the grip
        // alone while the rows are still being built, and placing on that
        // measurement pins a 263x66 keyboard to the remembered spot for the
        // rest of the session.
        if (!this._rowsBox || this._rowsBox.get_n_children() === 0)
            return;
        const [w, h] = this._box.get_size();
        if (w <= 0 || h <= 0)
            return;
        // A grip-only allocation: the rows exist but have not been laid out yet,
        // so this measurement is the bar, not the keyboard.
        const mon = Main.layoutManager.primaryMonitor;
        if (mon && mon.width && w < mon.width * 0.3)
            return;
        this._placed = true;

        const saved = this._savedConfig ?? this._loadConfig();
        if (saved)
            this._applyPosition(saved.x, saved.y);
        else
            this._placeDefault();
    }

    _placeDefault() {
        const mon = Main.layoutManager.primaryMonitor;
        const [w, h] = this._box.get_size();
        this._applyPosition(
            mon.x + Math.round((mon.width - w) / 2),
            mon.y + mon.height - h - 24);
    }

    // ---- settings card geometry ---------------------------------------
    // Work area of the monitor the keyboard is on: the top bar belongs to the
    // monitor but not to the desktop, and that difference is exactly what used
    // to swallow the size row when the sheet grew until it touched the top.
    _workArea(mon) {
        try {
            const area = Main.layoutManager.getWorkAreaForMonitor(mon.index);
            if (area && area.width > 0 && area.height > 0)
                return area;
        } catch (e) {
            log(`pad-osk: work area failed: ${e}`);
        }
        return {x: mon.x, y: mon.y, width: mon.width, height: mon.height};
    }

    // Where the card can go: the gap above the keyboard against the gap below
    // it, in desktop coordinates (the top bar is part of the monitor but not of
    // the desktop).  The larger gap wins and its height becomes the card's
    // ceiling -- a card that keeps clear of the keyboard is worth more than one
    // that shows everything at once.
    _settingsRoom(area) {
        const margin = 8;
        const gap = 10;
        const [kbW, kbH] = this._box ? this._box.get_size() : [0, 0];
        // get_size() reports the allocation, which can sit one row short of the
        // rows it holds while the layout settles; the preferred height is what
        // the keyboard actually paints, so take the larger of the two when the
        // card has to clear it.
        let height = kbH;
        if (this._box) {
            const pref = this._box.get_preferred_height(kbW || -1)[1];
            if (pref > height)
                height = pref;
        }
        // Where the panel really is on screen.  The remembered position is what
        // was asked for, not what the compositor did with it: placing the card
        // from the record left it lying across the bottom row of keys.
        let kbX = this._posX;
        let kbY = this._posY;
        if (this._box) {
            const [ax, ay] = this._box.get_transformed_position();
            if (Number.isFinite(ax) && Number.isFinite(ay)) {
                kbX = ax;
                kbY = ay;
            }
        }
        const above = kbY - area.y - margin - gap;
        const below = area.y + area.height - (kbY + height) - margin - gap;
        return {
            kbX,
            kbY,
            kbW,
            kbH: height,
            rawH: kbH,
            above,
            below,
            preferAbove: above >= below,
            room: Math.max(above, below),
        };
    }

    _fitSettingsCard(space, area) {
        if (!this._settingsCard || !this._settingsOpen)
            return;
        const pad = Math.round(10 * this._scale);
        const maxW = Math.max(320, area.width - 24);
        // A page as wide as a phone, not as wide as the keyboard it belongs to:
        // the rows are built to be read one line at a time, and a 1054px card
        // left the value and the chevron marooned on the right.
        const width = Math.max(380,
            Math.min(maxW, Math.round(700 * this._scale)));
        this._settingsCard.set_width(width);

        const header = this._settingsCard.get_child_at_index(0);
        const headerH = header ? header.get_preferred_height(width)[1] : 0;
        this._cardHeaderH = headerH;
        const innerW = Math.max(120, width - 2 * pad);
        // Measure the page that is actually showing: the 关于 sub-page is much
        // shorter than the list, and fitting against the hidden one left the
        // card with a big empty bottom.
        const page = this._aboutPage?.visible ? this._aboutPage : this._settings;
        const natural = page.get_preferred_height(innerW)[1] ?? 0;
        if (natural <= 0)
            return;
        // Fit to the side the card is about to stand on, from the same
        // measurement the placement uses.  Measuring both twice let a growing
        // card be sized for one side and placed on the other, and the card
        // covered the keyboard instead of scrolling.
        const sideRoom = space.preferAbove ? space.above : space.below;
        // Keyboard covering nearly the whole desktop leaves no side to stand on,
        // so the card gets the work area and scrolls inside it.
        const ceiling = sideRoom > 220
            ? Math.max(160, sideRoom - 6)
            : area.height - 24;
        const scrollH = Math.min(natural,
            Math.max(120, ceiling - headerH - 2 * pad));
        this._settingsScroll.set_height(scrollH);
    }

    _placeSettings(space, area) {
        if (!this._settingsCard || !this._settingsOpen)
            return;
        let [w, h] = this._settingsCard.get_size();
        if (w <= 0 || h <= 0) {
            w = this._settingsCard.width || Math.round(area.width * 0.5);
            h = this._settingsCard.get_preferred_height(w)[1] ?? 0;
        }
        if (w <= 0 || h <= 0)
            return;
        const margin = 8;
        const gap = 10;
        // Centred on the keyboard, kept inside the desktop even when the
        // keyboard itself is half off-screen.
        const x = Math.max(area.x + margin,
            Math.min(Math.round(space.kbX + (space.kbW - w) / 2),
                area.x + area.width - w - margin));
        let y;
        if (space.preferAbove)
            y = space.kbY - h - gap;
        else
            y = space.kbY + space.kbH + gap;
        y = Math.max(area.y + margin,
            Math.min(Math.round(y), area.y + area.height - h - margin));
        this._cardBaseX = x;
        this._cardBaseY = y;
        const nx = Math.max(area.x + margin,
            Math.min(x + this._cardOffsetX, area.x + area.width - w - margin));
        const ny = Math.max(area.y + margin,
            Math.min(y + this._cardOffsetY, area.y + area.height - h - margin));
        this._cardX = nx;
        this._cardY = ny;
        this._cardW = w;
        this._cardH = h;
        this._cardPlaced = true;
        this._settingsCard.set_translation(nx, ny, 0);
    }

    // One measurement, one fit, one placement.  Splitting them let the measure
    // taken while the keyboard was still settling (y=0 instead of the painted
    // 132) decide the card's height while the next one decided its side, and
    // the card ended up lying across the keys.
    _layoutSettingsCard(fit) {
        if (!this._settingsCard || !this._settingsOpen || !this._box)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const area = this._workArea(mon);
        const space = this._settingsRoom(area);
        if (fit)
            this._fitSettingsCard(space, area);
        if (this._cardPlaced)
            this._clampSettingsCard();      // 已经落过位：只量尺寸，不动位置
        else
            this._placeSettings(space, area);
    }

    // Measuring needs an allocation, and one idle is not always enough, so the
    // fitted layout places itself again on the next frame.
    _scheduleSettingsLayout(fit) {
        if (!this._settingsOpen || this._settingsLayoutId)
            return;
        this._settingsLayoutId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._settingsLayoutId = 0;
            if (!this._settingsOpen)
                return GLib.SOURCE_REMOVE;
            this._layoutSettingsCard(fit);
            if (fit)
                this._scheduleSettingsLayout(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyPosition(x, y) {
        if (!this._box)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        // Hotplug leaves no primary for an instant; a throw from inside the
        // monitors-changed handler would leave the panel wherever it was.
        if (!mon)
            return;
        const [w, h] = this._box.get_size();
        // 无极拖动：不再要求整块键盘都在屏内，只留「抓得回来」的余量。
        // 横向留一条能按住的宽度；纵向必须留住把手那一条，否则拖出去就
        // 再也摸不到它了。
        const gripH = Math.max(36, Math.round(
            this._grip?.get_height?.() || 48 * this._scale));
        const keepX = Math.max(120, Math.round(160 * this._scale));
        const nx = Math.max(mon.x - w + keepX,
            Math.min(Math.round(x), mon.x + mon.width - keepX));
        const ny = Math.max(mon.y,
            Math.min(Math.round(y), mon.y + mon.height - gripH));
        this._posX = nx;
        this._posY = ny;
        this._box.set_translation(nx, ny, 0);
        // 卡片和键盘是两个独立的东西：键盘被拖走时卡片原地不动，只在
        // 会被拖出屏幕时收拢回工作区。
        if (this._settingsOpen)
            this._clampSettingsCard();
    }

    // 只做边界收拢，不重算默认位置：键盘移动、屏幕尺寸变化时用这个。
    _clampSettingsCard() {
        if (!this._settingsCard || !this._settingsOpen)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const area = this._workArea(mon);
        const margin = 8;
        const w = this._cardW ?? this._settingsCard.width;
        const h = this._cardH ?? this._settingsCard.height;
        if (w <= 0 || h <= 0)
            return;
        if (!this._cardX && !this._cardY)
            return;
        const nx = Math.max(area.x + margin,
            Math.min(this._cardX, area.x + area.width - w - margin));
        const ny = Math.max(area.y + margin,
            Math.min(this._cardY, area.y + area.height - h - margin));
        this._cardOffsetX = nx - (this._cardBaseX ?? nx);
        this._cardOffsetY = ny - (this._cardBaseY ?? ny);
        this._cardX = nx;
        this._cardY = ny;
        this._settingsCard.set_translation(nx, ny, 0);
    }

    // A rotation, a different primary display or a resolution change moves the
    // width every size step is a fraction *of*, which makes both the cached
    // scale and the fraction-fit memory stale.  Re-clamping the position (all
    // that used to happen here) kept the panel on screen but left the five
    // steps sized for the old screen until the session restarted.
    _onMonitorsChanged() {
        if (!this._box)
            return;
        // Clamp into the new geometry right away, so the panel is never left
        // half off-screen while the re-fit waits for the new layout to settle.
        this._applyPosition(this._posX, this._posY);
        // One resolution change emits this signal once per step and a rotation
        // can emit it twice; collapse the burst into a single re-fit.
        if (this._monitorFitId) {
            GLib.source_remove(this._monitorFitId);
            this._monitorFitId = 0;
        }
        this._monitorFitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200,
            () => {
                this._monitorFitId = 0;
                this._refitForMonitor();
                return GLib.SOURCE_REMOVE;
            });
    }

    // New screen width -> a fresh seed scale for the current step; the
    // measure-and-correct pass in _reflow()/_fitWidth() then lands on the
    // fraction that is actually allocated.  Its memory (_fitBest/_fitDone)
    // describes the old screen width, so it has to start over -- otherwise the
    // first measurement on the new screen is compared against a "best" error
    // from a width that no longer exists.
    _refitForMonitor() {
        if (!this._box)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon || !mon.width)
            return;
        this._fitBest = null;
        this._fitDone = false;
        this._fitTries = 0;
        const step = findStep(this._steps, this._sizeName);
        if (step) {
            const seed = clampScale(scaleForStep(step));
            if (seed !== this._scale) {
                this._scale = seed;
                this._applyScale();
            }
        }
        log(`pad-osk: monitors changed ${mon.width}x${mon.height} at `
            + `${mon.x},${mon.y} -> step ${this._sizeName} seed ${this._scale}`);
        const [, oldHeight] = this._box.get_size();
        // Collapsed or hidden, _reflow() skips the fit on purpose (a 17%-wide
        // grip bar is not a keyboard).  The seed above still applies, and the
        // reset memory means the fit runs correctly once the rows come back.
        this._reflow(oldHeight);
        // The card was fitted against the old work area; refit it here or it
        // keeps the previous screen's ceiling and scrolls for no reason.
        if (this._settingsOpen)
            this._scheduleSettingsLayout(true);
    }

    // ---- dragging ----------------------------------------------------
    _coords(event) {
        const c = event.get_coords();
        let [x, y] = c.length === 3 ? [c[1], c[2]] : c;
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            // Some event kinds give no usable coords through get_coords();
            // the stage pointer always knows where the finger/mouse is.
            [x, y] = global.get_pointer();
        }
        return [x, y];
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

    // 面板整体拖动：把手不再是唯一入口。按键是 St.Button，按在按键或任何
    // 按钮上仍然是点击；按在按键之间的空隙、行列留白、面板边缘时，位移超过
    // 阈值就转成拖动。这样误触不会拖走键盘，也不会影响打字。
    _onPanelDragEvent(_actor, event) {
        const type = event.type();

        if (type === Clutter.EventType.TOUCH_BEGIN
            || type === Clutter.EventType.BUTTON_PRESS) {
            if (this._dragging || this._panelDrag)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = this._coords(event);
            if (this._pressLandsOnControl(x, y))
                return Clutter.EVENT_PROPAGATE;
            this._panelDrag = {x, y, moved: false};
            return Clutter.EVENT_PROPAGATE;
        }

        const drag = this._panelDrag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_UPDATE
            || type === Clutter.EventType.MOTION) {
            const [x, y] = this._coords(event);
            if (!drag.moved
                && Math.hypot(x - drag.x, y - drag.y) >= 8)
                drag.moved = true;
            if (!drag.moved)
                return Clutter.EVENT_PROPAGATE;
            this._panelDrag = null;
            this._startDrag(event);
            const [px, py] = this._coords(event);
            this._applyPosition(px - this._dragDx, py - this._dragDy);
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL) {
            const moved = drag.moved;
            this._panelDrag = null;
            return moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // 这次按下是不是落在某个按钮（按键、⚙、收起、关闭）上。把手本身不再
    // 单列入口，按在把手的空白处也算拖动。
    _pressLandsOnControl(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);
        while (actor && actor !== this._box) {
            if (actor instanceof St.Button)
                return true;
            actor = actor.get_parent();
        }
        return false;
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

    // ---- settings card: drag by its header -----------------------------
    // 卡片是浮在屏幕上的，位置由键盘位置算出来；但平板上一旦想把它挪开
    // （比如挡住某个界面），只能关掉重开。这里让标题那条空白带可以拖着走：
    // 只接标题带，内容区仍然是滚动，两者不抢手势。
    _onSettingsCardDrag(_actor, event) {
        const type = event.type();
        const header = this._settingsCard?.get_child_at_index(0);

        if (type === Clutter.EventType.TOUCH_BEGIN
            || type === Clutter.EventType.BUTTON_PRESS) {
            if (this._cardDrag)
                return Clutter.EVENT_PROPAGATE;
            if (!header)
                return Clutter.EVENT_PROPAGATE;
            const [x, y] = event.get_coords();
            const cardX = this._cardX ?? 0;
            const cardY = this._cardY ?? 0;
            const band = (this._cardHeaderH ?? Math.round(48 * this._scale))
                + Math.round(16 * this._scale);
            // 只认卡片顶部那条带（标题 + 关闭按钮所在的空白），别抢内容区。
            if (x < cardX || x > cardX + (this._cardW ?? 0)
                || y < cardY || y > cardY + band)
                return Clutter.EVENT_PROPAGATE;
            this._cardDrag = {
                x, y,
                offX: this._cardOffsetX,
                offY: this._cardOffsetY,
                moved: false,
            };
            // 标题带这次按下不该留给滚动处理：滚动那边会把这次按下记成一次
            // 滚动起点，而我们随后 STOP 掉更新事件，它永远收不到收尾，
            // 下一次在内容区按下就会拿着旧的起点算位移、跳一下。
            this._scrollDrag = null;
            return Clutter.EVENT_PROPAGATE;
        }

        const drag = this._cardDrag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.TOUCH_UPDATE
            || type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            const dx = x - drag.x;
            const dy = y - drag.y;
            if (!drag.moved && Math.hypot(dx, dy) >= 8)
                drag.moved = true;
            if (!drag.moved)
                return Clutter.EVENT_PROPAGATE;
            this._cardOffsetX = drag.offX + dx;
            this._cardOffsetY = drag.offY + dy;
            this._repositionSettingsCard();
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL) {
            const moved = drag.moved;
            this._cardDrag = null;
            this._cardDragSwallowRelease = Boolean(moved);
            return moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._cardDrag = null;
            if (this._cardDragSwallowRelease) {
                this._cardDragSwallowRelease = false;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    // 拖动只改偏移量，再走一遍同一套 clamp：卡片永远不会被拖出工作区。
    _repositionSettingsCard() {
        if (!this._settingsCard || !this._settingsOpen)
            return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const area = this._workArea(mon);
        const margin = 8;
        const w = this._cardW ?? this._settingsCard.width;
        const h = this._cardH ?? this._settingsCard.height;
        if (w <= 0 || h <= 0)
            return;
        const nx = Math.max(area.x + margin,
            Math.min((this._cardBaseX ?? 0) + this._cardOffsetX,
                area.x + area.width - w - margin));
        const ny = Math.max(area.y + margin,
            Math.min((this._cardBaseY ?? 0) + this._cardOffsetY,
                area.y + area.height - h - margin));
        // 夹住之后把偏移量收回边界内，不然一直往外拖会让偏移量越滚越大，
        // 手指往回拖时卡片要过很久才动。
        this._cardOffsetX = nx - (this._cardBaseX ?? 0);
        this._cardOffsetY = ny - (this._cardBaseY ?? 0);
        this._cardX = nx;
        this._cardY = ny;
        this._settingsCard.set_translation(nx, ny, 0);
    }

    // ---- settings card: drag to scroll --------------------------------
    // 触摸屏上没法像鼠标那样精调滚动条，所以把「按住内容往上推」接成滚动：
    // 捕获阶段拿到事件 → 超过阈值就改 vadjustment → 松手时吞掉 release，
    // 免得拖动结束的一瞬间把手指下面那一行点中。
    _onSettingsScrollEvent(_actor, event) {
        const type = event.type();
        const adj = _actor?.get_vadjustment
            ? _actor.get_vadjustment()
            : this._settingsScroll?.get_vadjustment();

        if (type === Clutter.EventType.TOUCH_BEGIN
            || type === Clutter.EventType.BUTTON_PRESS) {
            if (this._scrollSwallowRelease)
                this._scrollSwallowRelease = false;
            if (!adj || adj.upper <= adj.page_size) {
                this._scrollDrag = null;
                return Clutter.EVENT_PROPAGATE;
            }
            const [, y] = event.get_coords();
            // 每次都重记起点：标题带的拖动会让这里只收到 begin、收不到 end，
            // 残留的旧起点会让下一次在内容区按下时按旧位移跳一下。
            this._scrollDrag = {y, value: adj.value, moved: false};
            return Clutter.EVENT_PROPAGATE;
        }

        const drag = this._scrollDrag;

        if (type === Clutter.EventType.TOUCH_UPDATE
            || type === Clutter.EventType.MOTION) {
            if (!drag)
                return Clutter.EVENT_PROPAGATE;
            const [, y] = event.get_coords();
            const dy = y - drag.y;
            if (!drag.moved && Math.abs(dy) >= 8)
                drag.moved = true;
            if (drag.moved && adj) {
                adj.value = drag.value - dy;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCH_END
            || type === Clutter.EventType.TOUCH_CANCEL) {
            const moved = drag?.moved;
            this._scrollDrag = null;
            this._scrollSwallowRelease = Boolean(moved);
            return moved ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._scrollDrag = null;
            if (this._scrollSwallowRelease) {
                this._scrollSwallowRelease = false;
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        return Clutter.EVENT_PROPAGATE;
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
            const palette = this._customHex
                ?? (prev && prev.custom ? prev.custom : null);
            if (palette) {
                for (const key of ['panel', 'key', 'mod', 'act', 'on']) {
                    if (palette[key])
                        kf.set_string('custom', key, palette[key]);
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
