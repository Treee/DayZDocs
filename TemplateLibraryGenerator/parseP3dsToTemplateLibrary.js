import { readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

const XML_LIBRARY_TEMPLATE = `<?xml version="1.0" ?>
<Library name="{LIBRARY_NAME}" shape="rectangle" default_fill="-8323328" default_outline="-16777216" tex="0">
    {LIBRARY_BODY}
</Library>`;

const XML_BODY_TEMPLATE = `<Template>
    <Name>{P3D_NAME_SANS_SUFFIX}</Name>
    <File>{P3D_RELATIVE_FILE_PATH}</File>
    <Date>{TIMESTAMP}</Date>
    <Archive></Archive>
    <Fill>-8323328</Fill>
    <Outline>-16777216</Outline>
    <Scale>1.000000</Scale>
    <Hash>{P3D_HASH}</Hash>
    <ScaleRandMin>0.000000</ScaleRandMin>
    <ScaleRandMax>0.000000</ScaleRandMax>
    <YawRandMin>0.000000</YawRandMin>
    <YawRandMax>0.000000</YawRandMax>
    <PitchRandMin>0.000000</PitchRandMin>
    <PitchRandMax>0.000000</PitchRandMax>
    <RollRandMin>0.000000</RollRandMin>
    <RollRandMax>0.000000</RollRandMax>
    <TexLLU>0.000000</TexLLU>
    <TexLLV>0.000000</TexLLV>
    <TexURU>1.000000</TexURU>
    <TexURV>1.000000</TexURV>
    <BBRadius>-1.000000</BBRadius>
    <BBHScale>1.000000</BBHScale>
    <AutoCenter>0</AutoCenter>
    <XShift>0.000000</XShift>
    <YShift>0.000000</YShift>
    <ZShift>0.000000</ZShift>
    <Height>0.000000</Height>
    <BoundingMin X="999.000000" Y="999.000000" Z="999.000000" />
    <BoundingMax X="-999.000000" Y="-999.000000" Z="-999.000000" />
    <BoundingCenter X="-999.000000" Y="-999.000000" Z="-999.000000" />
    <Placement></Placement>
</Template>`;

function parseP3dsForImport(filePath) {
  const data = readFileSync(filePath, "utf8");
  //   console.log(JSON.parse(data));
  return JSON.parse(data);
}
function formatFilePathToTemplateName(filePath) {
  return filePath.split("\\").join("_").replace("P:_dz_", "").toLowerCase();
}
function isWithinDepthLimits(filePath, depthLimit) {
  const numSubParts = filePath.split("\\").length;
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
    // root level category
    if (payload.configcpp !== "") {
      numRootParts = key.split("\\").length;
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
    // if the current key has traces of last key inside
    if (key.indexOf(lastKey) > -1) {
      // use the last key as our template name (nesting folders)
      templateName = formatFilePathToTemplateName(lastKey);
    }
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
  filePath = filePath.replace("P:\\", "");
  return filePath;
}
function getP3DName(filePath) {
  const parts = filePath.split("\\");
  return parts[parts.length - 1];
}
function formateDate() {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const rightNow = new Date();
  //   <Date>Mon Oct 28 17:56:41 2024</Date>;
  return `${weekday[rightNow.getDay()]} ${month[rightNow.getMonth()]} ${rightNow.getDate()} ${rightNow.toTimeString().split(" ")[0]} ${rightNow.getFullYear()}`;
}
const today = formateDate();
function buildTemplateLibraryString(templateName) {
  let copyOfXml = XML_LIBRARY_TEMPLATE;
  copyOfXml = copyOfXml.replace("{LIBRARY_NAME}", templateName);
  //   console.log(copyOfXml);
  return copyOfXml;
}
const existingP3dNames = {};
let hash = 10000;
function buildTemplateLibraryBodyString(p3dFilePath) {
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
  copyOfXml = copyOfXml.replace("{P3D_HASH}", hash++);
  //   console.log(copyOfXml);
  return copyOfXml;
}

// due to living software we have to ignore some bugs in real time until they are fixed
const p3dsToIgnore = ["Ice_Sea_Square_50m"];
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
        if (!p3dsToIgnore.includes(entry)) {
          libraryTemplateBody = libraryTemplateBody.concat(buildTemplateLibraryBodyString(entry), "\n");
        }
      });
      libraryTemplateBody.trim();
      //   console.log(`${key} ${templateLibrary.length}`);
      libraryTemplate = libraryTemplate.replace("{LIBRARY_BODY}", libraryTemplateBody);
      writeFileSync(`./output/${key}.tml`, libraryTemplate, "utf8");
    }
  });
}

const jsonData = parseP3dsForImport(path.join("./test", "rawTemplateLibraryData.json"));
// const jsonData = parseP3dsForImport(path.join("./test", "test_minified.json"));

const templateLibraryData = formatP3dJsonForTemplateLibrary(jsonData);

writeTemplateLibraryOutput(templateLibraryData);
