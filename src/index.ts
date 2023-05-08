#!/usr/bin/env node

import { execSync } from "child_process"
import { writeFile } from "fs/promises"
import { Command } from "commander"
import eslintConfigTemplate from "./eslintConfig.json"

const program = new Command()

program
	.command("init")
	.option("-d, --directory <directory>", "Directory name for project")
	.action(init)

program.parseAsync(process.argv)
	
async function init(opts: Options) {
	// project dir
	exec(`mkdir ${opts.directory}`)
	exec("mkdir src", opts.directory)
	exec("new-item index.ts", `${opts.directory}/src`)

	// initialise git repo
	exec("git init", opts.directory)
	exec("echo 'node_modules' 'dist' > .gitignore", opts.directory)

	// initialise Node project
	exec("npm init -y", opts.directory)

	const devDependencies = [
		"typescript", "@types/node", "@total-typescript/ts-reset", "eslint", "@bharper7/eslint-config", "@typescript-eslint/eslint-plugin", "eslint-plugin-import"
	].join(" ")
	exec(`npm i -D ${devDependencies}`, opts.directory)
	exec("tsc --init", opts.directory)

	// eslint
	await writeFile(`${opts.directory}/.eslintrc.json`, JSON.stringify(eslintConfigTemplate))
	exec("echo 'node_modules' 'dist' > .eslintignore", opts.directory)
}

function exec(command: string, cwd?: string) {
	return execSync(command, {
		cwd,
		shell: "powershell.exe"
	})
}

type Options = {
	directory: string
}