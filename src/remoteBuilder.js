const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  logInfo,
  logSuccess,
  logWarn,
  logError
} = require("./logger");
const { DEFAULT_CONFIG } = require("./configLoader");
const readline = require("readline");

const DEFAULT_IMAGE = "ubuntu-24.04";
const DEFAULT_MAX_BUILD_MINUTES = 60;
const BUILD_POLL_INTERVAL_MS = 30000;

function resolveHome(filePath) {
  if (!filePath) {
    return filePath;
  }

  if (filePath.startsWith("~")) {
    return path.join(os.homedir(), filePath.slice(1));
  }

  return filePath;
}

function quoteShellArg(value) {
  if (/^[A-Za-z0-9_./=-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

class RemoteBuilder {
  constructor(profile, env, config = DEFAULT_CONFIG) {
    this.profile = profile;
    this.env = env;
    this.projectDir = process.cwd();
    this.buildOutputDir = path.join(this.projectDir, "build-output");
    this.serverName = `eas-builder-${Date.now()}`;
    this.serverType = env.HETZNER_SERVER_TYPE || "cpx52";
    this.location = env.HETZNER_LOCATION || "fsn1";
    this.image = env.HCLOUD_IMAGE || this.config.image || DEFAULT_IMAGE;
    this.maxBuildDurationMs =
      Number(env.HETZNER_MAX_BUILD_MINUTES || DEFAULT_MAX_BUILD_MINUTES) *
      60 *
      1000;
    this.cloudInitFile =
      env.CLOUD_INIT_FILE ||
      path.join(__dirname, "..", "cloud-init-builder.yaml");
    this.sshKeyFile = resolveHome(
      env.HETZNER_SSH_KEY_FILE || path.join(os.homedir(), ".ssh", "id_hetzner")
    );
    this.sshArgs = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ServerAliveInterval=60",
      "-o",
      "ServerAliveCountMax=3",
      "-i",
      this.sshKeyFile
    ];
    this.serverId = null;
    this.serverIp = null;
    this.cleanupRegistered = false;
    this.expoTokenLength = env.EXPO_TOKEN ? env.EXPO_TOKEN.length : 0;
    this.artifactName = null;

    this.config = config || DEFAULT_CONFIG;
    this.syncExcludes = this.config.syncExcludes || DEFAULT_CONFIG.syncExcludes;
    this.remoteProjectDir =
      this.config.remoteProjectDir || DEFAULT_CONFIG.remoteProjectDir;
    this.remoteEnvFile =
      this.config.remoteEnvFile || DEFAULT_CONFIG.remoteEnvFile;
    this.remoteLogPath =
      this.config.remoteLogPath || DEFAULT_CONFIG.remoteLogPath;
    this.remoteStatusFile =
      this.config.remoteStatusFile || DEFAULT_CONFIG.remoteStatusFile;
    this.artifactMapping =
      this.config.artifactForProfile || DEFAULT_CONFIG.artifactForProfile;
    this.artifactCandidates =
      this.config.artifactCandidates || DEFAULT_CONFIG.artifactCandidates;
    this.envScript = this.config.envScript || DEFAULT_CONFIG.envScript;
    this.buildCommand =
      this.config.buildCommand || DEFAULT_CONFIG.buildCommand;
  }

  get sshCommandLine() {
    const parts = ["ssh", ...this.sshArgs];
    return parts.map((part) => quoteShellArg(part)).join(" ");
  }

  runCommandSync(command, options = {}) {
    const mergedOptions = {
      env: this.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    };
    return childProcess.execSync(command, mergedOptions).toString().trim();
  }

  runSpawnSync(cmd, args, options = {}) {
    const mergedOptions = {
      env: this.env,
      encoding: "utf8",
      stdio: "inherit",
      ...options
    };
    const result = childProcess.spawnSync(cmd, args, mergedOptions);
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `Command ${cmd} ${args.join(" ")} failed with status ${result.status}`
      );
    }
    return result;
  }

  runSSHCommand(command, options = {}) {
    const { allowFailure = false, captureOutput = true } = options;
    const sshArgs = [
      ...this.sshArgs,
      `root@${this.serverIp}`,
      "bash",
      "-lc",
      command
    ];

    const spawnOptions = {
      env: this.env,
      encoding: "utf8"
    };

    if (captureOutput) {
      spawnOptions.stdio = ["ignore", "pipe", "pipe"];
    } else {
      spawnOptions.stdio = ["ignore", "inherit", "inherit"];
    }

    const result = childProcess.spawnSync("ssh", sshArgs, spawnOptions);
    if (result.status !== 0 && !allowFailure) {
      throw new Error(
        result.stderr
          ? result.stderr.toString().trim()
          : `SSH command failed with status ${result.status}`
      );
    }

    return result;
  }

  registerCleanup() {
    if (this.cleanupRegistered) {
      return;
    }

    const cleanupHandler = () => {
      if (!this.serverId) {
        return;
      }
      logWarn(`Cleaning up server ${this.serverName} (ID: ${this.serverId})...`);
      try {
        childProcess.spawnSync(
          "hcloud",
          ["server", "delete", this.serverId, "--poll-interval", "1s"],
          {
            env: this.env,
            stdio: "inherit",
            encoding: "utf8"
          }
        );
        logSuccess("Server deleted");
      } catch (error) {
        logError("Failed to delete server during cleanup");
      }
    };

    process.on("exit", cleanupHandler);
    process.on("SIGINT", () => {
      cleanupHandler();
      process.exit(1);
    });
    process.on("SIGTERM", () => {
      cleanupHandler();
      process.exit(1);
    });
    process.on("uncaughtException", (error) => {
      logError(error.message);
      cleanupHandler();
      process.exit(1);
    });

    this.cleanupRegistered = true;
  }

  async run() {
    logInfo("");
    logInfo("==========================================");
    logInfo("  Hetzner Cloud EAS Build Tool");
    logInfo("==========================================");
    logInfo(`  Profile: ${this.profile}`);
    logInfo(`  Server:  ${this.serverType} @ ${this.location}`);
    logInfo("==========================================");
    logInfo("");

    this.registerCleanup();
    this.checkPrerequisites();
    await this.createServer();
    await this.waitForServer();
    await this.syncProject();
    await this.runBuild();
    await this.monitorBuild();
    this.retrieveArtifact();

    logSuccess("Build complete!");
    logInfo(`Artifact location: ${path.join(this.buildOutputDir, this.artifactName)}`);
    logInfo("");
  }

  checkPrerequisites() {
    logInfo("Checking prerequisites...");
    this.ensureCommand("hcloud");
    this.ensureCommand("rsync");
    this.ensureCommand("ssh");
    this.ensureCommand("scp");

    if (!this.env.HCLOUD_TOKEN) {
      try {
        this.runCommandSync("hcloud context active", { stdio: "pipe" });
      } catch {
        throw new Error(
          "HCLOUD_TOKEN not set and no active hcloud context found"
        );
      }
    }

    this.ensureFile(this.cloudInitFile, "Cloud-init file");
    logSuccess("Prerequisites satisfied");
  }

  ensureCommand(commandName) {
    try {
      childProcess.execSync(`command -v ${commandName}`, {
        stdio: "ignore",
        env: this.env
      });
    } catch {
      throw new Error(`${commandName} is required but not installed`);
    }
  }

  ensureFile(filePath, label) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`${label} not found at ${filePath}`);
    }
  }

  async createServer() {
    logInfo(`Creating server: ${this.serverName} (${this.serverType} in ${this.location})...`);
    const sshKeyName = this.env.HETZNER_SSH_KEY || this.getFirstSshKey();
    if (!sshKeyName) {
      throw new Error("No SSH key found. Add one with hcloud ssh-key create");
    }

    logInfo(`Using SSH key: ${sshKeyName}`);
    const hcloudArgs = [
      "server",
      "create",
      "--name",
      this.serverName,
      "--type",
      this.serverType,
      "--image",
      this.image,
      "--location",
      this.location,
      "--ssh-key",
      sshKeyName,
      "--user-data-from-file",
      this.cloudInitFile,
      "--poll-interval",
      "1s"
    ];
    hcloudArgs.push("--output", "json");

    const hcloudResult = childProcess.spawnSync("hcloud", hcloudArgs, {
      env: this.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (hcloudResult.status !== 0) {
      const message =
        hcloudResult.stderr && hcloudResult.stderr.toString().trim();
      throw new Error(message || "Failed to create server");
    }

    const parsed = JSON.parse(hcloudResult.stdout.toString().trim());
    const createdServer = parsed.server;
    if (!createdServer) {
      throw new Error("Unable to parse server creation response");
    }

    this.serverId = String(createdServer.id);
    const publicNet = createdServer.public_net;
    if (!publicNet || !publicNet.ipv4 || !publicNet.ipv4.ip) {
      throw new Error("Unable to determine server IP address");
    }
    this.serverIp = publicNet.ipv4.ip;

    logSuccess(`Server created: ${this.serverIp} (ID: ${this.serverId})`);
  }



  async askQuestion(query) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  async ensureSshKey() {
    // 1. Check if configured via env
    if (this.env.HETZNER_SSH_KEY) {
      logInfo(`Using configured SSH key: ${this.env.HETZNER_SSH_KEY}`);
      return this.env.HETZNER_SSH_KEY;
    }

    // 2. Check if "buildkey" exists on Hetzner
    try {
      const listing = childProcess.execSync(
        "hcloud ssh-key list -o noheader -o columns=name",
        { env: this.env, encoding: "utf8" }
      );
      const keys = listing.split("\n").map((k) => k.trim()).filter(Boolean);

      if (keys.includes("buildkey")) {
        logInfo("Found existing 'buildkey' on Hetzner.");
        return "buildkey";
      }
    } catch {
      // Ignore error, assume no keys or auth failure (which createServer will catch later)
    }

    // 3. Prompt user
    logWarn("No 'buildkey' found on Hetzner and HETZNER_SSH_KEY not set.");
    const answer = await this.askQuestion(
      "Would you like to generate and upload a new SSH key named 'buildkey'? (y/N) "
    );

    if (answer.toLowerCase() !== "y") {
      throw new Error(
        "Aborted. Please create an SSH key manually or set HETZNER_SSH_KEY."
      );
    }

    // 4. Handle Local Key
    const defaultKeyPath = path.join(os.homedir(), ".ssh", "id_hetzner");
    if (!fs.existsSync(defaultKeyPath)) {
      logInfo(`Generating local key at ${defaultKeyPath}...`);
      childProcess.execSync(
        `ssh-keygen -t ed25519 -f ${defaultKeyPath} -N "" -C "htzbuild-auto-generated"`,
        { stdio: "inherit" }
      );
    }

    // 5. Upload to Hetzner
    logInfo("Uploading 'buildkey' to Hetzner...");
    childProcess.execSync(
      `hcloud ssh-key create --name buildkey --public-key-from-file ${defaultKeyPath}.pub`,
      { env: this.env, stdio: "inherit" }
    );

    // Update the instance's key file path if we just generated the default one
    this.sshKeyFile = defaultKeyPath;

    return "buildkey";
  }

  async createServer() {
    const sshKeyName = await this.ensureSshKey();

    logInfo(`Creating server: ${this.serverName} (${this.serverType} in ${this.location})...`);
    logInfo(`Using SSH key: ${sshKeyName}`);

    const hcloudArgs = [
      "server",
      "create",
      "--name",
      this.serverName,
      "--type",
      this.serverType,
      "--image",
      this.image,
      "--location",
      this.location,
      "--ssh-key",
      sshKeyName,
      "--user-data-from-file",
      this.cloudInitFile,
      "--poll-interval",
      "1s"
    ];
    hcloudArgs.push("--output", "json");

    const hcloudResult = childProcess.spawnSync("hcloud", hcloudArgs, {
      env: this.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    if (hcloudResult.status !== 0) {
      const message =
        hcloudResult.stderr && hcloudResult.stderr.toString().trim();
      throw new Error(message || "Failed to create server");
    }

    const parsed = JSON.parse(hcloudResult.stdout.toString().trim());
    const createdServer = parsed.server;
    if (!createdServer) {
      throw new Error("Unable to parse server creation response");
    }

    this.serverId = String(createdServer.id);
    const publicNet = createdServer.public_net;
    if (!publicNet || !publicNet.ipv4 || !publicNet.ipv4.ip) {
      throw new Error("Unable to determine server IP address");
    }
    this.serverIp = publicNet.ipv4.ip;

    logSuccess(`Server created: ${this.serverIp} (ID: ${this.serverId})`);
  }

  getFirstSshKey() {
    // Deprecated but kept for now if needed, though unused by new logic
    try {
      const listing = childProcess.execSync(
        "hcloud ssh-key list -o noheader -o columns=name",
        { env: this.env, encoding: "utf8" }
      );
      return listing.split("\n")[0].trim() || null;
    } catch {
      return null;
    }
  }

  async waitForServer() {
    logInfo("Waiting for SSH access...");
    const maxAttempts = 60;
    let attempt = 0;

    while (attempt < maxAttempts) {
      const result = this.runSSHCommand("echo ready", { allowFailure: true });
      if (result.status === 0) {
        break;
      }
      attempt += 1;
      process.stdout.write(".");
      await this.delay(5000);
    }
    process.stdout.write("\n");

    if (attempt === maxAttempts) {
      throw new Error("Timeout waiting for SSH access");
    }

    logInfo("Waiting for cloud-init to finish...");
    this.runSSHCommand("cloud-init status --wait");
    logInfo("Waiting for apt locks...");
    this.runSSHCommand(
      "while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do echo 'Waiting for apt lock...'; sleep 5; done"
    );

    logSuccess("Server is ready");
  }

  async syncProject() {
    logInfo("Syncing project files to server...");
    const remoteDir = `${this.remoteProjectDir.replace(/\/$/, "")}/`;
    const rsyncArgs = [
      "-avz",
      "--progress",
      ...this.syncExcludes.flatMap((value) => ["--exclude", value]),
      "-e",
      this.sshCommandLine,
      `${this.projectDir}/`,
      `root@${this.serverIp}:${remoteDir}`
    ];

    this.runSpawnSync("rsync", rsyncArgs, { stdio: "inherit" });
    logSuccess("Project synced");
  }

  async runBuild() {
    logInfo(
      `Running eas build --local --platform android --profile ${this.profile}...`
    );
    logInfo("This may take 10-20 minutes...");

    const expoTokenBase64 = this.env.EXPO_TOKEN
      ? Buffer.from(this.env.EXPO_TOKEN, "utf8").toString("base64")
      : null;

    const outputTemplate =
      this.artifactMapping[this.profile] || this.artifactMapping.default;
    if (!outputTemplate) {
      throw new Error("No artifact path defined for this profile");
    }

    const remoteOutputPath = this.interpolateTemplate(outputTemplate);
    const outputFileAssignment = `OUTPUT_FILE=${quoteShellArg(remoteOutputPath)}`;
    const logPath = this.remoteLogPath;
    const envFile = this.remoteEnvFile;
    const statusFile = this.remoteStatusFile;
    const envFileArg = quoteShellArg(envFile);
    const logPathArg = quoteShellArg(logPath);
    const statusFileArg = quoteShellArg(statusFile);

    const scriptLines = [
      `shutdown -h +${Math.ceil(this.maxBuildDurationMs / 60000) + 10} >/dev/null 2>&1`, // Safety net
      "set -e",
      "",
      `cat <<'ENVFILE' > ${envFileArg}`,
      ...this.envScript,
      "ENVFILE",
      ""
    ];

    if (expoTokenBase64) {
      scriptLines.push(
        `echo "Adding EXPO_TOKEN: YES (${this.expoTokenLength} chars)"`,
        `echo "export EXPO_TOKEN=$(printf '%s' '${expoTokenBase64}' | base64 -d)" >> ${envFile}`
      );
    } else {
      scriptLines.push(
        'echo "Adding EXPO_TOKEN: NO"',
        "# EXPO_TOKEN not provided"
      );
    }

    scriptLines.push(
      `echo "export PROFILE=${quoteShellArg(this.profile)}" >> ${envFileArg}`,
      `cd ${quoteShellArg(this.remoteProjectDir)}`,
      `git config --global --add safe.directory ${quoteShellArg(this.remoteProjectDir)}`,
      'git config --global user.email "build@localhost"',
      'git config --global user.name "EAS Builder"',
      "git init -q",
      "git add -A",
      'git commit -m "Build commit" -q',
      "",
      "nohup bash -c '",
      `  source ${envFileArg}`,
      "  echo \"EXPO_TOKEN in subshell: ${EXPO_TOKEN:+SET}${EXPO_TOKEN:-NOT SET}\"",
      "  echo \"PROFILE in subshell: $PROFILE\"",
      "  set -e",
      "  echo \"Installing npm dependencies...\"",
      "  npm install",
      "  echo \"Running EAS build...\"",
      `  ${outputFileAssignment}`,
      `  ${this.buildCommand}`,
      `  echo "BUILD_COMPLETE" > ${statusFileArg}`,
      `' > ${logPathArg} 2>&1 &`,
      "echo \"Build started in background\""
    );

    const script = scriptLines.join("\n");
    this.runSSHCommand(script, { captureOutput: false });
  }

  async monitorBuild() {
    logInfo("Monitoring build progress...");
    const startedAt = Date.now();

    // Start streaming logs in the background
    const tailArgs = [
      ...this.sshArgs,
      `root@${this.serverIp}`,
      "tail",
      "-f",
      "-n",
      "+1",
      this.remoteLogPath
    ];

    const tailProcess = childProcess.spawn("ssh", tailArgs, {
      env: this.env,
      stdio: ["ignore", "inherit", "ignore"] // Stream stdout directly to user
    });

    try {
      while (true) {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > this.maxBuildDurationMs) {
          logError(
            `Build timed out after ${Math.round(elapsedMs / 60000)} minutes; stopping remote processes`
          );
          this.runSSHCommand(
            "pkill -f 'eas-cli build' || true; pkill -f 'gradlew' || true; pkill -f 'npm install' || true",
            { allowFailure: true }
          );
          throw new Error("Remote build timed out");
        }

        // Check for completion marker
        const statusResult = this.runSSHCommand(
          `test -f ${quoteShellArg(this.remoteStatusFile)}`,
          { allowFailure: true }
        );

        if (statusResult.status === 0) {
          logSuccess("Build completed");
          break;
        }

        // Check if processes are still alive
        const processes = this.runSSHCommand(
          "pgrep -f 'eas-cli build' >/dev/null || pgrep -f 'npm install' >/dev/null || pgrep -f 'gradlew' >/dev/null",
          { allowFailure: true }
        );

        if (processes.status !== 0) {
          // Double check for artifact just in case of race condition
          let artifactCheck = false;
          for (const candidate of this.artifactCandidates) {
            const remoteCandidate = this.interpolateTemplate(candidate);
            const candidateResult = this.runSSHCommand(
              `test -f ${quoteShellArg(remoteCandidate)}`,
              { allowFailure: true }
            );
            if (candidateResult.status === 0) {
              artifactCheck = true;
              break;
            }
          }

          if (artifactCheck) {
            logSuccess("Build completed");
            break;
          }

          logError("Build process died unexpectedly.");
          throw new Error("Remote build failed");
        }

        // Poll status every 5 seconds
        await this.delay(5000);
      }
    } finally {
      // Clean up the tail process
      tailProcess.kill();
    }
  }

  retrieveArtifact() {
    logInfo("Retrieving build artifact...");
    fs.mkdirSync(this.buildOutputDir, { recursive: true });

    for (const candidate of this.artifactCandidates) {
      const remoteCandidate = this.interpolateTemplate(candidate);
      const artifactCheck = this.runSSHCommand(
        `test -f ${quoteShellArg(remoteCandidate)}`,
        { allowFailure: true }
      );

      if (artifactCheck.status === 0) {
        const extension = path.extname(remoteCandidate);
        this.artifactName = `build-${this.timestamp()}${extension}`;
        this.copyArtifact(remoteCandidate, this.artifactName);
        return;
      }
    }

    throw new Error("No build artifact was found on the remote server");
  }

  copyArtifact(remotePath, localName) {
    const localPath = path.join(this.buildOutputDir, localName);
    const scpArgs = [
      ...this.sshArgs,
      `root@${this.serverIp}:${remotePath}`,
      localPath
    ];

    this.runSpawnSync("scp", scpArgs, { stdio: "inherit" });
    logSuccess(`Artifact saved: ${localPath}`);
  }

  interpolateTemplate(template) {
    if (typeof template !== "string") {
      return template;
    }

    return template
      .replace(/\${PROFILE}/g, this.profile)
      .replace(/\${REMOTE_PROJECT_DIR}/g, this.remoteProjectDir)
      .replace(/\${REMOTE_ENV_FILE}/g, this.remoteEnvFile)
      .replace(/\${REMOTE_LOG_PATH}/g, this.remoteLogPath)
      .replace(/\${REMOTE_STATUS_FILE}/g, this.remoteStatusFile);
  }

  timestamp() {
    return new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "-")
      .split("Z")[0];
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { RemoteBuilder };

