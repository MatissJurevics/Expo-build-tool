const fs = require("fs");
const path = require("path");
const { loadEnvFromFile, loadEnvFromFolder } = require("../src/envLoader");

jest.mock("fs");

describe("envLoader", () => {
    describe("loadEnvFromFile", () => {
        test("parses KEY=VALUE pairs", () => {
            fs.existsSync.mockReturnValue(true);
            fs.statSync.mockReturnValue({ isFile: () => true });
            fs.readFileSync.mockReturnValue("FOO=bar\nBAZ=qux");

            const env = loadEnvFromFile("test.env");
            expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
        });

        test("handles quotes and newlines", () => {
            fs.existsSync.mockReturnValue(true);
            fs.statSync.mockReturnValue({ isFile: () => true });
            fs.readFileSync.mockReturnValue('MULTILINE="Line1\\nLine2"\nQUOTED=\'Single\'');

            const env = loadEnvFromFile("complex.env");
            expect(env).toEqual({
                MULTILINE: "Line1\nLine2",
                QUOTED: "Single"
            });
        });

        test("ignores comments and empty lines", () => {
            fs.existsSync.mockReturnValue(true);
            fs.statSync.mockReturnValue({ isFile: () => true });
            fs.readFileSync.mockReturnValue("# Comment\n\n\nVALID=true");

            const env = loadEnvFromFile("comment.env");
            expect(env).toEqual({ VALID: "true" });
        });
    });

    describe("loadEnvFromFolder", () => {
        test("merges multiple files alphabetically", () => {
            fs.existsSync.mockReturnValue(true);
            fs.statSync.mockReturnValue({ IsDirectory: () => true, isDirectory: () => true });
            fs.readdirSync.mockReturnValue([
                { name: "a.env", isFile: () => true },
                { name: "b.env", isFile: () => true }
            ]);

            fs.readFileSync.mockImplementation((filepath) => {
                if (filepath.endsWith("a.env")) return "A=1";
                if (filepath.endsWith("b.env")) return "A=2\nB=3";
                return "";
            });

            const env = loadEnvFromFolder(".env");
            // b.env (A=2) comes later, so it should overwrite A=1
            expect(env).toEqual({ A: "2", B: "3" });
        });
    });
});
