const fs = require("fs");
const path = require("path");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }

  const equalsIndex = trimmed.indexOf("=");
  if (equalsIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1);
    value = value.replace(/\\"/g, '"').replace(/\\n/g, "\n");
  } else if (value.startsWith("'") && value.endsWith("'")) {
    value = value.slice(1, -1);
  }

  return key && value !== undefined ? { key, value } : null;
}

function loadEnvFromFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Env file not found: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Env path is not a file: ${resolvedPath}`);
  }

  const result = {};
  const contents = fs.readFileSync(resolvedPath, "utf8");
  contents.split(/\r?\n/).forEach((line) => {
    const parsed = parseEnvLine(line);
    if (parsed) {
      result[parsed.key] = parsed.value;
    }
  });

  return result;
}

function loadEnvFromFolder(folderPath) {
  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Env folder not found: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Env path is not a directory: ${resolvedPath}`);
  }

  const result = {};
  const entries = fs
    .readdirSync(resolvedPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .sort((a, b) => a.name.localeCompare(b.name));

  entries.forEach((entry) => {
    const contents = fs.readFileSync(path.join(resolvedPath, entry.name), "utf8");
    contents.split(/\r?\n/).forEach((line) => {
      const parsed = parseEnvLine(line);
      if (parsed) {
        result[parsed.key] = parsed.value;
      }
    });
  });

  return result;
}

function loadEnvFromPath(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Env path not found: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.isDirectory()) {
    return loadEnvFromFolder(resolvedPath);
  }
  if (stats.isFile()) {
    return loadEnvFromFile(resolvedPath);
  }

  throw new Error(`Env path is neither file nor directory: ${resolvedPath}`);
}

module.exports = { loadEnvFromFolder, loadEnvFromFile, loadEnvFromPath };

