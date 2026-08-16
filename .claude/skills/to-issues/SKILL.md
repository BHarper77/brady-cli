---
name: to-issues
description: Turn the decisions from a grilling session into a brief on the parent issue plus independently-grabbable sub-issues, using tracer-bullet vertical slices. Use after grilling, when the user wants the agreed plan broken into sub-issues an agent loop can pick up.
---

Take what was decided in this conversation and turn it into a brief on the parent issue plus a set of sub-issues. Do NOT interview — grilling already happened. Just synthesise what's been agreed.

The parent issue is passed as an argument (issue number or URL).

The goal: an AFK agent looping over these can pick the next unblocked sub-issue, read the parent for context, and implement it — without stale implementation detail in either place.

## Process

### 1. Gather context

Work from the decisions already in the conversation. Fetch the parent issue (body + comments) to ground yourself. Use the domain vocabulary in `CONTEXT.md` and respect any ADRs in `docs/adr/` for the area you're touching.

**Already-written spec parent** (e.g. a wayfinder handoff): when the parent is itself the spec and the conversation holds little or nothing, synthesise from the parent's body plus the resolutions/ADRs it links instead. If the body is already in the brief shape below, keep it and skip step 2.

### 2. Write the brief into the parent

Update the parent body with the synthesis below — this is the shared context every sub-issue inherits. Keep it **decision-level**: the what and the why, not the how. No file paths or code snippets — they go stale and are unneeded context. Respect existing ADRs rather than restating them.

<parent-template>
## Problem

The problem being solved, from the user's perspective.

## Solution

The agreed solution, from the user's perspective.

## User Stories

A numbered list framing the feature from the user's perspective. Each: `As a <role>, I want <capability>, so that <benefit>`. The "so that" must name a real user-visible benefit. These give sub-issues their intent and seed their acceptance criteria.

## Decisions

The decisions that came out of grilling — architecture, module boundaries, interfaces, schema/API shape, key trade-offs. Decision-level only.

## Testing

How this gets verified — the seams to test at (prefer existing, highest seam), and the kinds of tests (unit / integration / contract, per `CONTEXT.md`).

## Out of scope

What this explicitly does not cover.
</parent-template>

### 3. Draft vertical slices

Break the plan into **tracer-bullet** sub-issues. Each is a thin vertical slice cutting through ALL layers end-to-end (schema, API, UI, tests) — NOT a horizontal slice of one layer.

- Each slice delivers a narrow but COMPLETE path through every layer
- A completed slice is demoable or verifiable on its own
- Any prefactoring ("make the change easy, then make the easy change") comes first
- Prefer fewer slices; merge ones that aren't independently demoable

### 4. Confirm before publishing

Show the breakdown as a numbered list. For each slice: **title**, **blocked by** (other slices, if any), **what it delivers** (one line), **stories** covered. Call out any user story not covered by a slice. Ask whether granularity and dependencies are right. Iterate until approved.

### 5. Publish

For each approved slice, create a **native sub-issue** of the parent. Publish in dependency order so blocking can reference real issue numbers. Use the template below. Keep it thin — the parent carries the why and the decisions. Do NOT label the sub-issues.

Follow this repo's [`docs/agents/issue-tracker.md`](../../../docs/agents/issue-tracker.md) for how to create sub-issues and record blocking. If that doc is unavailable, ask the user which issue tracker to use and how to record blocking.

<issue-template>
## What to build

Concise description of this vertical slice — the end-to-end behaviour, not layer-by-layer steps. No file paths or code snippets.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Delivers

Stories <n>, <n> (references the parent's User Stories this slice satisfies).

## Blocked by

- #<n> (or "None — can start immediately")
</issue-template>

### 6. Flip the parent

Once the sub-issues exist: on the parent, remove `needs-planning` (if present — spec parents born outside the planning label flow won't have it) and add `ready-for-implementation`. Don't otherwise close it.
