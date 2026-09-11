/* VTF pixel formats → RGBA8. Returns Uint8Array(w*h*4) or null when unsupported. */
function c565(v) { return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]; }
function dxt1Block(src, o, out, w, h, bx, by, alpha1) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8), a = c565(c0), b = c565(c1); const cols = [a, b];
  if (c0 > c1 || !alpha1) cols.push([(2 * a[0] + b[0]) / 3, (2 * a[1] + b[1]) / 3, (2 * a[2] + b[2]) / 3], [(a[0] + 2 * b[0]) / 3, (a[1] + 2 * b[1]) / 3, (a[2] + 2 * b[2]) / 3]);
  else cols.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], null);
  for (let y = 0; y < 4; y++) { const row = src[o + 4 + y]; for (let x = 0; x < 4; x++) { const c = cols[(row >> (x * 2)) & 3], px = bx + x, py = by + y; if (px >= w || py >= h) continue; const i = (py * w + px) * 4; if (!c) { out[i + 3] = 0; continue; } out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; if (alpha1) out[i + 3] = 255; } }
}
export function decodeVtf(fmt, data, w, h) {
  const out = new Uint8Array(w * h * 4); out.fill(255);
  if (fmt === 'DXT1' || fmt === 'DXT1_A1') { let o = 0; for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) { dxt1Block(data, o, out, w, h, bx, by, fmt === 'DXT1_A1'); o += 8; } return out; }
  if (fmt === 'DXT5' || fmt === 'DXT3') {
    let o = 0;
    for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
      dxt1Block(data, o + 8, out, w, h, bx, by, false);
      if (fmt === 'DXT3') { for (let y = 0; y < 4; y++) { const row = data[o + y * 2] | (data[o + y * 2 + 1] << 8); for (let x = 0; x < 4; x++) { const px = bx + x, py = by + y; if (px >= w || py >= h) continue; out[(py * w + px) * 4 + 3] = ((row >> (x * 4)) & 15) * 17; } } }
      else {
        const a0 = data[o], a1 = data[o + 1], al = [a0, a1];
        if (a0 > a1) for (let i = 1; i <= 6; i++) al.push(((7 - i) * a0 + i * a1) / 7); else { for (let i = 1; i <= 4; i++) al.push(((5 - i) * a0 + i * a1) / 5); al.push(0, 255); }
        let bits = 0n; for (let i = 0; i < 6; i++) bits |= BigInt(data[o + 2 + i]) << BigInt(i * 8);
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { const ai = Number((bits >> BigInt((y * 4 + x) * 3)) & 7n), px = bx + x, py = by + y; if (px >= w || py >= h) continue; out[(py * w + px) * 4 + 3] = al[ai]; }
      }
      o += 16;
    }
    return out;
  }
  const n = w * h;
  if (fmt === 'RGBA8888') return new Uint8Array(data.subarray(0, n * 4));
  if (fmt === 'BGRA8888') { for (let i = 0; i < n; i++) { out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4]; out[i * 4 + 3] = data[i * 4 + 3]; } return out; }
  if (fmt === 'RGB888') { for (let i = 0; i < n; i++) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; } return out; }
  if (fmt === 'BGR888') { for (let i = 0; i < n; i++) { out[i * 4] = data[i * 3 + 2]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3]; } return out; }
  if (fmt === 'BGRX8888') { for (let i = 0; i < n; i++) { out[i * 4] = data[i * 4 + 2]; out[i * 4 + 1] = data[i * 4 + 1]; out[i * 4 + 2] = data[i * 4]; } return out; }
  return null;
}
