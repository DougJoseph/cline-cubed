import type { StringRequest } from "@shared/proto/cline/common"
import type { AlwaysRememberedFiles } from "@shared/proto/cline/file"
import { addAlwaysRememberedFile as addFile } from "@/sdk/always-remembered-files-service"
import type { Controller } from ".."

/** Adds a typed or pasted path to the always-remembered list. */
export async function addAlwaysRememberedFile(_controller: Controller, request: StringRequest): Promise<AlwaysRememberedFiles> {
	return addFile(request.value)
}
