import type { StringRequest } from "@shared/proto/cline/common"
import type { AlwaysRememberedFiles } from "@shared/proto/cline/file"
import { removeAlwaysRememberedFile as removeFile } from "@/sdk/always-remembered-files-service"
import type { Controller } from ".."

/** Removes a path from the always-remembered list without touching the file. */
export async function removeAlwaysRememberedFile(
	_controller: Controller,
	request: StringRequest,
): Promise<AlwaysRememberedFiles> {
	return removeFile(request.value)
}
