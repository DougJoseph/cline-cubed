import {
	ModelProfileNameRequest,
	ModelProfilesRequest,
	type ModelProfilesResponse,
	RenameModelProfileRequest,
	SaveModelProfileRequest,
} from "@shared/proto/cline/models"
import { useCallback, useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

export type ProfileMode = "plan" | "act"

export interface ModelProfilesState {
	names: string[]
	activeName: string
	activeEdited: boolean
	error: string
}

const EMPTY: ModelProfilesState = { names: [], activeName: "", activeEdited: false, error: "" }

function toState(response: ModelProfilesResponse): ModelProfilesState {
	return {
		names: response.profiles.map((profile) => profile.name),
		activeName: response.activeName,
		activeEdited: response.activeEdited,
		error: response.error,
	}
}

/**
 * Cline Cubed: the saved model profiles for a mode, and the actions on them. Re-read whenever the
 * extension pushes a new configuration, so "(edited)" follows a change made by hand in Settings.
 */
export function useModelProfiles(mode: ProfileMode) {
	const { apiConfiguration, planActSeparateModelsSetting } = useExtensionState()
	const [state, setState] = useState<ModelProfilesState>(EMPTY)

	const take = useCallback((response: ModelProfilesResponse) => {
		// A failed action keeps the list it had, and shows the error.
		if (response.error) {
			setState((previous) => ({ ...previous, error: response.error }))
		} else {
			setState(toState(response))
		}
		return response
	}, [])

	const refresh = useCallback(async () => {
		try {
			take(await ModelsServiceClient.listModelProfiles(ModelProfilesRequest.create({ mode })))
		} catch (error) {
			console.error("Failed to read model profiles:", error)
		}
	}, [mode, take])

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read on every pushed configuration
	useEffect(() => {
		void refresh()
	}, [refresh, apiConfiguration, planActSeparateModelsSetting])

	const save = useCallback(
		async (name: string, replace: boolean) =>
			take(await ModelsServiceClient.saveModelProfile(SaveModelProfileRequest.create({ name, mode, replace }))),
		[mode, take],
	)
	const apply = useCallback(
		async (name: string) => take(await ModelsServiceClient.applyModelProfile(ModelProfileNameRequest.create({ name, mode }))),
		[mode, take],
	)
	const rename = useCallback(
		async (oldName: string, newName: string) =>
			take(await ModelsServiceClient.renameModelProfile(RenameModelProfileRequest.create({ oldName, newName, mode }))),
		[mode, take],
	)
	const remove = useCallback(
		async (name: string) =>
			take(await ModelsServiceClient.deleteModelProfile(ModelProfileNameRequest.create({ name, mode }))),
		[mode, take],
	)

	/** A rename for the profile list: resolves to the error to show, or "" when done. */
	const renameInList = useCallback(
		async (oldName: string, newName: string) => {
			const response = await rename(oldName, newName)
			return response.nameExists ? `A profile named ${newName} is already saved.` : response.error
		},
		[rename],
	)

	return { ...state, refresh, save, apply, rename, renameInList, remove }
}
