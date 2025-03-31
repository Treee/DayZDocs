import { readdirSync, writeFileSync } from "node:fs";
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

const foldersToTemplate = [
    "dz\\plants",
    "dz\\plants_bliss",
    "dz\\plants_sakhal",
    "dz\\rocks",
    "dz\\rocks_bliss",
    "dz\\rocks_sakhal",
    "dz\\structures",
    "dz\\structures_bliss",
    "dz\\structures_sakhal",
    "dz\\water",
    "dz\\water_bliss",
    "dz\\water_sakhal",
    "ALV_UN_Structures_Commercial",
    "ALV_UN_Structures_Industrial",
    "ALV_UN_Structures_Misc",
    "ALV_UN_Structures_Residential",
    "ALV_UN_Structures_Walls",
];

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
