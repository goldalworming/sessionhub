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
