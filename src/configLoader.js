const fs = require("fs");
const os = require("os");
const path = require("path");

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

const DEFAULT_CONFIG = {
  syncExcludes: ["node_modules", ".expo", "android", "ios", ".git", "coverage", "build-output"],
  remoteProjectDir: "/root/project",
  remoteEnvFile: "/root/build-env.sh",
  remoteLogPath: "/root/build.log",
  remoteStatusFile: "/root/build-status",
  artifactForProfile: {
    production: "/root/build-output.aab",
    default: "/root/build-output.apk"
  },
  artifactCandidates: ["/root/build-output.apk", "/root/build-output.aab"],
  envScript: [
    "export ANDROID_HOME=/opt/android-sdk",
    "export ANDROID_SDK_ROOT=/opt/android-sdk",
    "export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"
  ],
  buildCommand: "npx eas-cli build --local --platform android --profile \"$PROFILE\" --non-interactive --output $OUTPUT_FILE",
  image: "ubuntu-24.04"
};

function deepMerge(base, overrides) {
  const merged = { ...base };

  if (!overrides || typeof overrides !== "object") {
    return merged;
  }

  Object.entries(overrides).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      merged[key] = [...value];
      return;
    }

    if (isObject(value)) {
      merged[key] = deepMerge(base[key] && isObject(base[key]) ? base[key] : {}, value);
      return;
    }

    merged[key] = value;
  });

  return merged;
}

function resolveConfigPath(projectDir, configFileOption) {
  if (configFileOption && path.isAbsolute(configFileOption)) {
    return configFileOption;
  }

  if (configFileOption) {
    return path.resolve(process.cwd(), configFileOption);
  }

  return path.resolve(projectDir, "htzbuild.config.json");
}

function loadConfig(projectDir, configFileOption) {
  const configPath = resolveConfigPath(projectDir, configFileOption);
  if (!fs.existsSync(configPath)) {
    if (configFileOption) {
      throw new Error(`Config file not found: ${configPath}`);
    }

    return { ...DEFAULT_CONFIG };
  }

  const contents = fs.readFileSync(configPath, "utf8");
  const parsed = JSON.parse(contents);
  return deepMerge(DEFAULT_CONFIG, parsed);
}

function resolveCredentialsPath(credentialsFileOption) {
  if (credentialsFileOption && path.isAbsolute(credentialsFileOption)) {
    return credentialsFileOption;
  }

  if (credentialsFileOption) {
    return path.resolve(process.cwd(), credentialsFileOption);
  }

  return path.join(os.homedir(), ".config", "htzbuild", "credentials.json");
}

function readCredentials(credentialsFileOption) {
  const credentialsPath = resolveCredentialsPath(credentialsFileOption);
  if (!fs.existsSync(credentialsPath)) {
    return { credentialsPath, credentials: {} };
  }

  try {
    const contents = fs.readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(contents);
    return { credentialsPath, credentials: parsed };
  } catch (error) {
    throw new Error(`Failed to read credentials file ${credentialsPath}: ${error.message}`);
  }
}

function writeCredentials(credentialsFileOption, overrides = {}) {
  const { credentialsPath, credentials } = readCredentials(credentialsFileOption);
  const merged = { ...credentials, ...overrides };
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return credentialsPath;
}

module.exports = {
  loadConfig,
  DEFAULT_CONFIG,
  resolveConfigPath,
  resolveCredentialsPath,
  readCredentials,
  writeCredentials
};

