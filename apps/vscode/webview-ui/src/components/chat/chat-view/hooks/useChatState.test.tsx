import type { ClineMessage } from "@shared/ExtensionMessage"
import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { useChatState } from "./useChatState"

function say(ts: number, sayType: ClineMessage["say"], text = ""): ClineMessage {
	return { ts, type: "say", say: sayType, text, partial: false }
}

describe("useChatState task selection", () => {
	it("selects the say:'task' row as the task, wherever it sits", () => {
		// A transcript's first row is not always the task: every turn opens with an
		// api_req_started bookkeeping row (a JSON blob as text), and a snapshot merge can land
		// one at index 0. The task must be selected by kind, or the blob renders as the chat's
		// name.
		const messages: ClineMessage[] = [
			say(1, "api_req_started", "{}"),
			say(2, "text", "a reply"),
			say(1788048860240, "task", "WATCHME say nothing"),
		]
		const { result } = renderHook(() => useChatState(messages))
		expect(result.current.task?.say).toBe("task")
		expect(result.current.task?.text).toBe("WATCHME say nothing")
	})

	it("keeps the task when it is first, the ordinary case", () => {
		const messages: ClineMessage[] = [say(100, "task", "hello"), say(101, "api_req_started", "{}")]
		const { result } = renderHook(() => useChatState(messages))
		expect(result.current.task?.text).toBe("hello")
	})

	it("falls back to the first row when no say:'task' row exists at all", () => {
		// A translator-built snapshot can hold rows with no task row. The selection must stay
		// TOTAL: `task` gates the whole surface (falsy renders the Welcome home and unmounts the
		// message list), so a mid-conversation chat must never lose its task to a kind filter.
		const messages: ClineMessage[] = [say(1, "api_req_started", "{}"), say(2, "text", "a reply")]
		const { result } = renderHook(() => useChatState(messages))
		expect(result.current.task).toBe(messages[0])
	})

	it("reports no task for a chat still on its home", () => {
		const { result } = renderHook(() => useChatState([]))
		expect(result.current.task).toBeUndefined()
	})
})
