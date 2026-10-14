// Simulated iPhone behind the mock Mirroir MCP server.
//
// Screens are authored in a 410x898 pt portrait design space (the usual
// iPhone Mirroring window) and scaled to whatever window size the test
// configures. Every element is something Mirroir's OCR would report: a text
// label with a tap point, or an unlabeled icon. Taps hit-test those elements
// (±25 pt, full-width rows), swipes scroll long lists, text goes into the
// focused field, and toggles flip. State persists in <cwd>/mock-phone.json so
// the "phone" survives a Mirroir restart, like the real device does.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const DESIGN_W = 410;
export const DESIGN_H = 898;
/** Content scrolled above this line disappears under the status bar. */
const VISIBLE_TOP = 48;
/** Content below this line is off screen. */
const VISIBLE_BOTTOM = 872;
const HIT_RADIUS = 25;
const ROW_HALF_HEIGHT = 22;
const ICON_COLUMNS = [63, 158, 252, 347];

const HOME_GRID = [
  ['FaceTime', 'Calendar', 'Photos', 'Camera'],
  ['Mail', 'Notes', 'Reminders', 'Clock'],
  ['Safari', 'Messages', 'App Store', 'Maps'],
  ['Health', 'Wallet', 'Settings', 'Weather'],
];
/** Dock icons have no text under them, so OCR reports them as unlabeled icons. */
const DOCK = ['Phone', 'Music', 'Books', 'Files'];
export const KNOWN_APPS = [...HOME_GRID.flat(), ...DOCK];

const ROOT_SCREEN_FOR_APP = { Settings: 'settings', Safari: 'safari', Messages: 'messages' };

const WIFI_NETWORKS = ['Cafe Guest', 'Neighbor-5G', 'Office'];

const CONVERSATIONS = [
  { name: 'Mom', time: 'Yesterday', messages: [{ from: 'them', text: 'See you tonight!' }] },
  { name: 'Alex Chen', time: 'Tuesday', messages: [{ from: 'them', text: 'Sounds good' }] },
  { name: 'Apple', time: 'Monday', messages: [{ from: 'them', text: 'Your receipt from Apple' }] },
];

const FAVORITES = [
  { label: 'Apple', url: 'https://www.apple.com/' },
  { label: 'Bing', url: 'https://www.bing.com/' },
  { label: 'Google', url: 'https://www.google.com/' },
  { label: 'Yahoo', url: 'https://www.yahoo.com/' },
];

const GENERAL_ROWS = [
  ['About', 170],
  ['Software Update', 219],
  ['AirDrop', 295],
  ['AirPlay & Continuity', 344],
  ['iPhone Storage', 420],
  ['Background App Refresh', 469],
  ['Date & Time', 545],
  ['Keyboard', 594],
  ['Fonts', 643],
  ['Language & Region', 692],
  ['Dictionary', 741],
  ['VPN & Device Management', 817],
  ['Legal & Regulatory', 893],
  ['Transfer or Reset iPhone', 969],
  ['Shut Down', 1045],
];

const NOTIFICATION_ROWS = [
  ['Display As', 170, 'Count'],
  ['Scheduled Summary', 219, 'Off'],
  ['Show Previews', 268, 'Always'],
  ['Screen Sharing', 317, 'Notifications Off'],
  ['NOTIFICATION STYLE', 390, null],
  ['App Store', 436, null],
  ['Calendar', 485, null],
  ['Clock', 534, null],
  ['Mail', 583, null],
  ['Messages', 632, null],
  ['Photos', 681, null],
  ['Safari', 730, null],
  ['Wallet', 779, null],
];

/** Approximate OCR centre of a left-aligned row label (17 pt system font ≈ 8.6 pt per character). */
function leftX(label, start = 36) {
  return Math.trunc(start + [...label].length * 4.3);
}

/** Approximate OCR centre of a right-aligned row value. */
function rightX(label) {
  return Math.trunc(352 - [...label].length * 4.3);
}

function text(label, x, y, extra = {}) {
  return { label, x, y, kind: 'text', ...extra };
}

function icon(name, x, y, size, extra = {}) {
  return { label: '', name, x, y, kind: 'icon', size, ...extra };
}

export function defaultPhoneState() {
  return {
    version: 1,
    stack: ['home'],
    scroll: {},
    toggles: {
      airplane: false,
      wifi: true,
      bluetooth: true,
      hotspot: false,
      batteryPercentage: false,
      lowPower: false,
    },
    wifiNetwork: 'HomeNetwork',
    pendingNetwork: null,
    fields: { 'safari.address': '', 'spotlight.query': '', 'message.draft': '', 'wifi.password': '' },
    focus: null,
    safariUrl: null,
    conversations: Object.fromEntries(CONVERSATIONS.map((c) => [c.name, c.messages.map((m) => ({ ...m }))])),
    recentApps: [],
    directive: null,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeState(raw) {
  const base = defaultPhoneState();
  if (!isObject(raw)) return base;
  const out = { ...base, ...raw };
  out.toggles = { ...base.toggles, ...(isObject(raw.toggles) ? raw.toggles : {}) };
  out.fields = { ...base.fields, ...(isObject(raw.fields) ? raw.fields : {}) };
  out.scroll = isObject(raw.scroll) ? raw.scroll : {};
  out.conversations = isObject(raw.conversations) ? raw.conversations : base.conversations;
  out.stack = Array.isArray(raw.stack) && raw.stack.length > 0 ? raw.stack.map(String) : ['home'];
  out.recentApps = Array.isArray(raw.recentApps) ? raw.recentApps.map(String) : [];
  return out;
}

/** iOS-style status bar clock ("9:41"): real local time, like the real phone. */
function clockLabel(now = new Date()) {
  const h = now.getHours() % 12 || 12;
  return `${h}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** Port of Mirroir's ElementMatcher order: exact → case-insensitive → diacritic-insensitive → substring → reverse substring. */
export function matchLabel(labels, wanted) {
  const fold = (s) =>
    s
      .normalize('NFD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  const target = wanted.trim();
  if (!target) return null;
  const candidates = labels.filter((l) => l.trim().length > 0);
  const strategies = [
    (l) => l.trim() === target,
    (l) => l.trim().toLowerCase() === target.toLowerCase(),
    (l) => fold(l) === fold(target),
    (l) => fold(l).includes(fold(target)),
    (l) => {
      const f = fold(l);
      return f.length >= Math.max(3, Math.ceil(fold(target).length / 2)) && fold(target).includes(f);
    },
  ];
  for (const strategy of strategies) {
    const hit = candidates.find(strategy);
    if (hit !== undefined) return hit;
  }
  return null;
}

export class Phone {
  constructor(state) {
    this.state = normalizeState(state);
  }

  static load(file) {
    if (!existsSync(file)) return new Phone(null);
    try {
      return new Phone(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
      return new Phone(null);
    }
  }

  save(file) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    renameSync(tmp, file);
  }

  get screenId() {
    return this.state.stack[this.state.stack.length - 1] ?? 'home';
  }

  // ───────────────────────────── navigation ─────────────────────────────

  static isValidScreen(id) {
    if (
      [
        'home',
        'settings',
        'wifi',
        'wifi_password',
        'battery',
        'notifications',
        'general',
        'safari',
        'messages',
        'spotlight',
        'app_switcher',
        'blank',
      ].includes(id)
    ) {
      return true;
    }
    return /^(app|detail|conversation):.+/.test(id);
  }

  /** Applies a `screen` directive from mock-state.json (tests use it to start somewhere specific). */
  applyDirective(screen) {
    this.state.focus = null;
    this.state.scroll = {};
    if (screen === 'home' || screen === 'blank' || screen === 'spotlight' || screen === 'app_switcher') {
      this.state.stack = [screen];
    } else if (['wifi', 'battery', 'notifications', 'general'].includes(screen) || screen.startsWith('detail:')) {
      this.state.stack = ['settings', screen];
    } else if (screen === 'wifi_password') {
      this.state.pendingNetwork = this.state.pendingNetwork ?? WIFI_NETWORKS[0];
      this.state.stack = ['settings', 'wifi', 'wifi_password'];
      this.state.focus = 'wifi.password';
    } else if (screen.startsWith('conversation:')) {
      this.state.stack = ['messages', screen];
    } else {
      this.state.stack = [screen];
    }
    if (screen === 'spotlight') {
      this.state.fields['spotlight.query'] = '';
      this.state.focus = 'spotlight.query';
    }
  }

  goHome() {
    this.state.stack = ['home'];
    this.state.focus = null;
  }

  openApp(name) {
    const app = KNOWN_APPS.find((a) => a.toLowerCase() === name.toLowerCase());
    if (!app) return false;
    this.state.stack = [ROOT_SCREEN_FOR_APP[app] ?? `app:${app}`];
    this.state.focus = null;
    this.state.scroll = {};
    this.state.recentApps = [app, ...this.state.recentApps.filter((a) => a !== app)].slice(0, 4);
    return true;
  }

  openSpotlight() {
    this.state.stack = ['spotlight'];
    this.state.fields['spotlight.query'] = '';
    this.state.focus = 'spotlight.query';
  }

  openAppSwitcher() {
    this.state.stack = ['app_switcher'];
    this.state.focus = null;
  }

  push(screen) {
    this.state.stack = [...this.state.stack, screen];
    this.state.focus = null;
  }

  /** Navigates back if the current screen has a back control. */
  back() {
    if (!this.hasBack() || this.state.stack.length < 2) return false;
    const leaving = this.screenId;
    this.state.stack = this.state.stack.slice(0, -1);
    delete this.state.scroll[leaving];
    this.state.focus = null;
    if (leaving === 'wifi_password') {
      this.state.fields['wifi.password'] = '';
      this.state.pendingNetwork = null;
    }
    return true;
  }

  hasBack() {
    const id = this.screenId;
    return (
      ['wifi', 'battery', 'notifications', 'general', 'wifi_password'].includes(id) ||
      id.startsWith('detail:') ||
      id.startsWith('conversation:')
    );
  }

  /** Spotlight results: prefix matches first, then substring matches. */
  spotlightHits(query = this.state.fields['spotlight.query']) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const prefix = KNOWN_APPS.filter((a) => a.toLowerCase().startsWith(q));
    const contains = KNOWN_APPS.filter((a) => !prefix.includes(a) && a.toLowerCase().includes(q));
    return [...prefix, ...contains];
  }

  // ───────────────────────────── screens ─────────────────────────────

  screenTitle(id) {
    if (id === 'settings') return 'Settings';
    if (id === 'general') return 'General';
    if (id === 'messages') return 'Messages';
    if (id === 'wifi') return 'Wi-Fi';
    if (id.startsWith('detail:')) return id.slice('detail:'.length);
    return '';
  }

  /** Builds the full (unscrolled) layout of the current screen. */
  layout() {
    const s = this.state;
    const id = this.screenId;
    const items = [];
    let tabBar = 0;
    const backLabel = () => {
      const parent = s.stack[s.stack.length - 2];
      return `< ${parent ? this.screenTitle(parent) : 'Back'}`;
    };
    const navBar = (title) => {
      items.push(text(backLabel(), 60, 70, { fixed: true, action: { type: 'back' } }));
      if (title) items.push(text(title, 205, 70, { fixed: true }));
    };

    switch (true) {
      case id === 'home': {
        HOME_GRID.forEach((row, r) => {
          row.forEach((app, c) => {
            items.push(text(app, ICON_COLUMNS[c], 112 + r * 100, { appIcon: true, fixed: true, action: { type: 'app', name: app } }));
          });
        });
        items.push(text('Search', 205, 764, { fixed: true, action: { type: 'spotlight' } }));
        DOCK.forEach((app, c) => {
          items.push(icon(app, ICON_COLUMNS[c], 838, 60, { fixed: true, action: { type: 'app', name: app } }));
        });
        break;
      }
      case id === 'settings': {
        const wifiValue = s.toggles.wifi ? s.wifiNetwork ?? 'Not Connected' : 'Off';
        items.push(text('Settings', 88, 117));
        items.push(text('Q Search', 204, 172));
        items.push(text('John Appleseed', 150, 247, { action: { type: 'open', screen: 'detail:Apple Account' } }));
        items.push(text('Apple Account, iCloud, and more', 188, 269, { action: { type: 'open', screen: 'detail:Apple Account' } }));
        const rows = [
          ['Airplane Mode', 343, { type: 'toggle', key: 'airplane' }, null, 'airplane'],
          ['Wi-Fi', 392, { type: 'open', screen: 'wifi' }, wifiValue, null],
          ['Bluetooth', 441, { type: 'open', screen: 'detail:Bluetooth' }, s.toggles.bluetooth ? 'On' : 'Off', null],
          ['Cellular', 490, { type: 'open', screen: 'detail:Cellular' }, null, null],
          ['Personal Hotspot', 539, { type: 'open', screen: 'detail:Personal Hotspot' }, s.toggles.hotspot ? 'On' : 'Off', null],
          ['Battery', 588, { type: 'open', screen: 'battery' }, null, null],
          ['General', 664, { type: 'open', screen: 'general' }, null, null],
          ['Accessibility', 713, null, null, null],
          ['Camera', 762, null, null, null],
          ['Control Center', 811, null, null, null],
          ['Display & Brightness', 860, null, null, null],
          ['Home Screen & App Library', 909, null, null, null],
          ['Search', 958, null, null, null],
          ['Siri', 1007, null, null, null],
          ['Wallpaper', 1056, null, null, null],
          ['Notifications', 1132, { type: 'open', screen: 'notifications' }, null, null],
          ['Sounds & Haptics', 1181, null, null, null],
          ['Focus', 1230, null, null, null],
          ['Screen Time', 1279, null, null, null],
          ['Face ID & Passcode', 1355, null, null, null],
          ['Emergency SOS', 1404, null, null, null],
          ['Privacy & Security', 1453, null, null, null],
          ['Game Center', 1529, null, null, null],
          ['iCloud', 1578, null, null, null],
          ['Wallet & Apple Pay', 1627, null, null, null],
          ['Apps', 1703, null, null, null],
        ];
        for (const [label, y, action, value, switchKey] of rows) {
          const act = action ?? { type: 'open', screen: `detail:${label}` };
          items.push(text(label, leftX(label, 80), y, { row: true, action: act }));
          if (value) items.push(text(value, rightX(value), y, { action: act }));
          if (switchKey) items.push(icon(`switch:${switchKey}`, 355, y, 30, { switchOn: s.toggles[switchKey], action: act }));
        }
        break;
      }
      case id === 'wifi': {
        navBar('Wi-Fi');
        const toggle = { type: 'toggle', key: 'wifi' };
        items.push(text('Wi-Fi', leftX('Wi-Fi'), 170, { row: true, action: toggle }));
        items.push(text(s.toggles.wifi ? 'On' : 'Off', 345, 170, { action: toggle, switchOn: s.toggles.wifi }));
        if (s.toggles.wifi) {
          if (s.wifiNetwork) items.push(text(s.wifiNetwork, leftX(s.wifiNetwork, 60), 220, { row: true }));
          items.push(text('NETWORKS', 70, 290));
          const others = [...WIFI_NETWORKS, 'HomeNetwork'].filter((n) => n !== s.wifiNetwork);
          others.forEach((name, i) => {
            items.push(text(name, leftX(name), 335 + i * 49, { row: true, action: { type: 'network', name } }));
          });
          items.push(text('Other...', leftX('Other...'), 335 + others.length * 49, { row: true }));
          items.push(text('Ask to Join Networks', leftX('Ask to Join Networks'), 600, { row: true }));
          items.push(text('Notify', rightX('Notify'), 600));
          items.push(text('Auto-Join Hotspot', leftX('Auto-Join Hotspot'), 649, { row: true }));
          items.push(text('Ask to Join', rightX('Ask to Join'), 649));
        } else {
          items.push(
            text('AirDrop, AirPlay, Notify When Left Behind, and improved location accuracy require Wi-Fi.', 205, 230),
          );
        }
        break;
      }
      case id === 'wifi_password': {
        const network = s.pendingNetwork ?? WIFI_NETWORKS[0];
        items.push(text('Cancel', 36, 70, { fixed: true, action: { type: 'back' } }));
        items.push(text('Enter Password', 205, 70, { fixed: true }));
        items.push(text('Join', 374, 70, { fixed: true, action: { type: 'join' } }));
        items.push(text(`Enter the password for "${network}"`, 205, 130));
        items.push(text('Password', 60, 190, { action: { type: 'focus', field: 'wifi.password' } }));
        const typed = s.fields['wifi.password'];
        items.push({
          label: typed ? '•'.repeat([...typed].length) : '',
          x: 250,
          y: 190,
          kind: typed ? 'text' : 'field',
          field: 'wifi.password',
          action: { type: 'focus', field: 'wifi.password' },
        });
        break;
      }
      case id === 'battery': {
        navBar('Battery');
        const pct = { type: 'toggle', key: 'batteryPercentage' };
        const low = { type: 'toggle', key: 'lowPower' };
        items.push(text('Battery Percentage', leftX('Battery Percentage'), 170, { row: true, action: pct }));
        items.push(text(s.toggles.batteryPercentage ? 'On' : 'Off', 345, 170, { action: pct, switchOn: s.toggles.batteryPercentage }));
        items.push(text('Low Power Mode', leftX('Low Power Mode'), 219, { row: true, action: low }));
        items.push(text(s.toggles.lowPower ? 'On' : 'Off', 345, 219, { action: low, switchOn: s.toggles.lowPower }));
        items.push(text('Battery Level', leftX('Battery Level'), 300));
        items.push(text('87%', 345, 300));
        items.push(text('Battery Health & Charging', leftX('Battery Health & Charging'), 380, { row: true }));
        break;
      }
      case id === 'notifications': {
        navBar('Notifications');
        for (const [label, y, value] of NOTIFICATION_ROWS) {
          const header = label === label.toUpperCase();
          items.push(text(label, leftX(label, header ? 30 : 36), y, header ? {} : { row: true, action: { type: 'open', screen: `detail:${label}` } }));
          if (value) items.push(text(value, rightX(value), y));
        }
        break;
      }
      case id === 'general': {
        navBar('General');
        for (const [label, y] of GENERAL_ROWS) {
          items.push(text(label, leftX(label), y, { row: true, action: { type: 'open', screen: `detail:${label}` } }));
        }
        break;
      }
      case id.startsWith('detail:'): {
        const title = id.slice('detail:'.length);
        navBar(title);
        if (title === 'About') {
          const rows = [
            ['Name', 'iPhone'],
            ['iOS Version', '26.0'],
            ['Model Name', 'iPhone 17 Pro'],
            ['Serial Number', 'MOCKSERIAL01'],
          ];
          rows.forEach(([k, v], i) => {
            items.push(text(k, leftX(k), 170 + i * 49, { row: true }));
            items.push(text(v, rightX(v), 170 + i * 49));
          });
        }
        break;
      }
      case id === 'safari': {
        const focused = s.focus === 'safari.address';
        const typed = s.fields['safari.address'];
        let address = 'Search or enter website name';
        if (focused && typed) address = typed;
        else if (!focused && s.safariUrl) address = hostOf(s.safariUrl);
        if (s.safariUrl) {
          const host = hostOf(s.safariUrl);
          if (host === 'example.com' || host === 'www.example.com') {
            items.push(text('Example Domain', 205, 160));
            items.push(text('This domain is for use in documentation examples without needing permission.', 205, 210));
            items.push(text('Learn more', 80, 260));
          } else {
            items.push(text(host, 205, 160));
          }
        } else {
          items.push(text('Favorites', 90, 150));
          FAVORITES.forEach((f, i) => {
            items.push(text(f.label, ICON_COLUMNS[i], 230, { appIcon: true, action: { type: 'url', url: f.url } }));
          });
          items.push(text('Privacy Report', 110, 360));
        }
        items.push({ label: address, x: 205, y: 790, kind: 'text', fixed: true, field: 'safari.address', action: { type: 'focus', field: 'safari.address' } });
        ['back', 'forward', 'share', 'bookmarks', 'tabs'].forEach((name, i) => {
          items.push(icon(`safari:${name}`, 41 + i * 82, 850, 24, { fixed: true }));
        });
        break;
      }
      case id === 'messages': {
        items.push(text('Edit', 40, 70, { fixed: true }));
        items.push(icon('messages:compose', 372, 70, 24, { fixed: true }));
        items.push(text('Messages', 110, 117));
        items.push(text('Search', 205, 172));
        CONVERSATIONS.forEach((c, i) => {
          const y = 250 + i * 80;
          const thread = s.conversations[c.name] ?? [];
          const last = thread[thread.length - 1]?.text ?? '';
          const open = { type: 'open', screen: `conversation:${c.name}` };
          items.push(text(c.name, leftX(c.name, 80), y, { row: true, action: open }));
          if (last) items.push(text(last, leftX(last, 80), y + 22, { action: open }));
          items.push(text(c.time, rightX(c.time), y, { action: open }));
        });
        break;
      }
      case id.startsWith('conversation:'): {
        const name = id.slice('conversation:'.length);
        items.push(text('<', 24, 70, { fixed: true, action: { type: 'back' } }));
        items.push(text(name, 205, 90, { fixed: true }));
        const thread = s.conversations[name] ?? [];
        thread.slice(-10).forEach((m, i) => {
          const x = m.from === 'me' ? Math.trunc(370 - [...m.text].length * 4.3) : Math.trunc(40 + [...m.text].length * 4.3);
          items.push(text(m.text, x, 200 + i * 50));
        });
        const draft = s.fields['message.draft'];
        items.push({ label: draft || 'iMessage', x: 180, y: 800, kind: 'text', fixed: true, field: 'message.draft', action: { type: 'focus', field: 'message.draft' } });
        items.push(icon('messages:send', 378, 800, 28, { fixed: true, action: { type: 'send' } }));
        break;
      }
      case id === 'spotlight': {
        const query = s.fields['spotlight.query'];
        const hits = this.spotlightHits(query);
        if (!query.trim()) {
          items.push(text('Siri Suggestions', 110, 150, { fixed: true }));
          ['Settings', 'Safari', 'Messages', 'Photos'].forEach((app, i) => {
            items.push(text(app, ICON_COLUMNS[i], 230, { appIcon: true, fixed: true, action: { type: 'app', name: app } }));
          });
        } else if (hits.length > 0) {
          items.push(text('Top Hit', 70, 120, { fixed: true }));
          items.push(text(hits[0], leftX(hits[0], 100), 190, { fixed: true, row: true, action: { type: 'app', name: hits[0] } }));
          hits.slice(1, 4).forEach((app, i) => {
            items.push(text(app, leftX(app, 100), 260 + i * 60, { fixed: true, row: true, action: { type: 'app', name: app } }));
          });
          items.push(text('Search Web', 100, 520, { fixed: true }));
        } else {
          items.push(text('No Results', 205, 300, { fixed: true }));
          items.push(text('Search Web', 100, 520, { fixed: true }));
        }
        items.push({ label: query ? `Q ${query}` : 'Q Search', x: 205, y: 780, kind: 'text', fixed: true, field: 'spotlight.query', action: { type: 'focus', field: 'spotlight.query' } });
        break;
      }
      case id === 'app_switcher': {
        const slots = [
          [110, 150],
          [300, 150],
          [110, 500],
          [300, 500],
        ];
        s.recentApps.slice(0, 4).forEach((app, i) => {
          const [x, y] = slots[i];
          items.push(text(app, x, y, { fixed: true, card: true, action: { type: 'app', name: app } }));
        });
        break;
      }
      case id === 'blank':
        break;
      case id.startsWith('app:'): {
        const app = id.slice('app:'.length);
        if (app === 'Photos') {
          items.push(text('Library', 90, 117));
          tabBar = 4;
          ['Library', 'For You', 'Albums', 'Search'].forEach((t, i) => items.push(text(t, ICON_COLUMNS[i], 846, { fixed: true })));
        } else if (app === 'Clock') {
          items.push(text('World Clock', 120, 117));
          items.push(text('Cupertino', 100, 220));
          items.push(text('Riyadh', 90, 300));
          tabBar = 4;
          ['World Clock', 'Alarms', 'Stopwatch', 'Timers'].forEach((t, i) => items.push(text(t, ICON_COLUMNS[i], 846, { fixed: true })));
        } else if (app === 'Wallet') {
          items.push(text('Wallet', 90, 117));
          items.push(text('Apple Card', 205, 300));
          items.push(text('Apple Cash', 205, 430));
        } else if (app === 'Mail') {
          items.push(text('Mailboxes', 70, 70, { fixed: true }));
          items.push(text('Inbox', 80, 117));
          items.push(text('Apple', 80, 200));
          items.push(text('Your receipt from Apple', 150, 222));
        } else {
          items.push(text(app, 205, 117));
        }
        break;
      }
      default:
        items.push(text(id, 205, 117));
    }

    const scrollable = ['settings', 'general', 'notifications'].includes(id);
    return { id, items, scrollable, tabBar };
  }

  maxScroll(layout = this.layout()) {
    if (!layout.scrollable) return 0;
    const bottom = Math.max(0, ...layout.items.filter((i) => !i.fixed).map((i) => i.y));
    return Math.max(0, bottom - 840);
  }

  scrollOffset() {
    return this.state.scroll[this.screenId] ?? 0;
  }

  /** Scrolls the current screen by `delta` pt (positive = content moves up). Returns true if it moved. */
  scrollBy(delta) {
    const layout = this.layout();
    if (!layout.scrollable) return false;
    const before = this.scrollOffset();
    const next = Math.max(0, Math.min(this.maxScroll(layout), before + delta));
    this.state.scroll[this.screenId] = next;
    return next !== before;
  }

  /** Elements currently on screen, in design coordinates (scroll applied), plus the status bar. */
  visibleElements(now = new Date()) {
    const layout = this.layout();
    const offset = layout.scrollable ? this.scrollOffset() : 0;
    const out = [];
    if (layout.id !== 'blank') {
      out.push({ label: clockLabel(now), x: 64, y: 27, kind: 'text', statusBar: true, fixed: true });
      if (this.state.toggles.batteryPercentage) out.push({ label: '87', x: 372, y: 27, kind: 'text', statusBar: true, fixed: true });
    }
    for (const item of layout.items) {
      const y = item.fixed ? item.y : item.y - offset;
      if (!item.fixed && (y < VISIBLE_TOP || y > VISIBLE_BOTTOM)) continue;
      out.push({ ...item, y });
    }
    return out;
  }

  /** Finds the element a tap at (x, y) design points lands on: nearest within ±25 pt, else a full-width row. */
  hitTest(x, y) {
    const elements = this.visibleElements().filter((e) => e.action);
    let best = null;
    let bestDist = Infinity;
    for (const e of elements) {
      const half = e.kind === 'icon' ? Math.max(HIT_RADIUS, e.size / 2) : HIT_RADIUS;
      const dx = Math.abs(e.x - x);
      const dy = Math.abs(e.y - y);
      if (dx <= half && dy <= half) {
        const d = Math.hypot(dx, dy);
        if (d < bestDist) {
          best = e;
          bestDist = d;
        }
      }
    }
    if (best) return best;
    return elements.find((e) => e.row && Math.abs(e.y - y) <= ROW_HALF_HEIGHT && x >= 16 && x <= DESIGN_W - 16) ?? null;
  }

  /** Applies a tap; returns the element that was hit (or null). */
  tap(x, y) {
    const hit = this.hitTest(x, y);
    if (hit) this.runAction(hit.action);
    return hit;
  }

  runAction(action) {
    const s = this.state;
    switch (action.type) {
      case 'app':
        this.openApp(action.name);
        break;
      case 'spotlight':
        this.openSpotlight();
        break;
      case 'open':
        this.push(action.screen);
        break;
      case 'back':
        this.back();
        break;
      case 'toggle':
        s.toggles[action.key] = !s.toggles[action.key];
        break;
      case 'focus':
        s.focus = action.field;
        break;
      case 'network':
        s.pendingNetwork = action.name;
        s.fields['wifi.password'] = '';
        this.push('wifi_password');
        s.focus = 'wifi.password';
        break;
      case 'join':
        this.joinNetwork();
        break;
      case 'url':
        s.safariUrl = action.url;
        s.focus = null;
        break;
      case 'send':
        this.sendMessage();
        break;
      default:
        break;
    }
  }

  joinNetwork() {
    const s = this.state;
    if (!s.fields['wifi.password'] || !s.pendingNetwork) return false;
    s.wifiNetwork = s.pendingNetwork;
    s.pendingNetwork = null;
    s.fields['wifi.password'] = '';
    s.stack = s.stack.filter((id) => id !== 'wifi_password');
    s.focus = null;
    return true;
  }

  sendMessage() {
    const s = this.state;
    const id = this.screenId;
    const draft = s.fields['message.draft'];
    if (!id.startsWith('conversation:') || !draft) return false;
    const name = id.slice('conversation:'.length);
    s.conversations[name] = [...(s.conversations[name] ?? []), { from: 'me', text: draft }];
    s.fields['message.draft'] = '';
    return true;
  }

  /** Text typed into the focused field (no field focused: the keystrokes go nowhere, like on a real phone). */
  insertText(value) {
    const field = this.state.focus;
    if (!field || !(field in this.state.fields)) return false;
    this.state.fields[field] += value;
    return true;
  }

  deleteBackward() {
    const field = this.state.focus;
    if (!field || !(field in this.state.fields)) return false;
    const chars = [...this.state.fields[field]];
    chars.pop();
    this.state.fields[field] = chars.join('');
    return true;
  }

  /** Return key: opens the Spotlight top hit, loads the Safari address, joins Wi-Fi. */
  pressReturn() {
    const s = this.state;
    switch (s.focus) {
      case 'spotlight.query': {
        const top = this.spotlightHits()[0];
        if (top) this.openApp(top);
        return Boolean(top);
      }
      case 'safari.address': {
        const typed = s.fields['safari.address'].trim();
        if (!typed) return false;
        s.safariUrl = /^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`;
        s.fields['safari.address'] = '';
        s.focus = null;
        return true;
      }
      case 'wifi.password':
        return this.joinNetwork();
      default:
        return false;
    }
  }
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Elements shown when Mirroring is paused (the overlay covers the phone). */
export function pausedOverlayElements() {
  return [
    { label: 'iPhone Mirroring Paused', x: 205, y: 420, kind: 'text', fixed: true },
    { label: 'Resume', x: 205, y: 500, kind: 'text', fixed: true },
  ];
}
