import type { ModelProfilesRequest, ModelProfilesResponse } from "@/shared/proto/cline/models"
import { listModelProfiles as list, type ModelProfilesController, parseProfileMode } from "../../profiles/modelProfiles"
import { profileAction, toModelProfilesResponse } from "./modelProfilesShared"

export async function listModelProfiles(
	controller: ModelProfilesController,
	request: ModelProfilesRequest,
): Promise<ModelProfilesResponse> {
	return profileAction("list the profiles", async () =>
		toModelProfilesResponse(list(controller, parseProfileMode(request.mode))),
	)
}
