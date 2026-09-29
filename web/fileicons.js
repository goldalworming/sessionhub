// File icons for the tree panel.
//
// One SVG sprite is injected into the page once; every row only uses
// `<use href="#…">`. That means drawing a thousand rows is still one shape
// definition, not a thousand — and that is what keeps an arbitrarily long tree
// light. Every colour is hard-coded inside the symbols so they do not shift
// with the text theme.

const SPRITE_ID = 'sh-file-icons';

/// The shapes are deliberately simple: one rounded badge with two or three
/// letters. What the eye looks for while scanning a file list is **colour**, not
/// logo detail — and badges win by a mile on file size.
const BADGES = [
  ['js', 'JS', '#c9a227', '#2a2308'],
  ['ts', 'TS', '#2a72c4', '#ffffff'],
  ['json', '{ }', '#8a8f94', '#ffffff'],
  ['md', 'M↓', '#3f7a2e', '#ffffff'],
  ['html', '<>', '#c1502e', '#ffffff'],
  ['css', '#', '#2a5db0', '#ffffff'],
  ['rs', 'RS', '#8a6642', '#ffffff'],
  ['py', 'PY', '#2f6f9f', '#ffe873'],
  ['go', 'GO', '#1f7a85', '#ffffff'],
  ['sh', '$_', '#4a5058', '#9ee493'],
  ['toml', 'TO', '#7a5c3e', '#ffffff'],
  ['yaml', 'YM', '#8b3e9e', '#ffffff'],
  ['img', '▣', '#7a4fa2', '#ffffff'],
  ['lock', '▤', '#6b7280', '#ffffff'],
  ['txt', '≡', '#6b7280', '#ffffff'],
  ['c', 'C', '#2a5db0', '#ffffff'],
  ['cpp', 'C+', '#8b3e9e', '#ffffff'],
  ['java', 'J', '#c0392b', '#ffffff'],
  ['php', 'PH', '#4a5da0', '#ffffff'],
  ['rb', 'RB', '#b02a2a', '#ffffff'],
];

function badge(id, label, bg, fg) {
  // The label length sets the font size; three characters must not overflow.
  const size = label.length >= 3 ? 7 : 8.5;
  return (
    `<symbol id="shi-${id}" viewBox="0 0 16 16">` +
    `<rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="${bg}"/>` +
    `<text x="8" y="8" fill="${fg}" font-size="${size}" font-family="ui-sans-serif,system-ui,sans-serif"` +
    ` font-weight="700" text-anchor="middle" dominant-baseline="central">${label}</text>` +
    '</symbol>'
  );
}

/// The ones that are not badges: real shapes, because these two show up most.
const SHAPES =
  // A sheet of paper with a folded corner — an unknown file.
  '<symbol id="shi-file" viewBox="0 0 16 16">' +
  '<path d="M4 1.5h5l3.5 3.5v9.5H4z" fill="none" stroke="#8a8f94" stroke-width="1.2"/>' +
  '<path d="M9 1.5V5h3.5" fill="none" stroke="#8a8f94" stroke-width="1.2"/>' +
  '</symbol>' +
  // A database cylinder — .sql and .db.
  '<symbol id="shi-sql" viewBox="0 0 16 16">' +
  '<ellipse cx="8" cy="4" rx="5" ry="2.2" fill="#c98a2e"/>' +
  '<path d="M3 4v8c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V4" fill="#c98a2e"/>' +
  '<ellipse cx="8" cy="4" rx="5" ry="2.2" fill="none" stroke="#8a5e18" stroke-width="0.9"/>' +
  '<path d="M3 8.2c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2" fill="none" stroke="#8a5e18" stroke-width="0.9"/>' +
  '</symbol>' +
  // Folder, closed and open.
  '<symbol id="shi-folder" viewBox="0 0 16 16">' +
  '<path d="M1.5 3.5h4.2l1.3 1.6h7.5v7.4h-13z" fill="#7f8b97"/>' +
  '</symbol>' +
  '<symbol id="shi-folder-open" viewBox="0 0 16 16">' +
  '<path d="M1.5 3.5h4.2l1.3 1.6h7.5v2h-13z" fill="#7f8b97"/>' +
  '<path d="M1.5 7.1h13l-1.6 5.4h-11z" fill="#9aa6b2"/>' +
  '</symbol>' +
  // Git.
  '<symbol id="shi-git" viewBox="0 0 16 16">' +
  '<circle cx="4.5" cy="4" r="1.9" fill="#e05c3a"/>' +
  '<circle cx="4.5" cy="12" r="1.9" fill="#e05c3a"/>' +
  '<circle cx="11.5" cy="7" r="1.9" fill="#e05c3a"/>' +
  '<path d="M4.5 6v4M4.5 8h3.6a2 2 0 0 0 2-2v-.2" fill="none" stroke="#e05c3a" stroke-width="1.2"/>' +
  '</symbol>';

/// Extension → symbol name. Anything unlisted falls back to `shi-file`.
const BY_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'ts',
  json: 'json', jsonc: 'json',
  md: 'md', markdown: 'md', mdx: 'md',
  html: 'html', htm: 'html', xml: 'html', svelte: 'html', vue: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  rs: 'rs',
  py: 'py', pyi: 'py',
  go: 'go',
  sh: 'sh', bash: 'sh', zsh: 'sh', bat: 'sh', cmd: 'sh', ps1: 'sh',
  toml: 'toml', ini: 'toml', cfg: 'toml', conf: 'toml', env: 'toml',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql', db: 'sql', sqlite: 'sql',
  png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img',
  svg: 'img', ico: 'img', avif: 'img', bmp: 'img',
  lock: 'lock', zip: 'lock', gz: 'lock', tar: 'lock', exe: 'lock', dll: 'lock',
  txt: 'txt', log: 'txt', csv: 'txt',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  java: 'java', kt: 'java',
  php: 'php',
  rb: 'rb',
  rc: 'txt', manifest: 'html',
};

/// Whole names with an icon of their own, checked before the extension.
const BY_NAME = {
  license: 'txt',
  'license.md': 'txt',
  makefile: 'sh',
  dockerfile: 'toml',
  '.git': 'git',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
};

/// Folders, drives and Places for the file finder, drawn the way the machine
/// they live on draws them: Windows 11's amber folder and colourful Places
/// pictures, or macOS's (Big Sur and later) light-blue folder and blue line
/// glyphs. A 32-unit grid, not 16 like the badges above: a folder is shown
/// at 16px in a row and 88px in the Thumbnail grid, and has to hold up at
/// both.
///
/// Places are standalone glyphs — a monitor, an arrow, a page — not a folder
/// with an emblem: that is what both navigation panes show, and at sidebar
/// size an emblem inside a folder is a smudge.
///
/// `shi-w-<kind>` / `shi-m-<kind>`: `folder`, `drive`, or `p-<place>`.
const MAC_INK = '#1f7fe0';
const macLine = (d) =>
  `<path d="${d}" fill="none" stroke="${MAC_INK}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>`;

/// `[windows, mac]` per place. Windows Home is its user folder — plain
/// amber folder, as Explorer shows it — so it has no entry of its own there.
const PLACE_GLYPHS = {
  home: [
    null,
    macLine('M4.5 15.5 16 5.5l11.5 10M8 12.6V26.5h16V12.6M13.5 26.5v-6.5h5v6.5'),
  ],
  desktop: [
    '<rect x="2.5" y="4.5" width="27" height="19" rx="2.2" fill="#1a6fc9"/>' +
      '<rect x="4.5" y="6.5" width="23" height="15" rx="1" fill="url(#shg-ws)"/>' +
      '<path d="M16 23.5v4M10.5 28h11" stroke="#1a6fc9" stroke-width="2.4" stroke-linecap="round"/>',
    `<rect x="3.5" y="5" width="25" height="17.5" rx="2.6" fill="none" stroke="${MAC_INK}" stroke-width="2.3"/>` +
      macLine('M16 22.5v4.5M10.5 27.5h11'),
  ],
  documents: [
    '<path d="M6.5 2.5h12.5l6.5 6.5v20.5h-19z" fill="#fff" stroke="#9aa8b8" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M19 2.5V9h6.5z" fill="#dbe4ee" stroke="#9aa8b8" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<path d="M10.5 14h11M10.5 18.5h11M10.5 23h7.5" stroke="#1a6fc9" stroke-width="1.8" stroke-linecap="round"/>',
    macLine('M7.5 3.5h10l7 7v18h-17zM17.5 3.5v7h7M12 17h8M12 21.5h8'),
  ],
  downloads: [
    '<path d="M16 3.5v18M8 14l8 8 8-8" fill="none" stroke="#17a34a" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M5.5 28h21" stroke="#17a34a" stroke-width="3.2" stroke-linecap="round"/>',
    `<circle cx="16" cy="16" r="12.2" fill="none" stroke="${MAC_INK}" stroke-width="2.3"/>` +
      macLine('M16 9.5v13M10.5 17.5l5.5 5.5 5.5-5.5'),
  ],
  music: [
    '<circle cx="16" cy="16" r="13.5" fill="url(#shg-wm)"/>' +
      '<path d="M13.5 21.5V10.2l7.6-2v10.6" fill="none" stroke="#fff" stroke-width="2.1" stroke-linejoin="round"/>' +
      '<circle cx="11.4" cy="21.6" r="2.7" fill="#fff"/><circle cx="19" cy="19" r="2.7" fill="#fff"/>',
    macLine('M12 23.5V8l13-3.2v15.4') +
      `<circle cx="8.8" cy="23.6" r="3.4" fill="${MAC_INK}"/><circle cx="21.8" cy="20.3" r="3.4" fill="${MAC_INK}"/>`,
  ],
  pictures: [
    '<rect x="2.5" y="4.5" width="27" height="23" rx="3" fill="#1a6fc9"/>' +
      '<path d="M2.5 23l8-8.5 5.8 5.8 4.2-4.2 9 9.2v.2a3 3 0 0 1-3 2H5.5a3 3 0 0 1-3-3z" fill="#8fd6ff"/>' +
      '<circle cx="22" cy="11" r="2.8" fill="#ffd54a"/>',
    `<rect x="3.5" y="5.5" width="25" height="21" rx="2.8" fill="none" stroke="${MAC_INK}" stroke-width="2.3"/>` +
      macLine('M4.5 23.5l7-7 5.5 5.5 3.5-3.5 7 7') +
      `<circle cx="21.5" cy="11.8" r="2.4" fill="${MAC_INK}"/>`,
  ],
  videos: [
    '<rect x="2.5" y="5" width="27" height="22" rx="3" fill="url(#shg-wv)"/>' +
      '<path d="M2.5 10.5h27M2.5 21.5h27" stroke="#fff" stroke-opacity=".35" stroke-width="1.2"/>' +
      '<path d="M13 12.2v7.6l6.8-3.8z" fill="#fff"/>',
    `<rect x="3.5" y="5.5" width="25" height="21" rx="2.8" fill="none" stroke="${MAC_INK}" stroke-width="2.3"/>` +
      macLine('M10 5.5v21M22 5.5v21M3.5 12h6.5M3.5 20h6.5M22 12h6.5M22 20h6.5'),
  ],
};

const WIN_FOLDER =
  '<path d="M5 5.5h6.3c.5 0 1 .2 1.4.6L14.8 8H27a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z" fill="#e3a008"/>' +
  '<rect x="3" y="10.6" width="26" height="15.4" rx="2" fill="url(#shg-wf)"/>' +
  '<path d="M5 10.6h22a2 2 0 0 1 2 2v.4H3v-.4a2 2 0 0 1 2-2z" fill="#ffe28a" opacity=".7"/>';

const MAC_FOLDER =
  '<path d="M5.2 5h6.2c.7 0 1.3.3 1.8.8L15 7.6h11.8A2.2 2.2 0 0 1 29 9.8v15a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 24.8V7.2A2.2 2.2 0 0 1 5.2 5z" fill="url(#shg-mb)"/>' +
  '<rect x="3" y="10.2" width="26" height="16.8" rx="2.2" fill="url(#shg-mf)"/>' +
  '<path d="M5.2 10.2h21.6a2.2 2.2 0 0 1 2.2 2.2v.2H3v-.2a2.2 2.2 0 0 1 2.2-2.2z" fill="#fff" opacity=".35"/>';

const WIN_DRIVE =
  '<rect x="3" y="9" width="26" height="15" rx="2.6" fill="url(#shg-wd)"/>' +
  '<path d="M3 18.6h26v2.8a2.6 2.6 0 0 1-2.6 2.6H5.6A2.6 2.6 0 0 1 3 21.4z" fill="#8c96a3"/>' +
  '<rect x="3.5" y="9.5" width="25" height="14" rx="2.2" fill="none" stroke="#fff" stroke-opacity=".5"/>' +
  '<rect x="21.5" y="20.2" width="4.6" height="1.6" rx=".8" fill="#3ddc84"/>';

const MAC_DRIVE =
  '<rect x="3" y="9" width="26" height="15" rx="3.2" fill="url(#shg-md)"/>' +
  '<rect x="3.5" y="9.5" width="25" height="14" rx="2.8" fill="none" stroke="#fff" stroke-opacity=".8"/>' +
  '<path d="M3 19h26" stroke="#b9bcc4" stroke-width=".8"/>' +
  '<circle cx="24.6" cy="21.4" r=".9" fill="#8e929b"/>';

const GRADIENTS =
  '<defs>' +
  '<linearGradient id="shg-wf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd257"/><stop offset="1" stop-color="#fbbc2c"/></linearGradient>' +
  '<linearGradient id="shg-mb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5bb7f6"/><stop offset="1" stop-color="#3d9ce8"/></linearGradient>' +
  '<linearGradient id="shg-mf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a9dcfd"/><stop offset="1" stop-color="#7cc4f9"/></linearGradient>' +
  '<linearGradient id="shg-wd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eef1f4"/><stop offset="1" stop-color="#c3cad3"/></linearGradient>' +
  '<linearGradient id="shg-md" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f6f8"/><stop offset="1" stop-color="#d2d3d8"/></linearGradient>' +
  '<linearGradient id="shg-ws" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6fd3ff"/><stop offset="1" stop-color="#2b9be6"/></linearGradient>' +
  '<linearGradient id="shg-wm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset="1" stop-color="#e8502a"/></linearGradient>' +
  '<linearGradient id="shg-wv" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9f7aea"/><stop offset="1" stop-color="#7c4ddb"/></linearGradient>' +
  '</defs>';

const sym = (id, body) => `<symbol id="${id}" viewBox="0 0 32 32">${body}</symbol>`;

const PLACE_SHAPES =
  GRADIENTS +
  sym('shi-w-folder', WIN_FOLDER) +
  sym('shi-m-folder', MAC_FOLDER) +
  sym('shi-w-drive', WIN_DRIVE) +
  sym('shi-m-drive', MAC_DRIVE) +
  Object.entries(PLACE_GLYPHS)
    .map(([kind, [win, mac]]) =>
      (win ? sym(`shi-w-p-${kind}`, win) : '') + sym(`shi-m-p-${kind}`, mac))
    .join('');

/// Place name → its kind. Case-insensitive; `Movies` is macOS's name for
/// Videos. Anything unlisted is a plain folder.
const PLACE_KIND = {
  home: 'home',
  desktop: 'desktop',
  documents: 'documents',
  downloads: 'downloads',
  music: 'music',
  pictures: 'pictures',
  videos: 'videos',
  movies: 'videos',
};

/// The symbol for a Places entry — its glyph, or the plain folder for one
/// with none — in the style of `mac` or not.
export function placeIconFor(name, mac) {
  const kind = PLACE_KIND[name.toLowerCase()];
  const glyphs = kind && PLACE_GLYPHS[kind];
  if (glyphs && glyphs[mac ? 1 : 0]) return `shi-${mac ? 'm' : 'w'}-p-${kind}`;
  return folderIconFor(mac);
}

export function driveIconFor(mac) {
  return `shi-${mac ? 'm' : 'w'}-drive`;
}

export function folderIconFor(mac) {
  return `shi-${mac ? 'm' : 'w'}-folder`;
}

let injected = false;

/// Install the sprite once. Safe to call repeatedly.
export function installIcons() {
  if (injected || document.getElementById(SPRITE_ID)) return;
  const holder = document.createElement('div');
  holder.id = SPRITE_ID;
  holder.setAttribute('aria-hidden', 'true');
  // Hidden but still usable by `<use>`; `display:none` would kill it in some
  // browsers, so its size is zeroed instead.
  holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  holder.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg">' +
    BADGES.map((b) => badge(...b)).join('') +
    SHAPES +
    PLACE_SHAPES +
    '</svg>';
  document.body.appendChild(holder);
  injected = true;
}

/// The symbol name for one entry.
export function iconFor(name, isDir, open = false) {
  if (isDir) return open ? 'shi-folder-open' : 'shi-folder';
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return `shi-${BY_NAME[lower]}`;
  const dot = lower.lastIndexOf('.');
  // A file that is nothing but an extension (`.env`) is still recognised.
  const ext = dot > 0 ? lower.slice(dot + 1) : dot === 0 ? lower.slice(1) : '';
  return `shi-${BY_EXT[ext] || 'file'}`;
}

/// The Monaco language for a file name. Kept apart from the icons because the
/// mapping differs: `.mjs` has the JS icon but its language is `javascript`.
const BY_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  rs: 'rust',
  py: 'python', pyi: 'python',
  go: 'go',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  bat: 'bat', cmd: 'bat', ps1: 'powershell',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', env: 'ini',
  yaml: 'yaml', yml: 'yaml',
  sql: 'sql',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', php: 'php',
  cs: 'csharp', lua: 'lua', dart: 'dart', r: 'r', scala: 'scala',
  graphql: 'graphql', gql: 'graphql', proto: 'proto', dockerfile: 'dockerfile',
};

export function languageFor(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile') return 'makefile';
  const dot = lower.lastIndexOf('.');
  const ext = dot > 0 ? lower.slice(dot + 1) : dot === 0 ? lower.slice(1) : '';
  return BY_LANG[ext] || 'plaintext';
}
