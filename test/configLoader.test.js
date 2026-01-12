const path = require("path");
const fs = require("fs");
const { loadConfig, DEFAULT_CONFIG } = require("../src/configLoader");

jest.mock("fs");

describe("configLoader", () => {
    const projectDir = "/app";

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test("returns default config when no config file exists", () => {
        fs.existsSync.mockReturnValue(false);
        const config = loadConfig(projectDir);
        expect(config).toEqual(DEFAULT_CONFIG);
    });

    test("merges user config with defaults", () => {
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue(
            JSON.stringify({
                image: "debian-12",
                syncExcludes: ["temp"]
            })
        );

        const config = loadConfig(projectDir);

        expect(config.image).toBe("debian-12");
        expect(config.syncExcludes).toEqual(["temp"]); // Should replace array, not merge contents
        expect(config.remoteProjectDir).toBe(DEFAULT_CONFIG.remoteProjectDir); // Should augment
    });

    test("throws if explicit config file is missing", () => {
        fs.existsSync.mockReturnValue(false);
        expect(() => {
            loadConfig(projectDir, "missing.json");
        }).toThrow(/Config file not found/);
    });
});
