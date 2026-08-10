import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { scanPboForP3ds } from "./scripts/readPbo.js";

const foldersFound = {};

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

function hasFlag(flag) {
    return process.argv.includes(flag);
}

function loadJson(filePath) {
    return JSON.parse(readFileSync(path.resolve(filePath), "utf8"));
}

function loadP3dBoundsForPbo(pboPath, p3ds) {
    const scriptPath = path.resolve("./scripts/extractP3dBounds.py");
    const pythonCmd = process.env.PYTHON || process.env.PYTHON_EXE || "python";
    const result = spawnSync(pythonCmd, [scriptPath, "--pbo", pboPath], {
        input: JSON.stringify(p3ds),
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });

    if (result.error) {
        console.error(`[bounds] ${path.basename(pboPath)}: ${result.error.message}`);
        return {};
    }

    if (result.status !== 0) {
        const stderr = (result.stderr || "").trim();
        const stdout = (result.stdout || "").trim();
        const details = stderr || stdout || "unknown extractor error";
        console.error(`[bounds] ${path.basename(pboPath)}: extractor failed (${details})`);
        return {};
    }

    try {
        const payload = JSON.parse(result.stdout || "{}");
        if (!payload.ok || !payload.results) {
            console.error(`[bounds] ${path.basename(pboPath)}: malformed extractor payload`);
            return {};
        }
        return payload.results;
    } catch (error) {
        console.error(`[bounds] ${path.basename(pboPath)}: invalid JSON from extractor (${error.message})`);
        return {};
    }
}

/**
 * Build the folder-key hierarchy from flat p3d/config lists.
 *
 * The downstream parse step (parseP3dsToTemplateLibrary.js) groups assets by
 * folder depth + config presence, so we reconstruct a key for EVERY directory
 * (including empty parents) exactly like the original crawler did:
 *
 *   key:   "P:\\dz\\plants\\bush"
 *   value: { count, p3ds: ["p:\\dz\\plants\\bush\\b_x.p3d"], configcpp: "p:\\dz\\plants\\bush\\config.bin" }
 *
 * @param {string[]} p3ds    - full virtual paths, lowercased, backslash separators (e.g. "dz\\plants\\bush\\b_x.p3d")
 * @param {string[]} configs - full virtual paths to config.bin files
 * @returns {Object} foldersFound
 */
function buildFolderHierarchy(p3ds, configs, boundsByPath = {}) {
    const ensureDir = (dirPath) => {
        if (!foldersFound[dirPath]) {
            foldersFound[dirPath] = { count: 0, p3ds: [], configcpp: "" };
        }
        return foldersFound[dirPath];
    };

    for (const p3d of p3ds) {
        const parts = p3d.split("\\");
        const fileName = parts.pop();
        // create all parent directories (top-down so parents precede children)
        let dirPath = "";
        for (let i = 0; i < parts.length; i++) {
            dirPath = dirPath ? `${dirPath}\\${parts[i]}` : parts[i];
            ensureDir(`P:\\${dirPath}`);
        }
        // add the p3d to its leaf directory
        const leaf = ensureDir(`P:\\${parts.join("\\")}`);
        const normalizedPath = p3d.toLowerCase();
        const boundsPayload = boundsByPath[normalizedPath] || null;
        leaf.p3ds.push({ path: `p:\\${p3d}`, bounds: boundsPayload?.bounds || null });
        leaf.count++;
    }

    for (const cfg of configs) {
        const parts = cfg.split("\\");
        parts.pop(); // remove "config.bin"
        const dirPath = `P:\\${parts.join("\\")}`;
        const dir = ensureDir(dirPath);
        dir.configcpp = `p:\\${cfg}`;
    }

    return foldersFound;
}

/**
 * Scan vanilla PBOs listed in config.vanillaPbosToScan.
 * Each entry: { pbo: "plants.pbo", dir: "Addons" | "sakhal\\Addons" }
 */
function scanVanillaPbos(dayzRoot, list) {
    for (const entry of list) {
        const pboPath = path.join(dayzRoot, entry.dir, entry.pbo);
        try {
            const { p3ds, configs } = scanPboForP3ds(pboPath);
            const boundsByPath = loadP3dBoundsForPbo(pboPath, p3ds);
            buildFolderHierarchy(p3ds, configs, boundsByPath);
            console.log(`[vanilla] ${entry.pbo}: ${p3ds.length} p3ds, ${configs.length} configs`);
        } catch (e) {
            console.error(`[vanilla] SKIP ${entry.pbo}: ${e.message}`);
        }
    }
}

/**
 * Scan mod PBOs listed in config.modPbosToScan.
 * Each entry mirrors the vanilla schema: { pbo: "name.pbo", dir: "@Mod\\addons" }
 */
function scanModPbos(workshopRoot, list) {
    for (const entry of list) {
        const pboPath = path.join(workshopRoot, entry.dir, entry.pbo);
        try {
            const { p3ds, configs } = scanPboForP3ds(pboPath);
            const boundsByPath = loadP3dBoundsForPbo(pboPath, p3ds);
            buildFolderHierarchy(p3ds, configs, boundsByPath);
            console.log(`[modded] ${entry.dir}/${entry.pbo}: ${p3ds.length} p3ds, ${configs.length} configs`);
        } catch (e) {
            console.error(`[modded] SKIP ${entry.dir}/${entry.pbo}: ${e.message}`);
        }
    }
}

// ---- CLI entry ----
const config = loadJson("./data/config.json");
const dayzRoot = argVal("--dayz-root") || config.dayzRoot;
const workshopRoot = argVal("--workshop-root") || config.workshopRoot;
const vanillaPbosToScan = Array.isArray(config.vanillaPbosToScan) ? config.vanillaPbosToScan : [];
const modPbosToScan = Array.isArray(config.modPbosToScan) ? config.modPbosToScan : [];

if (hasFlag("--vanilla")) {
    scanVanillaPbos(dayzRoot, vanillaPbosToScan);
} else if (hasFlag("--modded")) {
    scanModPbos(workshopRoot, modPbosToScan);
} else {
    // default: scan both
    scanVanillaPbos(dayzRoot, vanillaPbosToScan);
    scanModPbos(workshopRoot, modPbosToScan);
}

writeFileSync("./test/rawTemplateLibraryData.json", JSON.stringify(foldersFound), "utf8");
console.log(`Wrote ${Object.keys(foldersFound).length} folders to ./test/rawTemplateLibraryData.json`);
