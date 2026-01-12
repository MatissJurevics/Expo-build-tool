const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { logInfo, logSuccess, logWarn, logError } = require("./logger");

async function askQuestion(query) {
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

const DEFAULT_CONFIG_TEMPLATE = {
    syncExcludes: [
        "node_modules",
        ".expo",
        "android",
        "ios",
        ".git",
        "coverage",
        "build-output"
    ],
    remoteProjectDir: "/root/project",
    remoteEnvFile: "/root/build-env.sh",
    remoteLogPath: "/root/build.log",
    remoteStatusFile: "/root/build-status",
    artifactForProfile: {
        preview: "/root/build-output.apk",
        production: "/root/build-output.aab"
    },
    artifactCandidates: ["/root/build-output.apk", "/root/build-output.aab"],
    image: "ubuntu-24.04",
    buildCommand: 'npx eas-cli build --local --platform android --profile "$PROFILE" --non-interactive --output $OUTPUT_FILE'
};

async function handleInitCommand() {
    logInfo("Initializing new htzbuild project...");

    const cwd = process.cwd();
    const configPath = path.join(cwd, "htzbuild.config.json");
    const envDir = path.join(cwd, ".env");
    const gitignorePath = path.join(cwd, ".gitignore");

    // 1. Create htzbuild.config.json
    if (fs.existsSync(configPath)) {
        logWarn("htzbuild.config.json already exists. Skipping.");
    } else {
        fs.writeFileSync(
            configPath,
            JSON.stringify(DEFAULT_CONFIG_TEMPLATE, null, 2)
        );
        logSuccess("Created htzbuild.config.json");
    }

    // 2. Create .env directory and credentials
    if (!fs.existsSync(envDir)) {
        fs.mkdirSync(envDir);
        logSuccess("Created .env directory");
    }

    const credentialsPath = path.join(envDir, "credentials.env");
    if (fs.existsSync(credentialsPath)) {
        logWarn(".env/credentials.env already exists. Skipping.");
    } else {
        logInfo("Please provide your Hetzner credentials (leave empty to skip):");

        const token = await askQuestion("Hetzner API Token (HCLOUD_TOKEN): ");
        const sshKey = await askQuestion("SSH Key Name (HETZNER_SSH_KEY) [default: buildkey]: ");
        const location = await askQuestion("Location (HETZNER_LOCATION) [default: fsn1]: ");

        const content = [
            `HCLOUD_TOKEN=${token}`,
            `HETZNER_SSH_KEY=${sshKey || "buildkey"}`,
            `HETZNER_LOCATION=${location || "fsn1"}`,
            "HETZNER_SERVER_TYPE=cpx52"
        ].join("\n");

        fs.writeFileSync(credentialsPath, content);
        logSuccess("Created .env/credentials.env");
    }

    // 3. Update .gitignore
    if (fs.existsSync(gitignorePath)) {
        const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
        if (!gitignoreContent.includes(".env")) {
            fs.appendFileSync(gitignorePath, "\n# htzbuild env\n.env/\nbuild-output/\n");
            logSuccess("Added .env/ and build-output/ to .gitignore");
        }
    } else {
        logWarn("No .gitignore found. Please ensure you ignore '.env/' manually.");
    }

    logSuccess("Initialization complete! You can now run 'htzbuild'.");
}

module.exports = { handleInitCommand };
