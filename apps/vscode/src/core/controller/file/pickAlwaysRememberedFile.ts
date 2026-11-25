import type { EmptyRequest } from "@shared/proto/cline/common"
import type { AlwaysRememberedFiles } from "@shared/proto/cline/file"
import { pickAlwaysRememberedFile as pickFile } from "@/sdk/always-remembered-files-service"
import type { Controller } from ".."

/** Opens the file picker and adds the chosen file to the always-remembered list. */
export async function pickAlwaysRememberedFile(_controller: Controller, _request: EmptyRequest): Promise<AlwaysRememberedFiles> {
	return pickFile()
}
