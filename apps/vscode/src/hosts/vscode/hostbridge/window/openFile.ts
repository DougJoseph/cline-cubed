import * as vscode from "vscode"
import { filesViewColumn } from "@/hosts/vscode/editorGroups"
import { OpenFileRequest, OpenFileResponse } from "@/shared/proto/host/window"

export async function openFile(request: OpenFileRequest): Promise<OpenFileResponse> {
	// Cline Cubed: a different command from showTextDocument, so it needs the same aim — the
	// FILES group rather than whichever group happens to be active. Plan:
	// Docs/2026-08-30_10.33pm_two-named-editor-groups-chats-and-files.md
	await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(request.filePath), {
		viewColumn: filesViewColumn(),
	})
	return OpenFileResponse.create({})
}
