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

const foldersToTemplate = ["plants", "plants_bliss", "plants_sakhal", "rocks", "rocks_bliss", "rocks_sakhal", "structures", "structures_bliss", "structures_sakhal", "water", "water_bliss", "water_sakhal"];
foldersToTemplate.forEach((folder) => {
  readdirRecursiveSync("P:\\dz", folder);
});
// console.log(foldersFound);

writeFileSync("./test/rawTemplateLibraryData.json", JSON.stringify(foldersFound), "utf8");
