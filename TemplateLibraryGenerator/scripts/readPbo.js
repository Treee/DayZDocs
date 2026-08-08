#!/usr/bin/env node
// readPbo.js — zero-dependency PBO file-table reader for DayZ.
//
// DayZ PBO format (verified against live game files):
//   [0x00] "sreV" (little-endian "Vers")  <- leading NUL + reversed signature
//   [reserved zero bytes]
//   <name>\0<value>\0 ...  (header properties: product, prefix, version)
//   \0                     (empty name terminates header properties)
//   <filename>\0 + 20 bytes metadata ... (file table)
//   \0 + uint32 fileCount + uint32 dataOffset  (terminator)
//
// We only need the filenames + prefix to reconstruct asset paths, so we
// parse the header and iterate the file table, skipping the 20-byte
// metadata block after each filename.

import { readFileSync } from "node:fs";

const METADATA_SIZE = 20; // packing(4) + origSize(4) + reserved(4) + timestamp(4) + extra(4)

/**
 * Parse a PBO file and return its header properties + file table entries.
 * @param {string} pboPath - absolute path to the .pbo file
 * @returns {{ prefix: string, product: string, version: string, entries: Array<{name:string, packing:number, origSize:number, reserved:number, timestamp:number}> }}
 */
export function readPboFileTable(pboPath) {
    const buf = readFileSync(pboPath);

    // Locate the "sreV" signature (preceded by a leading NUL in DayZ PBOs).
    const sigIdx = buf.indexOf(Buffer.from("sreV", "latin1"), 0, "latin1");
    if (sigIdx === -1) {
        throw new Error(`${pboPath}: not a PBO (missing "sreV" signature)`);
    }

    // Skip past the signature and any reserved zero bytes to the first property.
    let off = sigIdx + 4;
    while (off < buf.length && buf[off] === 0) off++;

    // ---- header properties: <name>\0<value>\0 until empty name \0
    const props = { product: "", prefix: "", version: "" };
    for (;;) {
        const nameEnd = buf.indexOf(0, off);
        if (nameEnd === -1) throw new Error(`${pboPath}: unterminated property name @${off}`);
        const name = buf.toString("latin1", off, nameEnd);
        off = nameEnd + 1;
        if (name === "") break; // empty name terminates header properties
        const valEnd = buf.indexOf(0, off);
        if (valEnd === -1) throw new Error(`${pboPath}: unterminated property value @${off}`);
        const value = buf.toString("latin1", off, valEnd);
        off = valEnd + 1;
        props[name] = value;
    }

    // ---- file table: <filename>\0 + 20 bytes metadata, until empty name
    const entries = [];
    for (;;) {
        const nameEnd = buf.indexOf(0, off);
        if (nameEnd === -1) throw new Error(`${pboPath}: unterminated file entry name @${off}`);
        const name = buf.toString("latin1", off, nameEnd);
        off = nameEnd + 1;
        if (name === "") {
            // terminator: fileCount + dataOffset follow
            break;
        }
        const packing = buf.readUInt32LE(off);
        const origSize = buf.readUInt32LE(off + 4);
        const reserved = buf.readUInt32LE(off + 8);
        const timestamp = buf.readUInt32LE(off + 12);
        off += METADATA_SIZE;
        entries.push({ name, packing, origSize, reserved, timestamp });
    }

    return {
        prefix: props.prefix || "",
        product: props.product || "",
        version: props.version || "",
        entries,
    };
}

/**
 * Scan a PBO for .p3d and config.bin entries, returning full virtual paths.
 * Paths are lowercased with backslash separators to match the existing
 * crawler's output convention (e.g. "dz\plants\bush\b_betulahumilis_1s.p3d").
 * @param {string} pboPath - absolute path to the .pbo file
 * @returns {{ p3ds: string[], configs: string[] }}
 */
export function scanPboForP3ds(pboPath) {
    const { prefix, entries } = readPboFileTable(pboPath);
    const base = prefix.toLowerCase().replace(/\\+$/, "");
    const p3ds = [];
    const configs = [];
    for (const entry of entries) {
        const name = entry.name.toLowerCase();
        if (name.endsWith(".p3d")) {
            p3ds.push(base ? `${base}\\${name}` : name);
        } else if (name.endsWith("config.bin")) {
            configs.push(base ? `${base}\\${name}` : name);
        }
    }
    return { p3ds, configs };
}

// CLI: node readPbo.js <path-to.pbo> [--entries N]
if (process.argv[1] && process.argv[1].endsWith("readPbo.js")) {
    const argVal = (flag) => {
        const i = process.argv.indexOf(flag);
        return i > -1 ? process.argv[i + 1] : null;
    };
    const maxEntries = argVal("--entries") ? Number(argVal("--entries")) : 12;
    const targets = [];
    for (let i = 2; i < process.argv.length; i++) {
        const a = process.argv[i];
        if (a === "--entries") {
            i++; // skip the value
            continue;
        }
        if (a.startsWith("--")) continue;
        targets.push(a);
    }
    for (const p of targets) {
        try {
            const { prefix, product, version, entries } = readPboFileTable(p);
            console.log(`\n=== ${p} ===`);
            console.log(`  prefix=${prefix} product=${product} version=${version} entries=${entries.length}`);
            for (let i = 0; i < Math.min(maxEntries, entries.length); i++) {
                const e = entries[i];
                console.log(`  ${e.name}  pack=${e.packing} size=${e.origSize}`);
            }
            if (entries.length > maxEntries) console.log(`  ... (${entries.length - maxEntries} more)`);
        } catch (e) {
            console.error(`  ERROR: ${e.message}`);
        }
    }
}
