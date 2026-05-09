#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const p = __importStar(require("@clack/prompts"));
const child_process_1 = require("child_process");
const commander_1 = require("commander");
const promises_1 = require("fs/promises");
const path_1 = __importDefault(require("path"));
const eslintConfig_json_1 = __importDefault(require("./eslintConfig.json"));
const DOTFILES_OWNER = "bharper77";
const DOTFILES_REPO = "dotfiles";
const SKILLS_PATH = ".agents/skills";
const program = new commander_1.Command();
program
    .command("init")
    .option("-d, --directory <directory>", "Directory name for project")
    .action(init);
const skillsCmd = new commander_1.Command("skills").description("Manage agent skills from dotfiles");
skillsCmd.addCommand(new commander_1.Command("list")
    .description("List available skills from dotfiles")
    .action(listSkills));
skillsCmd.addCommand(new commander_1.Command("add")
    .description("Download one or more skills into .agents/skills/")
    .argument("[skill]", "Skill name to download directly (omit for interactive picker)")
    .action(addSkill));
program.addCommand(skillsCmd);
program.parseAsync(process.argv);
// ---------------------------------------------------------------------------
// init command
// ---------------------------------------------------------------------------
async function init(opts) {
    // project dir
    exec(`mkdir ${opts.directory}`);
    exec("mkdir src", opts.directory);
    exec("new-item index.ts", `${opts.directory}/src`);
    // initialise git repo
    exec("git init", opts.directory);
    exec("echo 'node_modules' 'dist' > .gitignore", opts.directory);
    // initialise Node project
    exec("npm init -y", opts.directory);
    const packageJson = JSON.parse((await (0, promises_1.readFile)(`${opts.directory}/package.json`)).toString());
    packageJson.scripts = {
        start: "node src/index.js",
        build: "tsc",
    };
    await (0, promises_1.writeFile)(`${opts.directory}/package.json`, JSON.stringify(packageJson, null, 2));
    const devDependencies = [
        "typescript",
        "@types/node",
        "@total-typescript/ts-reset",
        "eslint",
        "@bharper7/eslint-config",
        "@typescript-eslint/eslint-plugin",
        "eslint-plugin-import",
    ].join(" ");
    exec(`npm i -D ${devDependencies}`, opts.directory);
    exec("tsc --init", opts.directory);
    // eslint
    await (0, promises_1.writeFile)(`${opts.directory}/.eslintrc.json`, JSON.stringify(eslintConfig_json_1.default));
    exec("echo 'node_modules' 'dist' > .eslintignore", opts.directory);
}
// ---------------------------------------------------------------------------
// skills commands
// ---------------------------------------------------------------------------
async function listSkills() {
    await ensureGhAuth();
    const entries = fetchGhJson(`repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}`);
    const skills = entries.filter((e) => e.type === "dir").map((e) => e.name);
    if (skills.length === 0) {
        console.log("No skills found.");
        return;
    }
    console.log("Available skills:");
    for (const skill of skills) {
        console.log(`  • ${skill}`);
    }
}
async function addSkill(skill) {
    await ensureGhAuth();
    if (skill) {
        await downloadSkill(skill);
    }
    else {
        const entries = fetchGhJson(`repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}`);
        const skills = entries.filter((e) => e.type === "dir").map((e) => e.name);
        if (skills.length === 0) {
            console.log("No skills available.");
            return;
        }
        p.intro("brady skills add");
        const selected = await p.multiselect({
            message: "Select skills to download (space = toggle, enter = confirm):",
            options: skills.map((s) => ({ value: s, label: s })),
            required: true,
        });
        if (p.isCancel(selected)) {
            p.cancel("Cancelled.");
            process.exit(0);
        }
        const chosen = selected;
        for (const s of chosen) {
            await downloadSkill(s);
        }
        p.outro(`Downloaded ${chosen.length} skill(s).`);
    }
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function ensureGhAuth() {
    try {
        (0, child_process_1.execSync)("gh auth status", { stdio: "pipe" });
    }
    catch {
        p.intro("GitHub authentication required");
        const answer = await p.confirm({
            message: "You are not authenticated with GitHub CLI. Run `gh auth login` now?",
        });
        if (p.isCancel(answer) || !answer) {
            console.error("Error: Not authenticated. Run `gh auth login` to authenticate, then retry.");
            process.exit(1);
        }
        const result = (0, child_process_1.spawnSync)("gh", ["auth", "login"], {
            stdio: "inherit",
            shell: "powershell.exe",
        });
        if (result.status !== 0) {
            console.error("Authentication failed. Run `gh auth login` to authenticate, then retry.");
            process.exit(1);
        }
    }
}
function fetchGhJson(apiPath) {
    const output = (0, child_process_1.execSync)(`gh api ${apiPath}`, { encoding: "utf-8" });
    return JSON.parse(output);
}
async function downloadSkill(skillName) {
    const apiPath = `repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}/${skillName}`;
    const files = fetchGhJson(apiPath);
    const destDir = path_1.default.join(process.cwd(), SKILLS_PATH, skillName);
    await (0, promises_1.mkdir)(destDir, { recursive: true });
    for (const file of files) {
        if (file.type !== "file")
            continue;
        const fileEntry = fetchGhJson(`repos/${DOTFILES_OWNER}/${DOTFILES_REPO}/contents/${SKILLS_PATH}/${skillName}/${file.name}`);
        const content = Buffer.from(fileEntry.content, "base64").toString("utf-8");
        await (0, promises_1.writeFile)(path_1.default.join(destDir, file.name), content, "utf-8");
    }
    console.log(`✓ Downloaded skill: ${skillName}`);
}
function exec(command, cwd) {
    return (0, child_process_1.execSync)(command, {
        cwd,
        shell: "powershell.exe",
    });
}
