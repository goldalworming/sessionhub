Monaco Editor 0.52.2, dipangkas.

Yang dibawa: `loader.js`, `base/`, `editor/`, `basic-languages/`.
Yang sengaja dibuang: `language/` (~7 MB) — itu layanan bahasa kaya untuk
TypeScript, HTML, CSS, dan JSON: compiler TS penuh berikut worker-nya. Panel ini
membuka berkas untuk dibaca dan disunting sesekali, bukan menggantikan IDE, dan
worker sebesar itu justru bertabrakan dengan alasan panel ini ada — cepat.

Pewarnaan sintaks tetap lengkap: itu datang dari `basic-languages/` (Monarch),
bukan dari `language/`.

MIT, lihat LICENSE.
