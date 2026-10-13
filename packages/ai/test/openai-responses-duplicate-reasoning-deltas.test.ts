import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "nano-gpt-glm-5.3-flash",
		name: "GLM 5.3 Flash",
		api: "openai-responses",
		provider: "litellm",
		baseUrl: "https://litellm.example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
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

// The LiteLLM proxy's chat-to-/responses bridge emits each reasoning_content
// chunk as BOTH response.reasoning_summary_text.delta and
// response.reasoning_text.delta with identical text (captured verbatim from a
// real nano-gpt-glm-5.3-flash turn through the proxy, see sequence numbers).

async function* createSummaryFirstEvents(): AsyncIterable<ResponseStreamEvent> {
	yield { type: "response.created", sequence_number: 0 } as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "reasoning", id: "rs_1", status: "in_progress", summary: [] },
		sequence_number: 1,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 0,
		delta: "Simple",
		sequence_number: 2,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		item_id: "rs_1",
		output_index: 0,
		content_index: 0,
		delta: "Simple",
		sequence_number: 3,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_1",
		output_index: 0,
		summary_index: 0,
		delta: " question, answer: 3",
		sequence_number: 4,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		item_id: "rs_1",
		output_index: 0,
		content_index: 0,
		delta: " question, answer: 3",
		sequence_number: 5,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "reasoning",
			id: "rs_1",
			status: "completed",
			summary: [{ type: "summary_text", text: "Simple question, answer: 3" }],
			content: [{ type: "reasoning_text", text: "Simple question, answer: 3" }],
		},
		sequence_number: 6,
	} as unknown as ResponseStreamEvent;
	yield { type: "response.completed", sequence_number: 7 } as unknown as ResponseStreamEvent;
}

async function* createTextFirstEvents(): AsyncIterable<ResponseStreamEvent> {
	yield { type: "response.created", sequence_number: 0 } as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: { type: "reasoning", id: "rs_2", status: "in_progress", summary: [] },
		sequence_number: 1,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		item_id: "rs_2",
		output_index: 0,
		content_index: 0,
		delta: "raw reasoning",
		sequence_number: 2,
	} as unknown as ResponseStreamEvent;
	// The other flavor arrives afterwards and must be ignored.
	yield {
		type: "response.reasoning_summary_text.delta",
		item_id: "rs_2",
		output_index: 0,
		summary_index: 0,
		delta: "raw reasoning",
		sequence_number: 3,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_part.done",
		item_id: "rs_2",
		output_index: 0,
		summary_index: 0,
		part: { type: "summary_text", text: "raw reasoning" },
		sequence_number: 4,
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			type: "reasoning",
			id: "rs_2",
			status: "completed",
			summary: [{ type: "summary_text", text: "raw reasoning" }],
		},
		sequence_number: 5,
	} as unknown as ResponseStreamEvent;
	yield { type: "response.completed", sequence_number: 6 } as unknown as ResponseStreamEvent;
}

describe("duplicate reasoning delta flavors", () => {
	it("ignores reasoning_text deltas once summary deltas streamed (summary-first order)", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream: AssistantMessageEvent[] = [];
		await processResponsesStream(
			createSummaryFirstEvents(),
			output,
			{ push: (e: AssistantMessageEvent) => stream.push(e) } as never,
			model,
		);

		const deltas = stream.filter((e) => e.type === "thinking_delta") as Array<{ delta: string }>;
		expect(deltas.map((e) => e.delta)).toEqual(["Simple", " question, answer: 3"]);
		const thinking = output.content.find((b) => b.type === "thinking");
		expect(thinking?.thinking).toBe("Simple question, answer: 3");
	});

	it("ignores summary deltas once reasoning_text deltas streamed (text-first order)", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream: AssistantMessageEvent[] = [];
		await processResponsesStream(
			createTextFirstEvents(),
			output,
			{ push: (e: AssistantMessageEvent) => stream.push(e) } as never,
			model,
		);

		const deltas = stream.filter((e) => e.type === "thinking_delta") as Array<{ delta: string }>;
		// summary_part.done's separator is skipped too, since the slot streams raw text.
		expect(deltas.map((e) => e.delta)).toEqual(["raw reasoning"]);
		const thinking = output.content.find((b) => b.type === "thinking");
		expect(thinking?.thinking).toBe("raw reasoning");
	});

	it("keeps unpaired flavors unchanged (text-only and summary-only slots)", async () => {
		const model = createModel();

		// Text-only slot still accumulates raw text deltas.
		const textOutput = createOutput(model);
		const textEvents: ResponseStreamEvent[] = [
			{ type: "response.created", sequence_number: 0 } as unknown as ResponseStreamEvent,
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_3", status: "in_progress", summary: [] },
				sequence_number: 1,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_text.delta",
				item_id: "rs_3",
				output_index: 0,
				content_index: 0,
				delta: "a",
				sequence_number: 2,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_text.delta",
				item_id: "rs_3",
				output_index: 0,
				content_index: 0,
				delta: "b",
				sequence_number: 3,
			} as unknown as ResponseStreamEvent,
			{ type: "response.completed", sequence_number: 4 } as unknown as ResponseStreamEvent,
		];
		await processResponsesStream(events(textEvents), textOutput, { push: () => {} } as never, model);
		expect(textOutput.content.find((b) => b.type === "thinking")?.thinking).toBe("ab");

		// Summary-only slot still accumulates summary deltas and part separators.
		const summaryOutput = createOutput(model);
		const summaryEvents: ResponseStreamEvent[] = [
			{ type: "response.created", sequence_number: 0 } as unknown as ResponseStreamEvent,
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "reasoning", id: "rs_4", status: "in_progress", summary: [] },
				sequence_number: 1,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_4",
				output_index: 0,
				summary_index: 0,
				delta: "part one",
				sequence_number: 2,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_part.done",
				item_id: "rs_4",
				output_index: 0,
				summary_index: 0,
				part: { type: "summary_text", text: "part one" },
				sequence_number: 3,
			} as unknown as ResponseStreamEvent,
			{
				type: "response.reasoning_summary_text.delta",
				item_id: "rs_4",
				output_index: 0,
				summary_index: 1,
				delta: "part two",
				sequence_number: 4,
			} as unknown as ResponseStreamEvent,
			{ type: "response.completed", sequence_number: 5 } as unknown as ResponseStreamEvent,
		];
		await processResponsesStream(events(summaryEvents), summaryOutput, { push: () => {} } as never, model);
		expect(summaryOutput.content.find((b) => b.type === "thinking")?.thinking).toBe("part one\n\npart two");
	});
});

function events(items: ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
	return (async function* () {
		for (const item of items) yield item;
	})();
}
