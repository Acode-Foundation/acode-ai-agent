import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const licenseFile = path.join(__dirname, "LICENSE");
const pluginJSON = path.join(__dirname, "plugin.json");
const distFolder = path.join(__dirname, "dist");
const json = JSON.parse(fs.readFileSync(pluginJSON, "utf8"));
const iconName = json.icon || "icon.png";
const iconFile = path.join(__dirname, iconName);
const readmeDotMd = resolveMetadataFile(json.readme, ["readme.md", "README.md"]);
const changelogDotMd = resolveMetadataFile(json.changelogs, [
  "changelogs.md",
  "changelog.md",
  "CHANGELOG.md",
]);

const zip = new JSZip();

zip.file(iconName, fs.readFileSync(iconFile));
zip.file("plugin.json", fs.readFileSync(pluginJSON));

if (fs.existsSync(licenseFile)) {
  zip.file("LICENSE", fs.readFileSync(licenseFile));
}

if (readmeDotMd) {
  zip.file(json.readme || path.basename(readmeDotMd), fs.readFileSync(readmeDotMd));
}

if (changelogDotMd) {
  zip.file(
    json.changelogs || path.basename(changelogDotMd),
    fs.readFileSync(changelogDotMd),
  );
}

loadFile("", distFolder);

zip
  .generateNodeStream({ type: "nodebuffer", streamFiles: true })
  .pipe(fs.createWriteStream(path.join(__dirname, "plugin.zip")))
  .on("finish", () => {
    console.log("Plugin plugin.zip written.");
  });

function loadFile(root, folder) {
  const distFiles = fs.readdirSync(folder);
  distFiles.forEach((file) => {
    const stat = fs.statSync(path.join(folder, file));

    if (stat.isDirectory()) {
      zip.folder(file);
      loadFile(path.join(root, file), path.join(folder, file));
      return;
    }

    if (!/LICENSE.txt/.test(file)) {
      zip.file(path.join(root, file), fs.readFileSync(path.join(folder, file)));
    }
  });
}

function resolveMetadataFile(configuredPath, fallbacks) {
  if (configuredPath) {
    const file = path.join(__dirname, configuredPath);
    if (!fs.existsSync(file)) {
      throw new Error(`Missing plugin metadata file: ${configuredPath}`);
    }
    return file;
  }

  for (const fallback of fallbacks) {
    const file = path.join(__dirname, fallback);
    if (fs.existsSync(file)) return file;
  }
  return null;
}
