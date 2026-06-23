import { readFile, writeFile } from "fs/promises";
import { exec } from "../shell";

type InitOptions = {
  directory: string;
};

export async function init(opts: InitOptions) {
  // project dir
  exec(`mkdir ${opts.directory}`);
  exec("mkdir src", opts.directory);
  exec("new-item index.ts", `${opts.directory}/src`);

  // initialise git repo
  exec("git init", opts.directory);
  exec("echo 'node_modules' 'dist' > .gitignore", opts.directory);

  // initialise Node project
  exec("npm init -y", opts.directory);

  const packageJson = JSON.parse(
    (await readFile(`${opts.directory}/package.json`)).toString(),
  );
  packageJson.scripts = {
    start: "node src/index.js",
    build: "tsc",
  };

  await writeFile(
    `${opts.directory}/package.json`,
    JSON.stringify(packageJson, null, 2),
  );

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

  exec("echo 'node_modules' 'dist' > .eslintignore", opts.directory);
}
