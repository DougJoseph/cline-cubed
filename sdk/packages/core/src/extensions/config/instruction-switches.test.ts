import { describe, expect, it } from "vitest";
import type { UserInstructionConfigWatcher } from "./user-instruction-config-loader";
import {
	createUserInstructionPlugin,
	createUserInstructionSkillsExecutor,
	getConfiguredSkillsFromWatcher,
} from "./user-instruction-plugin";

/**
 * Cline Cubed: rules and skills switched off outside their own files (the VS Code Rules panel)
 * are left out of what reaches the model.
 */

const isOn = (kind: "rule" | "skill", filePath: string) =>
	!(
		(kind === "rule" && filePath === "/rules/off.md") ||
		(kind === "skill" && filePath === "/skills/off-skill/SKILL.md")
	);

function fakeWatcher(): UserInstructionConfigWatcher {
	const rules = new Map([
		[
			"off",
			{
				type: "rule",
				id: "off",
				filePath: "/rules/off.md",
				item: { name: "off", instructions: "OFF-RULE-TEXT", frontmatter: {} },
			},
		],
		[
			"on",
			{
				type: "rule",
				id: "on",
				filePath: "/rules/on.md",
				item: { name: "on", instructions: "ON-RULE-TEXT", frontmatter: {} },
			},
		],
	]);
	const skills = new Map([
		[
			"off-skill",
			{
				type: "skill",
				id: "off-skill",
				filePath: "/skills/off-skill/SKILL.md",
				item: { name: "off-skill", instructions: "x", frontmatter: {} },
			},
		],
		[
			"on-skill",
			{
				type: "skill",
				id: "on-skill",
				filePath: "/skills/on-skill/SKILL.md",
				item: { name: "on-skill", instructions: "y", frontmatter: {} },
			},
		],
	]);
	return {
		getSnapshot: (kind: string) =>
			kind === "rule" ? rules : kind === "skill" ? skills : new Map(),
	} as unknown as UserInstructionConfigWatcher;
}

describe("instruction switches", () => {
	it("marks a switched-off skill disabled", () => {
		const skills = getConfiguredSkillsFromWatcher(
			fakeWatcher(),
			undefined,
			isOn,
		);
		const off = skills.find((entry) => entry.id === "off-skill");
		expect(off?.disabled).toBe(true);
		expect(off?.skill.disabled).toBe(true);
		expect(skills.find((entry) => entry.id === "on-skill")?.disabled).toBe(
			false,
		);
	});

	it("leaves a switched-off skill out of the skills tool's list and refuses to run it", async () => {
		const executor = createUserInstructionSkillsExecutor(
			fakeWatcher(),
			Promise.resolve(),
			undefined,
			isOn,
		);
		expect(
			executor.configuredSkills
				?.filter((skill) => !skill.disabled)
				.map((skill) => skill.name),
		).toEqual(["on-skill"]);
		expect(await executor("off-skill", undefined, {} as never)).toContain(
			"disabled",
		);
	});

	it("leaves a switched-off rule out of the system prompt rules", async () => {
		const plugin = createUserInstructionPlugin({
			watcher: fakeWatcher(),
			includeRules: true,
			isInstructionEnabled: isOn,
		});
		const registered: Array<{ content: () => string }> = [];
		await plugin.setup?.(
			{
				registerRule: (rule: { content: () => string }) =>
					registered.push(rule),
				registerTool: () => undefined,
				registerCommand: () => undefined,
			} as never,
			{} as never,
		);
		const text = registered.map((rule) => rule.content()).join("\n");
		expect(text).toContain("ON-RULE-TEXT");
		expect(text).not.toContain("OFF-RULE-TEXT");
	});

	it("keeps every rule and skill when no check is given", () => {
		const skills = getConfiguredSkillsFromWatcher(fakeWatcher());
		expect(skills.every((entry) => !entry.disabled)).toBe(true);
	});
});
