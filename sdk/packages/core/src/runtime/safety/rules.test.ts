import { describe, expect, it } from "vitest";
import type { UserInstructionConfigWatcher } from "../../extensions/config/user-instruction-config-loader";
import {
	listEnabledRulesFromWatcher,
	mergeRulesForSystemPrompt,
} from "./rules";

describe("mergeRulesForSystemPrompt", () => {
	it("returns additional rules when watcher rules are absent", () => {
		expect(mergeRulesForSystemPrompt(undefined, "inline rules")).toBe(
			"inline rules",
		);
	});

	it("returns watcher rules when inline rules are absent", () => {
		expect(mergeRulesForSystemPrompt("watcher rules", undefined)).toBe(
			"watcher rules",
		);
	});

	it("appends inline rules after watcher rules", () => {
		expect(mergeRulesForSystemPrompt("watcher rules", "inline rules")).toBe(
			"watcher rules\n\ninline rules",
		);
	});
});

// Cline Cubed: a rule switched off outside its own file (the VS Code Rules panel) is left out.
describe("listEnabledRulesFromWatcher with a switch check", () => {
	const record = (filePath: string, name: string) => ({
		type: "rule",
		id: name,
		filePath,
		item: { name, instructions: `${name} text`, frontmatter: {} },
	});
	const watcher = {
		getSnapshot: () =>
			new Map([
				["off", record("/rules/off.md", "off")],
				["on", record("/rules/on.md", "on")],
			]),
	} as unknown as UserInstructionConfigWatcher;

	it("leaves out a rule the check reports as off and keeps the rest", () => {
		const rules = listEnabledRulesFromWatcher(
			watcher,
			(kind, filePath) => !(kind === "rule" && filePath === "/rules/off.md"),
		);
		expect(rules.map((rule) => rule.name)).toEqual(["on"]);
	});

	it("keeps every rule when no check is given", () => {
		expect(
			listEnabledRulesFromWatcher(watcher).map((rule) => rule.name),
		).toEqual(["off", "on"]);
	});
});
