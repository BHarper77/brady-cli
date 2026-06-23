#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init";
import { ralph } from "./commands/ralph";
import { addSkill, listSkills, pushSkill } from "./commands/skills";

const program = new Command();

program
  .command("init")
  .option("-d, --directory <directory>", "Directory name for project")
  .action(init);

const skillsCmd = new Command("skills").description(
  "Manage agent skills from dotfiles",
);

skillsCmd.addCommand(
  new Command("list")
    .description("List available skills from dotfiles")
    .action(listSkills),
);

skillsCmd.addCommand(
  new Command("add")
    .description("Download one or more skills into a chosen local skills directory")
    .argument(
      "[skill]",
      "Skill name to download directly (omit for interactive picker)",
    )
    .action(addSkill),
);

skillsCmd.addCommand(
  new Command("push")
    .description("Push a local skill back to the dotfiles repo")
    .argument("<skill>", "Skill name to push")
    .option("--pr", "Create a pull request instead of pushing directly to main")
    .action(pushSkill),
);

program.addCommand(skillsCmd);

program
  .command("ralph")
  .description(
    "Autonomously work a parent issue's sub-issues with a fresh claude -p per iteration",
  )
  .argument("<issue>", "Parent issue number")
  .option("--max-iterations <n>", "Maximum loop iterations", "20")
  .option("-b, --branch <name>", "Use this exact branch name (skip the namer)")
  .option("--budget <usd>", "Optional cost ceiling in USD (off by default)")
  .action(ralph);

program.parseAsync(process.argv);
