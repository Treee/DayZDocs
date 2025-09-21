import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import * as path from "node:path";

const foldersToIgnore = ["data"];
const foldersFound = {};

// Function to recursively iterate folders given a root file path and a folder.
// RootFilePath - Normally P:/dz but can be any folder with p3ds and config.cpp
// Folder - The folder to recurse through. Accepts an array
function readdirRecursiveSync(rootFilePath, folder) {
    // construct the source file path
    const sourceFilePath = path.join(rootFilePath, folder);
    // read all the contents of this filepath. withFileTypes returns `dirent` which includes metadata on the file
    const directory = readdirSync(sourceFilePath, { withFileTypes: true });
    let p3dCount = 0;
    // pre-construct our object for this folder.
    foldersFound[sourceFilePath] = { count: 0, p3ds: [], configcpp: "" };
    // for each file found
    directory.forEach((dirent) => {
        // if the file is a directory
        if (dirent.isDirectory()) {
            // if the directory is not ignored
            if (!foldersToIgnore.includes(dirent.name)) {
                // send this folder into our function to find more files
                readdirRecursiveSync(sourceFilePath, dirent.name);
            }
        }
        // if the file is not a directory
        else {
            // construct the file's full path
            const filePath = path.join(sourceFilePath, dirent.name).toLowerCase();
            // if the file is a p3d
            if (dirent.name.indexOf(".p3d") > -1) {
                // increase our p3d counter (validation reasons)
                p3dCount++;
                // add the record to our list
                foldersFound[sourceFilePath].p3ds.push(filePath);
                // console.log(filePath);
            }
            // if the file is our config.cpp
            // I record this entry because in the Template Library I want to collapse single p3d folders into its parent. This will help me identify the correct parents
            else if (dirent.name === "config.cpp") {
                // add it to the list
                foldersFound[sourceFilePath].configcpp = filePath;
                // console.log(filePath);
            }
        }
    });
    // if we had any p3ds counted
    if (p3dCount > 0) {
        // modify our default count to actual
        foldersFound[sourceFilePath].count = p3dCount;
        // console.log(`${p3dCount} P3Ds in ${sourceFilePath}`);
    }
}

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

function loadFoldersToTemplate() {
    const dataDir = path.resolve("./data");
    let slugs = [];

    // 1) Explicit file list via CLI: --slug-files file1.json,file2.json
    const slugFilesCsv = argVal("--slug-files");
    if (slugFilesCsv) {
        const files = slugFilesCsv
            .split(",")
            .map((s) => s.trim())
            .filter((s) => !!s);
        for (const f of files) {
            try {
                const raw = readFileSync(path.resolve(f), "utf8");
                const arr = JSON.parse(raw);
                if (Array.isArray(arr)) {
                    slugs = slugs.concat(arr.filter((v) => typeof v === "string"));
                }
            } catch (e) {
                // ignore bad files and continue
            }
        }
    }

    // 2) If nothing loaded, auto-discover defaults in data/*_folders_to_import.json
    try {
        const candidates = readdirSync(dataDir, { withFileTypes: true })
            .filter((d) => d.isFile() && d.name.endsWith("_folders_to_import.json"))
            .map((d) => path.join(dataDir, d.name));

        if (slugs.length === 0) {
            for (const file of candidates) {
                try {
                    const raw = readFileSync(file, "utf8");
                    const arr = JSON.parse(raw);
                    if (Array.isArray(arr)) {
                        slugs = slugs.concat(arr.filter((v) => typeof v === "string"));
                    }
                } catch (e) {
                    // ignore bad files, continue
                }
            }
        }
    } catch (e) {
        // data folder missing; will fall back
    }

    // Fallback to legacy defaults if nothing found
    if (slugs.length === 0) {
        slugs = ["dz\\plants"];
    }

    // Dedupe while preserving order
    const seen = new Set();
    const deduped = [];
    for (const s of slugs) {
        const key = s.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(s);
        }
    }
    return deduped;
}

const foldersToTemplate = loadFoldersToTemplate();

const b_IsWindows = process.platform === "win32";

let rootFilepath = "P:\\";

if (!b_IsWindows) {
    const windowsUsername = "";
    rootFilepath = `/mnt/c/Users/${windowsUsername}/Documents/DayZ Projects`;
    foldersToTemplate.forEach((folderFilePath, index, theArray) => {
        theArray[index] = folderFilePath.replaceAll("\\", "/");
    });
    // if you use WSL 2 you can mount virtual file systems and just mount your p drive normally (or whatever drive you want really)
    // rootFilepath = "p";
}

foldersToTemplate.forEach((folder) => {
    readdirRecursiveSync(rootFilepath, folder);
});

writeFileSync("./test/rawTemplateLibraryData.json", JSON.stringify(foldersFound), "utf8");
