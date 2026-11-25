import { readStoredModeModelId } from "@/sdk/model-catalog/stored-mode-model"
import type { ApiConfiguration } from "@/shared/api"
import type { Mode } from "@/shared/storage/types"

type TaskApiModel = {
	getModel: () => { id: string }
}

export function resolveActiveModelIdFromApiConfiguration(config: ApiConfiguration, mode: Mode): string {
	const provider =
		mode === "plan" ? config.planModeApiProvider : mode === "image" ? config.imageModeApiProvider : config.actModeApiProvider
	if (provider) {
		return readStoredModeModelId(config, provider, mode) ?? "unknown"
	}
	const genericModelKey =
		mode === "plan" ? "planModeApiModelId" : mode === "image" ? "imageModeApiModelId" : "actModeApiModelId"
	return config[genericModelKey]?.trim() || "unknown"
}

export function createTaskApiModelShim(modelId: string): TaskApiModel {
	return {
		getModel: () => ({ id: modelId }),
	}
}
