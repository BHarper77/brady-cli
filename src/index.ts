#!/usr/bin/env node

import { execSync } from "child_process"
import { Command } from "commander"

const program = new Command()

program
	.command("init")
	.option("-d, --directory <directory>", "Directory name for project")
	.option("-g, --git", "Initialise a git repository", false)
	.action(init)

program.parse(process.argv)
	
function init(opts: Options) {
	exec(`mkdir ${opts.directory}`)
	exec("mkdir src", opts.directory)
	exec("new-item index.ts", `${opts.directory}/src`)

	if (opts.git === true) {
		exec("git init", opts.directory)
		// TODO: add multiple lines to gitignore
		exec("echo 'node_modules' > .gitignore", opts.directory)
	}

	exec("npm init -y", opts.directory)
	exec("npm i -D typescript @types/node @total-typescript/ts-reset eslint", opts.directory)
	exec("tsc --init", opts.directory)
	// TODO: init eslint and add eslint ignore
}

function exec(command: string, cwd?: string) {
	return execSync(command, {
		cwd,
		shell: "powershell.exe"
	})
}

type Options = {
	git: boolean,
	directory: string
}