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

// ...

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

