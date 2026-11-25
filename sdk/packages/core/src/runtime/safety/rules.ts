import type {
	RuleConfig,
	UserInstructionConfigWatcher,
} from "../../extensions/config/user-instruction-config-loader";

export function isRuleEnabled(rule: RuleConfig): boolean {
	return rule.disabled !== true;
}

export function formatRulesForSystemPrompt(
	rules: ReadonlyArray<RuleConfig>,
): string {
	if (rules.length === 0) {
		return "";
	}

	const renderedRules = rules
		.map((rule) => `## ${rule.name}\n${rule.instructions}`)
		.join("\n\n");
	return `\n\n# Rules\n${renderedRules}`;
}

export function mergeRulesForSystemPrompt(
	primaryRules?: string,
	additionalRules?: string,
): string | undefined {
	const primary = primaryRules?.trim();
	const additional = additionalRules?.trim();
	if (primary && additional) {
		return `${primary}\n\n${additional}`;
	}
	return primary || additional || undefined;
}

/**
 * Cline Cubed: reports whether an instruction file is switched on outside its own frontmatter,
 * such as in the VS Code Rules panel. Absent: every file counts as on.
 */
export type InstructionEnabledCheck = (
	kind: "rule" | "skill",
	filePath: string,
) => boolean;

export function listEnabledRulesFromWatcher(
	watcher: UserInstructionConfigWatcher,
	isInstructionEnabled?: InstructionEnabledCheck,
): RuleConfig[] {
	const snapshot = watcher.getSnapshot("rule");
	return [...snapshot.values()]
		.filter(
			(record) =>
				!isInstructionEnabled || isInstructionEnabled("rule", record.filePath),
		)
		.map((record) => record.item as RuleConfig)
		.filter(isRuleEnabled)
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadRulesForSystemPromptFromWatcher(
	watcher: UserInstructionConfigWatcher,
	isInstructionEnabled?: InstructionEnabledCheck,
): string {
	return formatRulesForSystemPrompt(
		listEnabledRulesFromWatcher(watcher, isInstructionEnabled),
	);
}
