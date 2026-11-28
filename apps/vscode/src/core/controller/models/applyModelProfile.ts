import type { ModelProfileNameRequest, ModelProfilesResponse } from "@/shared/proto/cline/models"
import { applyModelProfile as apply, type ModelProfilesController, parseProfileMode } from "../../profiles/modelProfiles"
import { profileAction, toModelProfilesResponse } from "./modelProfilesShared"

export async function applyModelProfile(
	controller: ModelProfilesController,
	request: ModelProfileNameRequest,
): Promise<ModelProfilesResponse> {
	return profileAction("switch to the profile", async () =>
		toModelProfilesResponse(await apply(controller, request.name, parseProfileMode(request.mode))),
	)
}
