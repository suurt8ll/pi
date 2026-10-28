import { describe, expect, test } from "vitest";
import { bashToolSystemPromptContribution, createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditTool, createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindTool, createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createGrepTool, createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsTool, createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellTool,
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
import { createReadTool, createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import {
	createWriteTool,
	createWriteToolDefinition,
	writeToolSystemPromptContribution,
} from "../src/core/tools/write.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

const wrappedCases = [
	["read", readToolSystemPromptContribution, createReadTool],
	["bash", bashToolSystemPromptContribution, createBashTool],
	["powershell", powershellToolSystemPromptContribution, createPowerShellTool],
	["edit", editToolSystemPromptContribution, createEditTool],
	["write", writeToolSystemPromptContribution, createWriteTool],
	["grep", grepToolSystemPromptContribution, createGrepTool],
	["find", findToolSystemPromptContribution, createFindTool],
	["ls", lsToolSystemPromptContribution, createLsTool],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});

	// The wrapper is what an extension hands to registerTool() when it re-registers a built-in,
	// and the prompt is built from the registered definition: dropping the contributions here
	// would silently remove the tool from the prompt's <tools> list and <rules> section.
	test.each(wrappedCases)(
		"keeps the wrapped %s tool aligned with its contribution",
		(_name, contribution, createTool) => {
			const tool = createTool("/workspace");

			expect(tool.promptSnippet).toBe(contribution.snippet);
			expect(tool.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);
});
