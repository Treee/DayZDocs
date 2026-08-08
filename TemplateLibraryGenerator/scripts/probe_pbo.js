#!/usr/bin/env node
// Read-only probe: dumps PBO header properties and first N filenames.
// Usage: node probe_pbo.js <path-to.pbo> [<path2.pbo> ...]

import { readFileSync } from "node:fs";

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

const maxEntries = argVal("--entries") ? Number(argVal("--entries")) : 12;

function probe(filePath) {
    const buf = readFileSync(filePath);
    console.log(`\n=== ${filePath} (${buf.length} bytes) ===`);

    // Signature: "sreV" (little-endian "Vers"), optionally preceded by a NUL.
    // DayZ PBOs begin with a single 0x00 byte then "sreV".
    const sigIdx = buf.indexOf(Buffer.from("sreV", "latin1"), 0, "latin1");
    if (sigIdx === -1) {
        const sig = buf.toString("latin1", 0, 4);
        throw new Error(`${filePath}: not a PBO (sig=${JSON.stringify(sig)})`);
    }

    // After "sreV" there is a reserved zero byte area, then property pairs.
    // Hex: 00 73 72 65 56 00...00 70 72 6f 64 75 63 74 ...
    // so scan from sig+4 past all zero bytes to the first printable byte.
    let off = sigIdx + 4;
    while (off < buf.length && buf[off] === 0) off++;
    const props = {};
    let order = 0;
    for (;;) {
        // read c-string name (value is read only when name is non-empty)
        let nameEnd = buf.indexOf(0, off);
        if (nameEnd === -1) throw new Error(`${filePath}: unterminated prop name @${off}`);
        const name = buf.toString("latin1", off, nameEnd);
        off = nameEnd + 1;
        if (name === "") break; // empty name terminates header props; off now at first file entry
        let valEnd = buf.indexOf(0, off);
        if (valEnd === -1) throw new Error(`${filePath}: unterminated prop value @${off}`);
        const value = buf.toString("latin1", off, valEnd);
        off = valEnd + 1;
        props[name] = value;
        order++;
    }
    console.log(`  props(${order}):`, JSON.stringify(props, null, 2));

    // ---- body: file entries: "name\0" + 4x uint32 LE (packingMethod, origSize, reserved, timestamp)
    let count = 0;
    let entries = [];
    for (;;) {
        let nameEnd = buf.indexOf(0, off);
        if (nameEnd === -1) throw new Error(`${filePath}: unterminated block name @${off}`);
        const name = buf.toString("latin1", off, nameEnd);
        off = nameEnd + 1;
        if (name === "") {
            // read count + dataOffset
            count = buf.readUInt32LE(off);
            off += 4;
            const dataOff = buf.readUInt32LE(off);
            off += 4;
            console.log(`  fileCount=${count} dataOffset=${dataOff}`);
            break;
        }
        const packing = buf.readUInt32LE(off);
        const origSize = buf.readUInt32LE(off + 4);
        const reserved = buf.readUInt32LE(off + 8);
        const ts = buf.readUInt32LE(off + 12);
        off += 16;
        entries.push({ name, packing, origSize, reserved, ts });
        if (entries.length >= maxEntries) {
            console.log(`  (stopping at ${maxEntries} entries for display)`);
            break;
        }
    }
    if (entries.length === 0) {
        console.log("  (no entries displayed)");
    } else {
        for (const e of entries) {
            console.log(`  ${e.name}  pack=${e.packing} size=${e.origSize}`);
        }
    }
}

for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) continue;
    try {
        probe(process.argv[i]);
    } catch (e) {
        console.error(`  ERROR: ${e.message}`);
    }
}
