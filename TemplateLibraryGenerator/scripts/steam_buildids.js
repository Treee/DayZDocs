#!/usr/bin/env node
import { readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const execFileP = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBlockBounds(text, startIdx) {
    const openIdx = text.indexOf("{", startIdx);
    if (openIdx === -1) return null;
    let depth = 0;
    for (let i = openIdx; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return { start: openIdx, end: i };
        }
    }
    return null;
}

function extractBuildIds(raw, branchNames) {
    const text = raw.replace(/\t/g, "  ");
    const branchesKeyIdx = text.indexOf(`"branches"`);
    if (branchesKeyIdx === -1) throw new Error(`Could not find "branches" block in steamcmd output.`);
    const branchesBounds = findBlockBounds(text, branchesKeyIdx);
    if (!branchesBounds) throw new Error(`Malformed "branches" block.`);
    const branchesBlock = text.slice(branchesBounds.start, branchesBounds.end + 1);

    const out = {};
    for (const br of branchNames) {
        const brKeyIdx = branchesBlock.indexOf(`"${br}"`);
        if (brKeyIdx === -1) {
            out[br] = 0;
            continue;
        }
        const brBounds = findBlockBounds(branchesBlock, brKeyIdx);
        if (!brBounds) {
            out[br] = 0;
            continue;
        }
        const brBlock = branchesBlock.slice(brBounds.start, brBounds.end + 1);
        const m = brBlock.match(/"buildid"\s+"?(\d+)"?/);
        out[br] = m ? Number(m[1]) : 0;
    }
    return out;
}

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

async function resolveSteamCmdPath() {
    const cli = argVal("--steamcmd");
    if (cli) return cli;
    if (process.env.STEAMCMD) return process.env.STEAMCMD;

    const candidates = [
        "steamcmd", // PATH
        "/usr/games/steamcmd",
        "/usr/bin/steamcmd",
        "Z:\\steamcmd\\steamcmd.exe",
        "C:\\steamcmd\\steamcmd.exe",
        "C:\\Program Files (x86)\\Steam\\steamcmd.exe",
        "C:\\Program Files\\Steam\\steamcmd.exe",
    ];

    for (const c of candidates) {
        try {
            await execFileP(c, ["+quit"], { windowsHide: true });
            return c;
        } catch {
            /* try next */
        }
    }
    throw new Error("steamcmd not found. Set --steamcmd <path> or STEAMCMD env var.");
}

async function main() {
    const cfgPath = resolve(__dirname, "../data/branches.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    const appId = cfg.app_id;
    const branches = cfg.branches;

    const steamcmdPath = await resolveSteamCmdPath();
    const args = ["+login", "anonymous", "+app_info_print", String(appId), "+quit"];

    let attempt = 0;
    let stdout = "";
    while (attempt < 2) {
        attempt++;
        try {
            const { stdout: so, stderr: se } = await execFileP(steamcmdPath, args, {
                maxBuffer: 20 * 1024 * 1024,
                windowsHide: true,
            });
            stdout = so || se || "";
            if (stdout) break;
        } catch (err) {
            if (attempt >= 2) throw err;
            await sleep(1500);
        }
    }

    const result = extractBuildIds(stdout, branches);
    process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch((err) => {
    console.error(`[steam_buildids.js] Error: ${err.message}`);
    process.exit(1);
});
