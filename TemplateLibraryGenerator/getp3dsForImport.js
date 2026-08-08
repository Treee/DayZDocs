import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
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
function buildFolderHierarchy(p3ds, configs) {
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
        leaf.p3ds.push(`p:\\${p3d}`);
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
 * Scan vanilla PBOs listed in data/vanilla_pbos_to_scan.json.
 * Each entry: { pbo: "plants.pbo", dir: "Addons" | "sakhal\\Addons" }
 */
function scanVanillaPbos(dayzRoot) {
    const list = loadJson("./data/vanilla_pbos_to_scan.json");
    for (const entry of list) {
        const pboPath = path.join(dayzRoot, entry.dir, entry.pbo);
        try {
            const { p3ds, configs } = scanPboForP3ds(pboPath);
            buildFolderHierarchy(p3ds, configs);
            console.log(`[vanilla] ${entry.pbo}: ${p3ds.length} p3ds, ${configs.length} configs`);
        } catch (e) {
            console.error(`[vanilla] SKIP ${entry.pbo}: ${e.message}`);
        }
    }
}

/**
 * Scan mod PBOs listed in data/mod_folders_to_scan.json.
 * Each entry is a mod folder name under workshopRoot (e.g. "@WesternZ - Test Mod").
 * PBOs are read from <workshopRoot>/<modFolder>/addons/*.pbo.
 */
function scanModPbos(workshopRoot) {
    const mods = loadJson("./data/mod_folders_to_scan.json");
    for (const modFolder of mods) {
        const addonsDir = path.join(workshopRoot, modFolder, "addons");
        let pboFiles = [];
        try {
            pboFiles = readdirSync(addonsDir).filter((f) => f.toLowerCase().endsWith(".pbo"));
        } catch (e) {
            console.error(`[modded] SKIP ${modFolder}: ${e.message}`);
            continue;
        }
        for (const pboFile of pboFiles) {
            const pboPath = path.join(addonsDir, pboFile);
            try {
                const { p3ds, configs } = scanPboForP3ds(pboPath);
                buildFolderHierarchy(p3ds, configs);
                console.log(`[modded] ${modFolder}/${pboFile}: ${p3ds.length} p3ds, ${configs.length} configs`);
            } catch (e) {
                console.error(`[modded] SKIP ${modFolder}/${pboFile}: ${e.message}`);
            }
        }
    }
}

// ---- CLI entry ----
const config = loadJson("./data/config.json");
const dayzRoot = argVal("--dayz-root") || config.dayzRoot;
const workshopRoot = argVal("--workshop-root") || config.workshopRoot;

if (hasFlag("--vanilla")) {
    scanVanillaPbos(dayzRoot);
} else if (hasFlag("--modded")) {
    scanModPbos(workshopRoot);
} else {
    // default: scan both
    scanVanillaPbos(dayzRoot);
    scanModPbos(workshopRoot);
}

writeFileSync("./test/rawTemplateLibraryData.json", JSON.stringify(foldersFound), "utf8");
console.log(`Wrote ${Object.keys(foldersFound).length} folders to ./test/rawTemplateLibraryData.json`);
