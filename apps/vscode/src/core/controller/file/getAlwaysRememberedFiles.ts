import type { EmptyRequest } from "@shared/proto/cline/common"
import type { AlwaysRememberedFiles } from "@shared/proto/cline/file"
import { getAlwaysRememberedFilesState } from "@/sdk/always-remembered-files-service"
import type { Controller } from ".."

/** Returns the always-remembered file list with each file's status and size. */
export async function getAlwaysRememberedFiles(_controller: Controller, _request: EmptyRequest): Promise<AlwaysRememberedFiles> {
	return getAlwaysRememberedFilesState()
}
