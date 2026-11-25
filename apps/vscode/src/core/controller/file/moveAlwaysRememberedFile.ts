import type { AlwaysRememberedFiles, MoveAlwaysRememberedFileRequest } from "@shared/proto/cline/file"
import { moveAlwaysRememberedFile as moveFile } from "@/sdk/always-remembered-files-service"
import type { Controller } from ".."

/** Moves a path up or down the always-remembered list. */
export async function moveAlwaysRememberedFile(
	_controller: Controller,
	request: MoveAlwaysRememberedFileRequest,
): Promise<AlwaysRememberedFiles> {
	return moveFile(request.path, request.delta)
}
