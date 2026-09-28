#!/usr/bin/env node
// Builds Resin's Windows native helpers with MSVC, without node-gyp:
//   prebuilds/win32-<arch>/resin_windows_security.node  (Node-API addon)
//   prebuilds/win32-<arch>/resin-service-host.exe       (windowless service host)
//
// Usage: node packages/windows-security/scripts/build-native.mjs [--arch x64|arm64]
//
// Steps: vswhere locates Visual Studio (Build Tools) with the C++ tools for the target
// architecture, vcvarsall.bat provides the host->target toolchain environment, `lib /def`
// turns node-api-headers' node_api.def into an import library for NODE.EXE, and `cl` compiles
// and links each binary with the static CRT so nothing else has to be installed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SUPPORTED_ARCHES = new Set(["x64", "arm64"]);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeDir = path.join(packageRoot, "native");

function fail(message) {
  process.stderr.write(`build-native: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  let arch = process.arch;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--arch") {
      arch = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--arch=")) {
      arch = arg.slice("--arch=".length);
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: build-native.mjs [--arch x64|arm64]\n");
      process.exit(0);
    } else {
      fail(`unknown argument '${arg}'`);
    }
  }
  if (!SUPPORTED_ARCHES.has(arch)) {
    fail(`unsupported --arch '${arch}' (expected x64 or arm64)`);
  }
  return { arch };
}

function hostArch() {
  // os.arch() reports the Node binary's architecture; an x64 Node under ARM64 emulation still
  // runs x64 tools fine, so it is the right host for vcvarsall.
  const arch = os.arch();
  return arch === "arm64" ? "arm64" : "x64";
}

function findVisualStudio(targetArch) {
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
  if (!fs.existsSync(vswhere)) {
    fail(
      `vswhere.exe not found at ${vswhere}; install Visual Studio Build Tools with the C++ workload.`,
    );
  }
  const component =
    targetArch === "arm64"
      ? "Microsoft.VisualStudio.Component.VC.Tools.ARM64"
      : "Microsoft.VisualStudio.Component.VC.Tools.x86.x64";
  const result = spawnSync(
    vswhere,
    ["-latest", "-products", "*", "-requires", component, "-property", "installationPath", "-utf8"],
    { encoding: "utf8" },
  );
  const installation = result.stdout?.trim().split(/\r?\n/)[0];
  if (result.status !== 0 || !installation) {
    fail(`no Visual Studio installation with ${component} found (vswhere exit ${result.status}).`);
  }
  const vcvarsall = path.join(installation, "VC", "Auxiliary", "Build", "vcvarsall.bat");
  if (!fs.existsSync(vcvarsall)) fail(`vcvarsall.bat not found at ${vcvarsall}`);
  return vcvarsall;
}

function toolchainEnvironment(vcvarsall, host, target) {
  const spec = host === target ? target : `${host}_${target}`;
  const script = path.join(os.tmpdir(), `resin-vcvars-${process.pid}.cmd`);
  fs.writeFileSync(script, `@echo off\r\ncall "${vcvarsall}" ${spec} >nul || exit /b 1\r\nset\r\n`);
  try {
    const result = spawnSync("cmd.exe", ["/d", "/c", script], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) {
      fail(`vcvarsall.bat ${spec} failed:\n${result.stdout}${result.stderr}`);
    }
    const env = {};
    for (const line of result.stdout.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
    }
    if (!env.VCToolsInstallDir) fail(`vcvarsall.bat ${spec} did not set up a toolchain`);
    return env;
  } finally {
    fs.rmSync(script, { force: true });
  }
}

function run(tool, args, env, cwd) {
  const result = spawnSync(tool, args, { env, cwd, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error || result.status !== 0) {
    fail(
      `${tool} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`}):\n${output}`,
    );
  }
  if (output) process.stdout.write(`${output}\n`);
}

function nodeApiHeaders() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("node-api-headers/package.json");
  const root = path.dirname(manifest);
  const include = path.join(root, "include");
  const def = path.join(root, "def", "node_api.def");
  if (!fs.existsSync(path.join(include, "node_api.h")) || !fs.existsSync(def)) {
    fail(`node-api-headers at ${root} is missing include/node_api.h or def/node_api.def`);
  }
  return { include, def };
}

function main() {
  if (process.platform !== "win32") {
    fail("the Windows native helpers can only be built on Windows.");
  }
  const { arch } = parseArgs(process.argv.slice(2));
  const host = hostArch();
  const env = toolchainEnvironment(findVisualStudio(arch), host, arch);
  const headers = nodeApiHeaders();
  const machine = arch === "arm64" ? "ARM64" : "X64";
  const objDir = path.join(packageRoot, "build", `win32-${arch}`);
  const outDir = path.join(packageRoot, "prebuilds", `win32-${arch}`);
  fs.mkdirSync(objDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const importLib = path.join(objDir, "node_api.lib");
  run(
    "lib.exe",
    [
      "/nologo",
      `/def:${headers.def}`,
      "/name:node.exe",
      `/machine:${machine}`,
      `/out:${importLib}`,
    ],
    env,
    objDir,
  );

  const common = ["/nologo", "/O2", "/W4", "/MT", "/GS", "/guard:cf", "/DUNICODE", "/D_UNICODE"];
  const addon = path.join(outDir, "resin_windows_security.node");
  run(
    "cl.exe",
    [
      ...common,
      "/LD",
      "/DNAPI_VERSION=8",
      "/DNODE_GYP_MODULE_NAME=resin_windows_security",
      `/I${headers.include}`,
      `/Fo${objDir}\\`,
      path.join(nativeDir, "resin_windows_security.c"),
      `/Fe${addon}`,
      "/link",
      `/IMPLIB:${path.join(objDir, "resin_windows_security.lib")}`,
      "/DELAYLOAD:node.exe",
      "/GUARD:CF",
      "/DYNAMICBASE",
      "/NXCOMPAT",
      "delayimp.lib",
      importLib,
      "advapi32.lib",
    ],
    env,
    objDir,
  );
  process.stdout.write(`built ${addon}\n`);

  const hostSource = path.join(nativeDir, "resin_service_host.c");
  if (fs.existsSync(hostSource)) {
    const hostExe = path.join(outDir, "resin-service-host.exe");
    run(
      "cl.exe",
      [
        ...common,
        "/WX",
        `/Fo${objDir}\\`,
        hostSource,
        `/Fe${hostExe}`,
        "/link",
        "/SUBSYSTEM:WINDOWS",
        "/GUARD:CF",
        "/DYNAMICBASE",
        "/NXCOMPAT",
      ],
      env,
      objDir,
    );
    process.stdout.write(`built ${hostExe}\n`);
  } else {
    process.stderr.write(
      `build-native: warning: ${hostSource} does not exist yet; skipping resin-service-host.exe\n`,
    );
  }
}

main();
