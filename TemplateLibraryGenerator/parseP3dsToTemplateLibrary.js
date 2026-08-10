import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

// Load the XML templates from files so the .tml output format is driven by
// the on-disk templates rather than hardcoded strings.
const XML_LIBRARY_TEMPLATE = readFileSync(path.join(process.cwd(), "library-template.xml"), "utf8");
const XML_BODY_TEMPLATE = readFileSync(path.join(process.cwd(), "library-entry-template.xml"), "utf8");

const colorTemplates = {
    defaultOutline: -16777216, // black
    tree: -16744448, //dark green
    bush: -8323328, // light green
    clutter: -8323328, // light green
    rocks: -8355712, // grey
    military: -65536, // red
    structures: -16777216, // black
    water: -13816321, // blue
};

const allP3ds = [];
const missingBoundsEntries = [];

const defaultBounds = {
    min: [999, 999, 999],
    max: [-999, -999, -999],
    center: [-999, -999, -999],
};

const fallbackIgnoredBoundsPathSegments = ["\\roads\\", "\\decals\\", "\\ponds\\"];

function loadConfig() {
    try {
        const raw = readFileSync(path.join(process.cwd(), "data", "config.json"), "utf8");
        return JSON.parse(raw);
    } catch (_error) {
        return {};
    }
}

function normalizeIgnoreSegment(segment) {
    if (!segment || typeof segment !== "string") return "";
    let normalized = segment.toLowerCase().trim().replaceAll("/", "\\");
    if (!normalized.startsWith("\\")) {
        normalized = `\\${normalized}`;
    }
    if (!normalized.endsWith("\\")) {
        normalized = `${normalized}\\`;
    }
    return normalized;
}

function resolveIgnoredBoundsPathSegments(config) {
    const configured = Array.isArray(config.ignoreMissingBoundsPathSegments) ? config.ignoreMissingBoundsPathSegments : [];
    const normalizedConfigured = configured.map(normalizeIgnoreSegment).filter(Boolean);
    if (normalizedConfigured.length > 0) {
        return normalizedConfigured;
    }
    return fallbackIgnoredBoundsPathSegments;
}

const config = loadConfig();
const ignoredBoundsPathSegments = resolveIgnoredBoundsPathSegments(config);

const b_IsWindows = process.platform === "win32";

function argVal(flag) {
    const i = process.argv.indexOf(flag);
    return i > -1 ? process.argv[i + 1] : null;
}

const variant = (() => {
    const v = argVal("--variant");
    if (!v) return "";
    const safe = String(v)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9+._-]/g, "-");
    return safe.length ? `_${safe}` : "";
})();

function parseP3dsForImport(filePath) {
    const data = readFileSync(filePath, "utf8");
    // console.log(JSON.parse(data));
    return JSON.parse(data);
}
function formatFilePathToTemplateName(filePath) {
    if (!b_IsWindows) {
        filePath = filePath.toLowerCase();
        filePath = filePath.replace(/\/mnt\/.*\/dayz projects\//g, "");
        filePath = filePath.split("/").join("_");
    } else {
        filePath = filePath.split("\\").join("_").replace("P:_", "").toLowerCase();
        filePath = filePath.replace("p:_", "");
    }
    return filePath;
}
function isWithinDepthLimits(filePath, depthLimit) {
    let numSubParts = 0;
    if (!b_IsWindows) {
        numSubParts = filePath.split("/").length;
    } else {
        numSubParts = filePath.split("\\").length;
    }
    return numSubParts === depthLimit;
}

function formatP3dJsonForTemplateLibrary(data) {
    const templateLibraryData = {};
    let lastKey = Object.keys(data)[0];
    let numRootParts = 0;
    let templateName = "";
    let associatedP3Ds = [];

    Object.keys(data).forEach((key) => {
        const payload = data[key];
        // console.log(`Key to format: ${key}`);
        // root level category
        if (payload.configcpp !== "") {
            if (!b_IsWindows) {
                numRootParts = key.split("/").length;
            } else {
                numRootParts = key.split("\\").length;
            }
            lastKey = key;
            // reset associated p3ds when new categories are found
            associatedP3Ds = [];
        }
        // check 1 level deep directories
        if (isWithinDepthLimits(key, numRootParts + 1)) {
            lastKey = key;
            // reset associated p3ds when new categories are found
            associatedP3Ds = [];
        }
        // blindly make a new template name from the key
        templateName = formatFilePathToTemplateName(key);
        // console.log(`Formatted Key: ${templateName}`);
        // if the current key has traces of last key inside
        if (key.indexOf(lastKey) > -1) {
            // use the last key as our template name (nesting folders)
            templateName = formatFilePathToTemplateName(lastKey);
        }
        // console.log(`Updated Formatted Key?: ${templateName}`);
        // if our helper object has this key AND items
        if (templateLibraryData[templateName] && templateLibraryData[templateName].length > 0) {
            // append
            templateLibraryData[templateName] = [...templateLibraryData[templateName], ...payload.p3ds];
        } else {
            // define
            templateLibraryData[templateName] = payload.p3ds;
        }
    });

    return templateLibraryData;
}

function removeP3DSuffix(filePath) {
    filePath = filePath.replace(".p3d", "");
    return filePath;
}
function removeStaticFilePath(filePath) {
    if (!b_IsWindows) {
        filePath = filePath.replace(/\/mnt\/.*\/dayz projects\//g, "");
    } else {
        filePath = filePath.replace("P:\\", "");
    }
    return filePath;
}
function getP3DName(filePath) {
    let parts = [];
    if (!b_IsWindows) {
        parts = filePath.split("/");
    } else {
        parts = filePath.split("\\");
    }
    return parts[parts.length - 1];
}

function getEntryPath(entry) {
    if (typeof entry === "string") {
        return entry;
    }
    if (entry && typeof entry.path === "string") {
        return entry.path;
    }
    return "";
}

function isValidBounds(bounds) {
    if (!bounds || typeof bounds !== "object") return false;
    if (!Array.isArray(bounds.min) || !Array.isArray(bounds.max)) return false;
    if (bounds.min.length !== 3 || bounds.max.length !== 3) return false;
    return bounds.min.every((v) => Number.isFinite(v)) && bounds.max.every((v) => Number.isFinite(v));
}

function normalizeBounds(bounds) {
    const b = {
        min: [...bounds.min],
        max: [...bounds.max],
        center: Array.isArray(bounds.center) && bounds.center.length === 3 ? [...bounds.center] : [0, 0, 0],
    };
    if (!Array.isArray(bounds.center) || bounds.center.length !== 3 || !bounds.center.every((v) => Number.isFinite(v))) {
        b.center = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    }
    return b;
}

function formatBoundVal(value) {
    return Number(value).toFixed(6);
}

function shouldIgnoreMissingBounds(p3dFilePath) {
    const normalized = String(p3dFilePath || "")
        .toLowerCase()
        .replaceAll("/", "\\");
    return ignoredBoundsPathSegments.some((segment) => normalized.includes(segment));
}

function getBoundsFromEntry(entry, p3dFilePath) {
    if (entry && typeof entry === "object" && isValidBounds(entry.bounds)) {
        return normalizeBounds(entry.bounds);
    }

    // Roads/decals/ponds are mostly decal/proxy/water helper assets where
    // placeholder bounds are acceptable and expected.
    if (!shouldIgnoreMissingBounds(p3dFilePath)) {
        missingBoundsEntries.push(p3dFilePath);
    }

    return defaultBounds;
}
function formateDate() {
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const rightNow = new Date();
    //   <Date>Mon Oct 28 17:56:41 2024</Date>;
    return `${weekday[rightNow.getDay()]} ${month[rightNow.getMonth()]} ${rightNow.getDate()} ${rightNow.toTimeString().split(" ")[0]} ${rightNow.getFullYear()}`;
}
function formatTemplateFill(filePath) {
    const keys = Object.keys(colorTemplates);
    for (let i = 0; i < keys.length; i++) {
        const templateCategory = keys[i];
        if (filePath.includes(templateCategory)) {
            return colorTemplates[templateCategory];
        }
    }
    return colorTemplates.bush; // default green color
}

function formatTemplateOutline(filePath) {
    return colorTemplates.defaultOutline;
}
const today = formateDate();
function buildTemplateLibraryString(templateName) {
    let copyOfXml = XML_LIBRARY_TEMPLATE;
    copyOfXml = copyOfXml.replace("{LIBRARY_NAME}", templateName);
    copyOfXml = copyOfXml.replace("{TEMPLATE_FILL}", formatTemplateFill(templateName));
    copyOfXml = copyOfXml.replace("{TEMPLATE_OUTLINE}", formatTemplateOutline(templateName));
    //   console.log(copyOfXml);
    return copyOfXml;
}
const existingP3dNames = {};

// v4 hash (sdbm-style) equivalent to the provided Python
// def: h = c + (h << 6) + (h << 16) - h, reduced to 32-bit, then cast to signed 32-bit
function getV4Hash(name) {
    let h = 0 >>> 0; // uint32 accumulator
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        // Ensure operations remain within uint32
        h = (c + ((h << 6) >>> 0) + ((h << 16) >>> 0) - h) >>> 0;
    }
    // Convert to signed 32-bit to match ctypes.c_long behavior
    return h | 0;
}
function buildTemplateLibraryBodyString(entry) {
    const p3dFilePath = getEntryPath(entry);
    let copyOfXml = XML_BODY_TEMPLATE;
    let p3DName = getP3DName(p3dFilePath);
    p3DName = removeP3DSuffix(p3DName);
    p3DName.toLowerCase();
    if (!existingP3dNames[p3DName]) {
        existingP3dNames[p3DName] = 1;
    } else {
        existingP3dNames[p3DName] += 1;
        p3DName = p3DName.concat(`_dupe_${existingP3dNames[p3DName]}`);
    }
    copyOfXml = copyOfXml.replace("{P3D_NAME_SANS_SUFFIX}", p3DName);
    const relativeFilePath = removeStaticFilePath(p3dFilePath);
    copyOfXml = copyOfXml.replace("{P3D_RELATIVE_FILE_PATH}", relativeFilePath);
    copyOfXml = copyOfXml.replace("{TIMESTAMP}", today);
    copyOfXml = copyOfXml.replace("{TEMPLATE_OUTLINE}", formatTemplateOutline(p3dFilePath));
    copyOfXml = copyOfXml.replace("{TEMPLATE_FILL}", formatTemplateFill(p3dFilePath));
    const v4Hash = getV4Hash(p3DName);
    copyOfXml = copyOfXml.replace("{P3D_HASH}", String(v4Hash));

    const bounds = getBoundsFromEntry(entry, p3dFilePath);
    copyOfXml = copyOfXml.replace("{BOUNDING_MIN_X}", formatBoundVal(bounds.min[0]));
    copyOfXml = copyOfXml.replace("{BOUNDING_MIN_Y}", formatBoundVal(bounds.min[1]));
    copyOfXml = copyOfXml.replace("{BOUNDING_MIN_Z}", formatBoundVal(bounds.min[2]));
    copyOfXml = copyOfXml.replace("{BOUNDING_MAX_X}", formatBoundVal(bounds.max[0]));
    copyOfXml = copyOfXml.replace("{BOUNDING_MAX_Y}", formatBoundVal(bounds.max[1]));
    copyOfXml = copyOfXml.replace("{BOUNDING_MAX_Z}", formatBoundVal(bounds.max[2]));
    copyOfXml = copyOfXml.replace("{BOUNDING_CENTER_X}", formatBoundVal(bounds.center[0]));
    copyOfXml = copyOfXml.replace("{BOUNDING_CENTER_Y}", formatBoundVal(bounds.center[1]));
    copyOfXml = copyOfXml.replace("{BOUNDING_CENTER_Z}", formatBoundVal(bounds.center[2]));

    //   console.log(copyOfXml);
    allP3ds.push(p3dFilePath);
    return copyOfXml;
}

// due to living software we have to ignore some bugs in real time until they are fixed
const p3dsToIgnore = ["Ice_Sea_Square_50m"];
function shouldIgnoreEntry(entry) {
    const p3dPath = getEntryPath(entry);
    return p3dsToIgnore.includes(removeP3DSuffix(getP3DName(p3dPath)));
}
// ensure uniqueness in template names
function writeTemplateLibraryOutput(libraryData) {
    let libraryTemplate;
    let libraryTemplateBody;
    Object.keys(libraryData).forEach((key) => {
        libraryTemplate = buildTemplateLibraryString(key);
        libraryTemplateBody = "";
        const templateLibrary = templateLibraryData[key];
        if (templateLibrary.length > 0) {
            templateLibrary.forEach((entry) => {
                if (!shouldIgnoreEntry(entry)) {
                    libraryTemplateBody = libraryTemplateBody.concat(buildTemplateLibraryBodyString(entry), "\n");
                }
            });
            libraryTemplateBody.trim();
            //   console.log(`${key} ${templateLibrary.length}`);
            libraryTemplate = libraryTemplate.replace("{LIBRARY_BODY}", libraryTemplateBody);
            if (!b_IsWindows) {
                writeFileSync(`${path.resolve(process.cwd())}/output/${key}.tml`, libraryTemplate, "utf8");
            } else {
                writeFileSync(`./output/${key}.tml`, libraryTemplate, "utf8");
            }
        }
    });
}

function writeAllP3dsOutput(p3ds, sortAlphabetically, fullFilePath) {
    let fileName = "aaOneOfEverything" + variant;
    if (sortAlphabetically) {
        p3ds.sort((a, b) => a.localeCompare(b));
        fileName = fileName.concat("_alphabetical");
    }

    let allValues = "";
    if (!fullFilePath) {
        p3ds.forEach((p3d) => {
            allValues = allValues
                .concat('"')
                .concat(getP3DName(getEntryPath(p3d)))
                .concat('",\n');
        });
        fileName = fileName.concat("_p3d_only");
    } else {
        p3ds.forEach((p3d) => {
            p3d = getEntryPath(p3d);
            if (!b_IsWindows) {
                p3d = p3d.replace(/\/mnt\/.*\/dayz projects\//g, "");
            } else {
                p3d = p3d.replace("p:\\", "");
                p3d = p3d.replaceAll("\\", "/");
            }
            allValues = allValues.concat(p3d).concat("\n");
        });
        fileName = fileName.concat("_full_filepath");
    }
    if (!b_IsWindows) {
        writeFileSync(`${path.resolve(process.cwd())}/output/${fileName}.txt`, allValues, "utf8");
    } else {
        writeFileSync(`./output/${fileName}.txt`, allValues, "utf8");
    }
}

function writeMissingBoundsLog() {
    if (!missingBoundsEntries.length) return;
    const uniqueMissing = [...new Set(missingBoundsEntries)].sort((a, b) => a.localeCompare(b));
    const payload = uniqueMissing.join("\n").concat("\n");
    if (!b_IsWindows) {
        writeFileSync(`${path.resolve(process.cwd())}/output/missing_bounds${variant}.log`, payload, "utf8");
    } else {
        writeFileSync(`./output/missing_bounds${variant}.log`, payload, "utf8");
    }
}

const jsonData = parseP3dsForImport(path.join("./test", "rawTemplateLibraryData.json"));
// const jsonData = parseP3dsForImport(path.join("./test", "test_minified.json"));

const templateLibraryData = formatP3dJsonForTemplateLibrary(jsonData);

writeTemplateLibraryOutput(templateLibraryData);
writeAllP3dsOutput(allP3ds, false, false);
writeAllP3dsOutput(allP3ds, true, false);
writeAllP3dsOutput(allP3ds, true, true);
writeMissingBoundsLog();
