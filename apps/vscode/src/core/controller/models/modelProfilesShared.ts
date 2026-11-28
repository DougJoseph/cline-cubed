import { ModelProfileSummary, ModelProfilesResponse } from "@/shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import type { ModelProfilesView } from "../../profiles/modelProfiles"

/** Cline Cubed: a model-profiles result as the webview receives it. */
export function toModelProfilesResponse(view: ModelProfilesView, nameExists = false): ModelProfilesResponse {
	return ModelProfilesResponse.create({
		profiles: view.profiles.map((profile) =>
			ModelProfileSummary.create({ name: profile.name, providerId: profile.providerId, modelId: profile.modelId }),
		),
		activeName: view.activeName,
		activeEdited: view.activeEdited,
		nameExists,
	})
}

/** Runs a profile action; a failure is logged and returned as the response's error. */
export async function profileAction(what: string, run: () => Promise<ModelProfilesResponse>): Promise<ModelProfilesResponse> {
	try {
		return await run()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`Model profiles: could not ${what}: ${message}`)
		return ModelProfilesResponse.create({ error: message })
	}
}
