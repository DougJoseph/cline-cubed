import type { ModelProfilesResponse, SaveModelProfileRequest } from "@/shared/proto/cline/models"
import { type ModelProfilesController, parseProfileMode, saveModelProfile as save } from "../../profiles/modelProfiles"
import { profileAction, toModelProfilesResponse } from "./modelProfilesShared"

export async function saveModelProfile(
	controller: ModelProfilesController,
	request: SaveModelProfileRequest,
): Promise<ModelProfilesResponse> {
	return profileAction("save the profile", async () => {
		const { view, nameExists } = await save(controller, request.name, parseProfileMode(request.mode), request.replace)
		return toModelProfilesResponse(view, nameExists)
	})
}
