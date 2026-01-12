const fs = require("fs");
const path = require("path");
const { loadEnvFromPath } = require("./envLoader");
const {
  loadConfig,
  resolveConfigPath,
  resolveCredentialsPath,
  readCredentials,
  writeCredentials
} = require("./configLoader");
const { RemoteBuilder } = require("./remoteBuilder");
const { logInfo, logError } = require("./logger");
const { handleInitCommand } = require("./init");

// ... (keep usage help separate if needed, but integration is key)

function printCliHelp() {
  console.log(`
Usage: htzbuild [profile] [options]

Profiles default to "preview". The CLI syncs the current project with a Hetzner build server,
runs \`eas build --local\`, and pulls the artifact into a local \`build-output\` folder.

Options:
  -p, --profile <name>      Override the build profile (default: preview)
  -e, --env-folder <path>   Point to a directory full of env files (default: .env)
  -c, --config <path>       Use a custom htzbuild config (default: htzbuild.config.json)
  --dry-run                 Simulate the build without creating a server
  --keep-alive-on-error     Do not delete the server if the build fails
  -h, --help                Show this help message

Subcommands:
  init                      Initialize a new project with config and .env templates
  config                    Manage saved Hetzner credentials
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

function parseRunArgs(args) {
  let profile = "preview";
  let envFolder = ".env";
  let configFile;
  let dryRun = false;
  let keepAliveOnError = false;
  let usedProfile = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      printCliHelp();
      process.exit(0);
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--keep-alive-on-error") {
      keepAliveOnError = true;
      continue;
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

    // ... (rest of parsing logic, env-folder, config)

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

  return { profile, envFolder, configFile, dryRun, keepAliveOnError };
}

// ... 

async function runCli(argv) {
  const args = argv.slice(2);

  if (args[0] === "init") {
    await handleInitCommand();
    return;
  }

  if (args[0] === "config") {
    await handleConfigCommand(args.slice(1));
    return;
  }

  const { profile, envFolder, configFile, dryRun, keepAliveOnError } = parseRunArgs(args);
  const config = loadConfig(process.cwd(), configFile);

  // ... (env loading logic)
  const resolvedConfigPath = resolveConfigPath(process.cwd(), configFile);
  const { credentials, credentialsPath } = readCredentials();
  const hasSavedCredentials = Object.values(credentials).some(
    (value) => value !== undefined && value !== null && value !== ""
  );

  const envPath = path.resolve(process.cwd(), envFolder);
  let loadedEnv = {};

  if (fs.existsSync(envPath)) {
    logInfo(`Loading environment from ${envPath}`);
    loadedEnv = loadEnvFromPath(envPath);
  } else if (!hasSavedCredentials) {
    // Only throw if NOT dry run, or throw anyway? 
    // Dry run might want to skip env check? No, dry run should simulate valid build.
    // But if init wasn't run, env might not exist.
    // sticking to original logic
    throw new Error(`Env path not found: ${envPath}`);
  } else {
    logInfo(
      `Env path not found (${envPath}); using saved credentials from ${credentialsPath}`
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

  // Pass flags to builder
  const builder = new RemoteBuilder(profile, builderEnv, config, {
    dryRun,
    keepAliveOnError
  });

  try {
    await builder.run();
  } catch (error) {
    logError(error.message);
    // Don't throw if we handled it in logger, but runCli usually shouldn't crash process completely ungracefully
    process.exit(1);
  }
}
module.exports = { runCli };

