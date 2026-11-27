import * as vscode from "vscode"
import { RevealFileInOsRequest, RevealFileInOsResponse } from "@/shared/proto/host/window"

/** Cline Cubed: shows the file in the operating system's file manager, selected. */
export async function revealFileInOs(request: RevealFileInOsRequest): Promise<RevealFileInOsResponse> {
	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(request.filePath))
	return RevealFileInOsResponse.create({})
}
