import type { ModelProfileNameRequest, ModelProfilesResponse } from "@/shared/proto/cline/models"
import { type ModelProfilesController, parseProfileMode, deleteModelProfile as remove } from "../../profiles/modelProfiles"
import { profileAction, toModelProfilesResponse } from "./modelProfilesShared"

export async function deleteModelProfile(
	controller: ModelProfilesController,
	request: ModelProfileNameRequest,
): Promise<ModelProfilesResponse> {
	return profileAction("delete the profile", async () =>
		toModelProfilesResponse(await remove(controller, request.name, parseProfileMode(request.mode))),
	)
}
