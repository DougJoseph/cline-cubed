import type { ModelProfilesResponse, RenameModelProfileRequest } from "@/shared/proto/cline/models"
import { type ModelProfilesController, parseProfileMode, renameModelProfile as rename } from "../../profiles/modelProfiles"
import { profileAction, toModelProfilesResponse } from "./modelProfilesShared"

export async function renameModelProfile(
	controller: ModelProfilesController,
	request: RenameModelProfileRequest,
): Promise<ModelProfilesResponse> {
	return profileAction("rename the profile", async () => {
		const { view, nameExists } = await rename(controller, request.oldName, request.newName, parseProfileMode(request.mode))
		return toModelProfilesResponse(view, nameExists)
	})
}
