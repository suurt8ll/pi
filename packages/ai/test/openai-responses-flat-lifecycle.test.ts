import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
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

// Some providers (e.g. Venice.ai's alpha /responses endpoint) send lifecycle
// events with the response object at the top level instead of nested under
// "response". The stream parser must tolerate both shapes.

async function* createFlatLifecycleEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		sequence_number: 0,
		id: "resp_flat",
		object: "response",
		status: "in_progress",
		output: [],
	} as unknown as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 1,
		id: "resp_flat",
		object: "response",
		status: "completed",
		output: [],
		usage: {
			input_tokens: 20,
			output_tokens: 7,
			total_tokens: 27,
			input_tokens_details: { cached_tokens: 2 },
		},
	} as unknown as ResponseStreamEvent;
}

async function* createFlatFailedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.failed",
		sequence_number: 0,
		id: "resp_flat_failed",
		object: "response",
		status: "failed",
		error: { code: "server_error", message: "boom" },
	} as unknown as ResponseStreamEvent;
}

describe("OpenAI Responses flat lifecycle events", () => {
	it("tolerates response objects at the top level of lifecycle events", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createFlatLifecycleEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_flat");
		expect(output.stopReason).toBe("stop");
		expect(output.usage.input).toBe(18); // 20 - 2 cached
		expect(output.usage.output).toBe(7);
		expect(output.usage.cacheRead).toBe(2);
	});

	it("tolerates failed events without a nested response object", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createFlatFailedEvents(), output, stream, model)).rejects.toThrow(
			"server_error: boom",
		);
	});
});
