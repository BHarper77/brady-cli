#!/usr/bin/env node

import { Command } from "commander";
import { init } from "./commands/init";
import { ralph } from "./commands/ralph";
import { ralphReview } from "./commands/ralph-review";
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
  .option(
    "--ci-max-iterations <n>",
    "Maximum post-ralph CI fix attempts",
    "10",
  )
  .option("--no-ci", "Skip the post-ralph CI watch/fix step")
  .option("--no-review", "Skip the post-ralph automated-review triage/fix step")
  .option(
    "--review-max-rounds <n>",
    "Maximum push → review → fix rounds",
    "1",
  )
  .option(
    "--review-workflow <file>",
    "Workflow file that posts the automated review",
    "claude-code-review.yml",
  )
  .option("-b, --branch <name>", "Use this exact branch name (skip the namer)")
  .option("--budget <usd>", "Optional cost ceiling in USD (off by default)")
  .option(
    "--stacked",
    "Open one draft PR per iteration, layered on the last, instead of a single PR (requires the gh-stack extension)",
  )
  .action(ralph);

program
  .command("ralph-review")
  .description(
    "Triage an existing PR's automated review against a parent issue, then fix what survives triage",
  )
  .argument("<issue>", "Parent issue the comments are judged against")
  .option("--dry-run", "Report triage verdicts and stop — no replies, no code changes")
  .option("--max-rounds <n>", "Maximum review → fix → push rounds", "1")
  .option(
    "--workflow <file>",
    "Workflow file that posts the automated review",
    "claude-code-review.yml",
  )
  .option("--ci-max-iterations <n>", "Maximum CI fix attempts per round", "10")
  .option("-b, --branch <name>", "Branch to review (defaults to the current one)")
  .option("--budget <usd>", "Optional cost ceiling in USD (off by default)")
  .option("--stacked", "Not supported — ralph-review is always single-PR")
  .action(ralphReview);

program.parseAsync(process.argv);
