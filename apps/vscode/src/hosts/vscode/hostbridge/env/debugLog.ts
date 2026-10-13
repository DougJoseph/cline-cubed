import { Empty, StringRequest } from "@shared/proto/cline/common"
import * as vscode from "vscode"

// Cline Cubed: the channel is named for the fork. Settings → General → Debug logging, the README,
// and the in-chat bridge panel all send people to "Cline Cubed" in View → Output, so creating the
// channel as "Cline" left them looking for a channel that did not exist.
const CLINE_OUTPUT_CHANNEL = vscode.window.createOutputChannel("Cline Cubed")

// Appends a log message to the Cline Cubed output channel.
export async function debugLog(request: StringRequest): Promise<Empty> {
	CLINE_OUTPUT_CHANNEL.appendLine(request.value)
	return Empty.create({})
}

// Register the Cline Cubed output channel within the VSCode extension context.
export function registerClineOutputChannel(context: vscode.ExtensionContext): vscode.OutputChannel {
	context.subscriptions.push(CLINE_OUTPUT_CHANNEL)
	return CLINE_OUTPUT_CHANNEL
}
