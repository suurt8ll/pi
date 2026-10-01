import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "google-gemma-4-31b-it",
		name: "Gemma 4 31B",
		api: "openai-responses",
		provider: "venice",
		baseUrl: "https://api.venice.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

// Venice.ai's alpha /responses endpoint omits output_index on every event
// except response.output_item.added; delta and done events carry only item_id.

// Captured verbatim from a real tool-call turn through the LiteLLM proxy.
async function* createVeniceToolCallEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		id: "resp_venice_tool",
		object: "response",
		created_at: 1790852382,
		model: "google-gemma-4-31b-it",
		status: "in_progress",
		output: [],
		sequence_number: 0,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_iWFY9fwTP3FP",
			call_id: "chatcmpl-tool-83559977892f91c5",
			name: "bash",
			status: "in_progress",
		},
		sequence_number: 1,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.function_call_arguments.delta",
		item_id: "fc_iWFY9fwTP3FP",
		delta: '{"command": "echo hello"}',
		sequence_number: 2,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		item: {
			type: "function_call",
			id: "fc_iWFY9fwTP3FP",
			call_id: "chatcmpl-tool-83559977892f91c5",
			name: "bash",
			arguments: '{"command": "echo hello"}',
			status: "completed",
		},
		sequence_number: 3,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: {
			id: "resp_venice_tool",
			object: "response",
			created_at: 1790852382,
			model: "google-gemma-4-31b-it",
			status: "completed",
			output: [
				{
					type: "function_call",
					id: "fc_iWFY9fwTP3FP",
					call_id: "chatcmpl-tool-83559977892f91c5",
					name: "bash",
					arguments: '{"command": "echo hello"}',
					status: "completed",
				},
			],
			usage: { input_tokens: 1631, output_tokens: 18, total_tokens: 1649 },
		},
		sequence_number: 4,
	} as unknown as ResponseStreamEvent;
}

async function* createVeniceReasoningEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		id: "resp_venice_reasoning",
		object: "response",
		status: "in_progress",
		output: [],
		sequence_number: 0,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "reasoning", id: "rc_1", summary: [] },
		sequence_number: 1,
	} as unknown as ResponseStreamEvent;
	// Non-standard event type, item_id only (no output_index).
	yield {
		type: "response.reasoning.delta",
		item_id: "rc_1",
		delta: "thinking first",
		sequence_number: 2,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning.delta",
		item_id: "rc_1",
		delta: ", then answering",
		sequence_number: 3,
	} as unknown as ResponseStreamEvent;
	// Plain-string summary element instead of {type:"summary_text", text}.
	yield {
		type: "response.output_item.done",
		item: {
			type: "reasoning",
			id: "rc_1",
			summary: ["thinking first, then answering"],
		},
		sequence_number: 4,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		response: {
			id: "resp_venice_reasoning",
			object: "response",
			status: "completed",
			output: [
				{
					type: "reasoning",
					id: "rc_1",
					summary: ["thinking first, then answering"],
				},
			],
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
		},
		sequence_number: 5,
	} as unknown as ResponseStreamEvent;
}

describe("Venice /responses stream quirks", () => {
	it("routes tool call deltas and done by item_id when output_index is missing", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream: AssistantMessageEvent[] = [];
		const push = (event: AssistantMessageEvent) => stream.push(event);

		await processResponsesStream(createVeniceToolCallEvents(), output, { push } as never, model);

		expect(output.stopReason).toBe("toolUse");
		const toolCalls = output.content.filter((b) => b.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]).toMatchObject({
			id: "chatcmpl-tool-83559977892f91c5|fc_iWFY9fwTP3FP",
			arguments: { command: "echo hello" },
		});
		expect(output.responseId).toBe("resp_venice_tool");

		const types = stream.map((e) => e.type);
		expect(types).toEqual(["toolcall_start", "toolcall_delta", "toolcall_end"]);
	});

	it("captures reasoning deltas from response.reasoning.delta and string summaries", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream: AssistantMessageEvent[] = [];
		const push = (event: AssistantMessageEvent) => stream.push(event);

		await processResponsesStream(createVeniceReasoningEvents(), output, { push } as never, model);

		expect(output.stopReason).toBe("stop");
		const thinking = output.content.filter((b) => b.type === "thinking");
		expect(thinking).toHaveLength(1);
		expect(thinking[0].thinking).toBe("thinking first, then answering");
		const signature = JSON.parse(thinking[0].thinkingSignature ?? "{}");
		expect(signature.id).toBe("rc_1");

		const deltas = stream.filter((e) => e.type === "thinking_delta");
		expect(deltas.map((e) => (e as { delta: string }).delta)).toEqual(["thinking first", ", then answering"]);
		const types = stream.map((e) => e.type);
		expect(types).toEqual(["thinking_start", "thinking_delta", "thinking_delta", "thinking_end"]);
	});
});
