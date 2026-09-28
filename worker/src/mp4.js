// Cut an Apple Music preview (single-track AAC in MP4) down to its first N seconds.
// The browser only ever receives the part of the song it has unlocked, and the
// rebuilt file drops udta/meta so the title and artist tags never leave the server.

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

function readBoxes(u8, start, end) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; }
    else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) throw new Error("bad box " + type);
    const box = { type, start: o, size, body: u8.subarray(o + hdr, o + size) };
    if (CONTAINERS.has(type)) box.kids = readBoxes(u8, o + hdr, o + size);
    out.push(box);
    o += size;
  }
  return out;
}
const find = (boxes, type) => boxes && boxes.find(b => b.type === type);
const path = (box, ...types) => types.reduce((b, t) => b && find(b.kids, t), box);

function box(type, ...parts) {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32s(...vals) {
  const out = new Uint8Array(vals.length * 4);
  const dv = new DataView(out.buffer);
  vals.forEach((v, i) => dv.setUint32(i * 4, v));
  return out;
}
const copy = b => b.body.slice();
const dvOf = u8 => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

// mvhd / mdhd / tkhd share a version byte that decides 32- vs 64-bit fields
function setField(body, off32, off64, val) {
  const dv = dvOf(body);
  if (body[0] === 1) dv.setBigUint64(off64, BigInt(Math.round(val)));
  else dv.setUint32(off32, Math.round(val));
}
function getField(body, off32, off64) {
  const dv = dvOf(body);
  return body[0] === 1 ? Number(dv.getBigUint64(off64)) : dv.getUint32(off32);
}

export function trimPreview(buf, seconds) {
  const u8 = new Uint8Array(buf);
  const top = readBoxes(u8, 0, u8.length);
  const ftyp = find(top, "ftyp"), moov = find(top, "moov");
  if (!ftyp || !moov || find(moov.kids, "mvex")) throw new Error("unsupported file");
  const traks = moov.kids.filter(b => b.type === "trak");
  if (traks.length !== 1) throw new Error("expected one track");
  const trak = traks[0];
  const mvhd = find(moov.kids, "mvhd"), tkhd = find(trak.kids, "tkhd");
  const mdia = find(trak.kids, "mdia"), mdhd = find(mdia.kids, "mdhd"), hdlr = find(mdia.kids, "hdlr");
  const minf = find(mdia.kids, "minf"), stbl = find(minf.kids, "stbl");
  const elst = path(trak, "edts", "elst");
  const get = t => find(stbl.kids, t);
  const stsd = get("stsd"), stts = get("stts"), stsc = get("stsc"), stsz = get("stsz"), stco = get("stco"), co64 = get("co64");
  if (!stsd || !stts || !stsc || !stsz || !(stco || co64)) throw new Error("missing sample tables");

  const movieTs = getField(mvhd.body, 12, 20);
  const mediaTs = getField(mdhd.body, 12, 20);

  // sample sizes
  const sz = dvOf(stsz.body);
  const fixed = sz.getUint32(4), count = sz.getUint32(8);
  const sizes = new Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || sz.getUint32(12 + i * 4);

  // sample durations
  const tt = dvOf(stts.body), durs = [];
  for (let e = 0, n = tt.getUint32(4); e < n; e++) {
    const c = tt.getUint32(8 + e * 8), d = tt.getUint32(12 + e * 8);
    for (let i = 0; i < c; i++) durs.push(d);
  }

  // sample file offsets from chunk offsets + sample-to-chunk runs
  const co = dvOf((stco || co64).body), nChunks = co.getUint32(4);
  const chunkOff = i => stco ? co.getUint32(8 + i * 4) : Number(co.getBigUint64(8 + i * 8));
  const sc = dvOf(stsc.body), nRuns = sc.getUint32(4);
  const offsets = [];
  const descIdx = sc.getUint32(16);
  for (let r = 0, s = 0; r < nRuns; r++) {
    const first = sc.getUint32(8 + r * 12) - 1, per = sc.getUint32(12 + r * 12);
    const last = r + 1 < nRuns ? sc.getUint32(8 + (r + 1) * 12) - 1 : nChunks;
    for (let c = first; c < last; c++) {
      let o = chunkOff(c);
      for (let k = 0; k < per && s < count; k++, s++) { offsets.push(o); o += sizes[s]; }
    }
  }

  // how many samples cover the requested time (after the encoder-delay edit)
  let mediaTime = 0;
  if (elst) {
    const ev = dvOf(elst.body);
    mediaTime = elst.body[0] === 1 ? Number(ev.getBigInt64(16)) : ev.getInt32(12);
    if (mediaTime < 0) mediaTime = 0;
  }
  const want = mediaTime + seconds * mediaTs;
  let n = 0, t = 0;
  while (n < count && n < durs.length && t < want) t += durs[n++];
  if (!n) throw new Error("empty");

  // stts, compressed back into runs
  const runs = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && last[1] === durs[i]) last[0]++; else runs.push([1, durs[i]]);
  }
  const newStts = box("stts", u32s(0, runs.length, ...runs.flat()));
  const newStsc = box("stsc", u32s(0, 1, 1, n, descIdx));
  const newStsz = box("stsz", u32s(0, 0, n, ...sizes.slice(0, n)));
  const mdatLen = sizes.slice(0, n).reduce((a, b) => a + b, 0);

  const build = chunkOffset => {
    const newStbl = box("stbl", u8.slice(stsd.start, stsd.start + stsd.size), newStts, newStsc, newStsz, box("stco", u32s(0, 1, chunkOffset)));
    const smhd = find(minf.kids, "smhd"), dinf = find(minf.kids, "dinf");
    const newMinf = box("minf", ...[smhd, dinf].filter(Boolean).map(b => u8.slice(b.start, b.start + b.size)), newStbl);
    const md = copy(mdhd); setField(md, 16, 24, t);
    const newMdia = box("mdia", box("mdhd", md), u8.slice(hdlr.start, hdlr.start + hdlr.size), newMinf);
    const movieDur = Math.max(0, t - mediaTime) * movieTs / mediaTs;
    const th = copy(tkhd); setField(th, 20, 28, movieDur);
    const parts = [box("tkhd", th)];
    if (elst) {
      const el = copy(elst);
      const ev = dvOf(el);
      ev.setUint32(4, 1);
      if (el[0] === 1) ev.setBigUint64(8, BigInt(Math.round(movieDur))); else ev.setUint32(8, Math.round(movieDur));
      parts.push(box("edts", box("elst", el.subarray(0, el[0] === 1 ? 28 : 20))));
    }
    parts.push(newMdia);
    const mv = copy(mvhd); setField(mv, 16, 24, movieDur);
    return box("moov", box("mvhd", mv), box("trak", ...parts));
  };
  const ftypBytes = u8.slice(ftyp.start, ftyp.start + ftyp.size);
  const moovLen = build(0).length;
  const newMoov = build(ftypBytes.length + moovLen + 8);

  const out = new Uint8Array(ftypBytes.length + newMoov.length + 8 + mdatLen);
  out.set(ftypBytes, 0);
  out.set(newMoov, ftypBytes.length);
  let o = ftypBytes.length + newMoov.length;
  new DataView(out.buffer).setUint32(o, 8 + mdatLen);
  out.set([109, 100, 97, 116], o + 4); // "mdat"
  o += 8;
  // samples may sit in several chunks; copy runs of contiguous bytes
  for (let i = 0; i < n;) {
    let j = i, end = offsets[i] + sizes[i];
    while (j + 1 < n && offsets[j + 1] === end) { j++; end += sizes[j]; }
    out.set(u8.subarray(offsets[i], end), o);
    o += end - offsets[i];
    i = j + 1;
  }
  return out;
}
