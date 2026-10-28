import { fauxAssistantMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "../src/index.ts";
import { createBashTool, createEditTool, createLsTool, createReadTool, createWriteTool } from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";

/**
 * Register a wrapped built-in the way a routing extension does: the object handed to
 * registerTool() is a spread of the wrapper (`{ ...local, execute }`), and the prompt is built
 * from whatever that object carries.
 */
function reregister(pi: ExtensionAPI, tool: ToolDefinition): void {
	pi.registerTool({ ...tool, execute: tool.execute });
}

/**
 * An extension that re-registers a built-in tool under its own name (routing its execution
 * elsewhere, as `remote-tools` does) hands `registerTool()` an AgentTool. The definition the
 * prompt is built from is then that registered object, so the wrap must carry the definition's
 * `promptSnippet`/`promptGuidelines`: without them the tool keeps its declaration in the
 * request but disappears from the prompt's <tools> list and <rules> section.
 */
describe("extension re-registers built-in tools", () => {
	test("keeps their snippets in <tools> and their guidelines in <rules>", async () => {
		const reRegister: ExtensionFactory = (pi) => {
			reregister(pi, createBashTool("/workspace"));
			reregister(pi, createReadTool("/workspace"));
			reregister(pi, createWriteTool("/workspace"));
			reregister(pi, createEditTool("/workspace"));
			reregister(pi, createLsTool("/workspace"));
		};
		const harness = await createHarness({ extensionFactories: [reRegister] });
		try {
			harness.setResponses([fauxAssistantMessage("ok")]);
			await harness.session.prompt("hi");

			const system = getCurrentSystemMessage(harness.session.messages);
			expect(system?.sections).toBeDefined();
			const tools = system?.sections?.tools ?? "";
			const rules = system?.sections?.rules ?? "";

			expect(tools).toContain("- bash: Execute bash commands (ls, grep, find, etc.)");
			expect(tools).toContain("- read: Read file contents");
			expect(tools).toContain("- write: Create or overwrite files");
			expect(tools).toContain("- edit: Make precise file edits with exact text replacement");

			expect(rules).toContain("Use read to examine files instead of cat or sed.");
			expect(rules).toContain("Use write only for new files or complete rewrites.");
			expect(rules).toContain("Use edit for precise changes (edits[].oldText must match exactly)");
		} finally {
			harness.cleanup();
		}
	});
});
