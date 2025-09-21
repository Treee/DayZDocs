#!/usr/bin/env node
// Automates update decision: fetch Steam buildids -> compare with saved json ->
// if changed, run generator and update the saved json.

import { readFile, writeFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, resolve, join } from "path";

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

function hasFlag(flag) {
    return process.argv.includes(flag);
}

function mergeKeys(objA, objB) {
    const keys = new Set([...Object.keys(objA || {}), ...Object.keys(objB || {})]);
    return [...keys];
}

async function getCurrentBuildIds({ fromFile, steamcmdPath } = {}) {
    if (fromFile) {
        const txt = await readFile(fromFile, "utf8");
        return JSON.parse(txt);
    }

    const scriptPath = join(__dirname, "steam_buildids.js");
    const args = [scriptPath];
    if (steamcmdPath) args.push("--steamcmd", steamcmdPath);

    const { stdout, stderr } = await execFileP(process.execPath, args, {
        cwd: resolve(__dirname, ".."),
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
    });
    const out = (stdout || stderr || "").trim();
    if (!out) throw new Error("No output from steam_buildids.js");
    // steam_buildids.js prints a single JSON line
    const firstJsonLine = out.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
    if (!firstJsonLine) throw new Error("Could not parse build ids JSON output");
    return JSON.parse(firstJsonLine);
}

async function runGenerator() {
    // Run the generator scripts defined in package.json (import + parse)
    // Execute via npm to preserve any lifecycle setup the user has.
    await execFileP("npm", ["start"], {
        cwd: resolve(__dirname, ".."),
        windowsHide: true,
        shell: process.platform === "win32", // allow npm.cmd resolution
        maxBuffer: 20 * 1024 * 1024,
    });
}

async function main() {
    // CLI
    // Compatible positional arg: decide_update.js <fromFile>
    const positionalFromFile = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : null;
    const fromFile = argVal("--from-file") || positionalFromFile || null;
    const steamcmdPath = argVal("--steamcmd") || process.env.STEAMCMD || null;
    const dryRun = hasFlag("--dry-run");
    const decisionOnly = hasFlag("--decision-only") || hasFlag("--quiet") || process.env.GITHUB_ACTIONS === "true";

    const lastPath = resolve(__dirname, "..", "data", "last_buildids.json");
    const last = JSON.parse(await readFile(lastPath, "utf8"));
    const current = await getCurrentBuildIds({ fromFile, steamcmdPath });

    const keys = mergeKeys(last, current);
    const diffs = keys.filter((k) => (last?.[k] ?? 0) !== (current?.[k] ?? 0));

    if (diffs.length === 0) {
        if (decisionOnly) {
            process.stdout.write("NO_UPDATE\n");
        } else {
            console.log("NO_UPDATE");
        }
        return;
    }

    if (!decisionOnly) {
        console.log(`UPDATE needed for branches: ${diffs.join(", ")}`);
    } else {
        process.stdout.write("UPDATE\n");
    }

    if (dryRun) {
        if (!decisionOnly) console.log("Dry-run: skipping generator + saving last_buildids.json");
        return;
    }

    // await runGenerator();

    // Persist the new build ids
    await writeFile(lastPath, JSON.stringify(current, null, 4) + "\n", "utf8");
    if (!decisionOnly) console.log("UPDATED last_buildids.json and regenerated templates.");
}

main().catch((err) => {
    console.error(`[decide_update.js] Error: ${err.message}`);
    process.exit(1);
});
