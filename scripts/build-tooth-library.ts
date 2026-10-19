/**
 * Build the tooth library used by the app from an arranged set-up of STL files.
 *
 *   npm run build:library -- <folder with the library STL files>
 *
 * Writes public/library/teeth/: one STL per tooth in the local tooth frame
 * (<fdi>.stl), its outer-surface samples (<fdi>.surface.bin) and manifest.json.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { processLibrary } from '../src/library/analyze';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run build:library -- <folder with STL files>');
  process.exit(1);
}
const outDir = resolve('public/library/teeth');
mkdirSync(outDir, { recursive: true });

const files = readdirSync(input).filter((f) => f.toLowerCase().endsWith('.stl'));
const entries = files.map((name) => {
  const buf = readFileSync(join(input, name));
  const g = new STLLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  g.deleteAttribute('normal');
  return { name, geometry: mergeVertices(g, 1e-5) };
});
console.log(`Read ${entries.length} STL files from ${input}`);

const t0 = Date.now();
const { teeth, notes } = processLibrary(entries);
for (const n of notes) console.log(`  note: ${n}`);

const exporter = new STLExporter();
for (const t of teeth) {
  const data = exporter.parse(new THREE.Mesh(t.geometry), { binary: true }) as DataView;
  writeFileSync(join(outDir, `${t.fdi}.stl`), new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  writeFileSync(join(outDir, `${t.fdi}.surface.bin`), new Uint8Array(t.surface.buffer));
  console.log(
    `  FDI ${t.fdi} (#${t.universal}) <- ${t.source}: ${t.mesiodistal.toFixed(1)} × ${t.buccolingual.toFixed(1)} × ${t.height.toFixed(1)} mm`,
  );
}
const round = (v: number) => Math.round(v * 1000) / 1000;
writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify(
    {
      format: 'dental-cad-tooth-library',
      version: 1,
      frame: 'x mesiodistal (buccal × occlusal), y buccal, z occlusal; cervical line on z = 0; mm',
      notes,
      teeth: teeth.map((t) => ({
        fdi: t.fdi,
        universal: t.universal,
        source: t.source,
        mesh: `${t.fdi}.stl`,
        surface: `${t.fdi}.surface.bin`,
        mesiodistal: round(t.mesiodistal),
        buccolingual: round(t.buccolingual),
        height: round(t.height),
        bottom: round(t.bottom),
      })),
    },
    null,
    2,
  ),
);
console.log(`Wrote ${teeth.length} teeth to ${outDir} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
