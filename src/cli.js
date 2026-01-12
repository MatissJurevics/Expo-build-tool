const fs = require("fs");
const path = require("path");
const { loadEnvFromFolder } = require("./envLoader");
const {
  loadConfig,
  resolveConfigPath,
  resolveCredentialsPath,
  readCredentials,
  writeCredentials
} = require("./configLoader");
const { RemoteBuilder } = require("./remoteBuilder");
const { logInfo, logError } = require("./logger");

function printCliHelp() {
  console.log(`
Usage: htzbuild [profile] [options]

Profiles default to "preview". The CLI syncs the current project with a Hetzner build server,
runs \`eas build --local\`, and pulls the artifact into a local \`build-output\` folder.

Options:
  -p, --profile <name>      Override the build profile (default: preview)
  -e, --env-folder <path>   Point to a directory full of env files (default: .env)
  -c, --config <path>       Use a custom htzbuild config (default: htzbuild.config.json)
  -h, --help                Show this help message

Subcommands:
  config                    Manage saved Hetzner credentials (run \`htzbuild config --help\`)
`);
}

function printConfigHelp() {
  console.log(`
Usage: htzbuild config [options]

Options:
  --config <path>       Save credentials to a custom config file (default: ~/.config/htzbuild/credentials.json)
  --credentials-file <path> Save credentials to a custom config file
  --token <value>       Hetzner API token (HCLOUD_TOKEN)
  --ssh-key <value>     Hetzner SSH key name
  --location <value>    Hetzner location (HETZNER_LOCATION)
  --server-type <value> Hetzner server type (HETZNER_SERVER_TYPE)
  -h, --help            Show this help message

At least one credential flag is required. Saved credentials override matching values from the .env folder.
`);
}

function parseRunArgs(args) {
  let profile = "preview";
  let envFolder = ".env";
  let usedProfile = false;

  let configFile;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      printCliHelp();
      process.exit(0);
    }

    if (arg === "--profile" || arg === "-p") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        profile = value;
        usedProfile = true;
        index += 1;
        continue;
      }
      throw new Error(`Missing profile after ${arg}`);
    }

    if (arg === "--env-folder" || arg === "-e") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        envFolder = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing env folder after ${arg}`);
    }

    if (arg === "--config" || arg === "-c") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        configFile = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing config file after ${arg}`);
    }

    if (!usedProfile && !arg.startsWith("-")) {
      profile = arg;
      usedProfile = true;
    }
  }

  return { profile, envFolder, configFile };
}

function parseConfigCommandArgs(args) {
  const options = {
    help: false,
    credentialsFile: null,
    token: null,
    sshKey: null,
    location: null,
    serverType: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (
      arg === "--config" ||
      arg === "-c" ||
      arg === "--credentials-file" ||
      arg === "--credentials-path"
    ) {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.credentialsFile = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing config file after ${arg}`);
    }

    if (arg === "--token") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.token = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing token after ${arg}`);
    }

    if (arg === "--ssh-key") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.sshKey = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing ssh key name after ${arg}`);
    }

    if (arg === "--location") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.location = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing location after ${arg}`);
    }

    if (arg === "--server-type") {
      const value = args[index + 1];
      if (value && !value.startsWith("-")) {
        options.serverType = value;
        index += 1;
        continue;
      }
      throw new Error(`Missing server type after ${arg}`);
    }

    throw new Error(`Unknown config option: ${arg}`);
  }

  return options;
}

async function handleConfigCommand(args) {
  const options = parseConfigCommandArgs(args);
  if (options.help) {
    printConfigHelp();
    return;
  }

  const credentials = {};
  if (options.token) {
    credentials.HCLOUD_TOKEN = options.token;
  }
  if (options.sshKey) {
    credentials.HETZNER_SSH_KEY = options.sshKey;
  }
  if (options.location) {
    credentials.HETZNER_LOCATION = options.location;
  }
  if (options.serverType) {
    credentials.HETZNER_SERVER_TYPE = options.serverType;
  }

  if (!Object.keys(credentials).length) {
    throw new Error(
      "Provide at least one credential flag (--token, --ssh-key, --location, --server-type)."
    );
  }

  const resolvedTarget = resolveCredentialsPath(options.credentialsFile);
  const projectRoot = path.resolve(process.cwd());
  if (
    resolvedTarget === projectRoot ||
    resolvedTarget.startsWith(`${projectRoot}${path.sep}`)
  ) {
    throw new Error(
      "Credentials must be saved outside the project directory to avoid leaking secrets."
    );
  }

  const savedPath = writeCredentials(options.credentialsFile, credentials);
  logInfo(`Saved Hetzner credentials to ${savedPath}`);
  logInfo("Subsequent runs will use these credentials instead of the .env folder.");
}

async function runCli(argv) {
  const args = argv.slice(2);
  if (args[0] === "config") {
    await handleConfigCommand(args.slice(1));
    return;
  }

  const { profile, envFolder, configFile } = parseRunArgs(args);
  const config = loadConfig(process.cwd(), configFile);
  const resolvedConfigPath = resolveConfigPath(process.cwd(), configFile);
  const { credentials, credentialsPath } = readCredentials();
  const hasSavedCredentials = Object.values(credentials).some(
    (value) => value !== undefined && value !== null && value !== ""
  );

  const envDirectory = path.resolve(process.cwd(), envFolder);

  let loadedEnv = {};
  const envDirExists =
    fs.existsSync(envDirectory) && fs.statSync(envDirectory).isDirectory();

  if (envDirExists) {
    logInfo(`Loading environment from ${envDirectory}`);
    loadedEnv = loadEnvFromFolder(envDirectory);
  } else if (!hasSavedCredentials) {
    throw new Error(`Env folder not found: ${envDirectory}`);
  } else {
    logInfo(
      `Env folder not found (${envDirectory}); using saved credentials from ${credentialsPath}`
    );
  }

  Object.entries(loadedEnv).forEach(([key, value]) => {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });

  const builderEnv = { ...process.env };
  if (hasSavedCredentials) {
    Object.entries(credentials).forEach(([key, value]) => {
      builderEnv[key] = value;
    });
  }

  const builder = new RemoteBuilder(profile, builderEnv, config);

  try {
    await builder.run();
  } catch (error) {
    logError(error.message);
    throw error;
  }
}

module.exports = { runCli };

