#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { execFileSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lgRoot = path.resolve(__dirname, "..");
const distDir = path.join(lgRoot, "dist");
const appStageDir = path.join(distDir, "app");

const manifest = JSON.parse(fs.readFileSync(path.join(lgRoot, "appinfo.json"), "utf8"));
const ipkFilename = `${manifest.id}_${manifest.version}_all.ipk`;
const ipkOutPath = path.join(distDir, ipkFilename);

function stageHostedPackage() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(appStageDir, { recursive: true });
  for (const rel of ["appinfo.json", "index.html", "icon.png", "largeIcon.png"]) {
    fs.copyFileSync(path.join(lgRoot, rel), path.join(appStageDir, rel));
  }
}

function resolveOfficialAresPackage() {
  const probe = spawnSync("which", ["ares-package"], { encoding: "utf8" });
  if (probe.status === 0 && probe.stdout.trim()) {
    return { bin: probe.stdout.trim(), prefixArgs: [], source: probe.stdout.trim() };
  }
  const npxProbe = spawnSync("npx", ["--yes", "--package=@webos-tools/cli", "ares-package", "--version"], {
    encoding: "utf8"
  });
  if (npxProbe.status === 0) {
    return {
      bin: "npx",
      prefixArgs: ["--yes", "--package=@webos-tools/cli", "ares-package"],
      source: `npx @webos-tools/cli (${npxProbe.stdout.trim()})`
    };
  }
  return null;
}

stageHostedPackage();

const ares = resolveOfficialAresPackage();
if (!ares) {
  console.error("Official LG @webos-tools/cli ares-package is required. Install with: npm install -g @webos-tools/cli");
  process.exit(1);
}

execFileSync(ares.bin, [...ares.prefixArgs, "-c", appStageDir], { stdio: "inherit" });
execFileSync(ares.bin, [...ares.prefixArgs, "-o", distDir, appStageDir], { stdio: "inherit" });
execFileSync(ares.bin, [...ares.prefixArgs, "-i", ipkOutPath], { stdio: "inherit" });

const stats = fs.statSync(ipkOutPath);
console.log(JSON.stringify({
  ok: true,
  method: ares.source,
  appId: manifest.id,
  version: manifest.version,
  main: manifest.main,
  stagedDir: appStageDir,
  ipkPath: ipkOutPath,
  sizeBytes: stats.size
}, null, 2));
