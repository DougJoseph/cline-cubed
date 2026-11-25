import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { type AlwaysRememberedFiles, MoveAlwaysRememberedFileRequest } from "@shared/proto/cline/file"
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react"
import { memo, useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FileServiceClient } from "@/services/grpc-client"

const formatCount = (value: number) => value.toLocaleString("en-US")

const AlwaysRememberedFilesSection = () => {
	const [state, setState] = useState<AlwaysRememberedFiles>()
	const [pathInput, setPathInput] = useState("")
	const [message, setMessage] = useState<string>()

	const apply = useCallback(async (request: () => Promise<AlwaysRememberedFiles>) => {
		try {
			const next = await request()
			setState(next)
			setMessage(next.addError)
			return next
		} catch (error) {
			console.error("Failed to update always-remembered files:", error)
			setMessage("The always-remembered list could not be updated.")
			return undefined
		}
	}, [])

	useEffect(() => {
		void apply(() => FileServiceClient.getAlwaysRememberedFiles(EmptyRequest.create({})))
	}, [apply])

	const addTypedPath = async () => {
		const value = pathInput.trim()
		if (!value) {
			return
		}
		const next = await apply(() => FileServiceClient.addAlwaysRememberedFile(StringRequest.create({ value })))
		if (next && !next.addError) {
			setPathInput("")
		}
	}

	const move = (path: string, delta: number) =>
		apply(() => FileServiceClient.moveAlwaysRememberedFile(MoveAlwaysRememberedFileRequest.create({ path, delta })))

	const hasTypedPath = pathInput.trim().length > 0
	const files = state?.files ?? []
	const totalTokens = state?.totalEstimatedTokens ?? 0
	const contextWindow = state?.contextWindow

	return (
		<div className="py-3 space-y-2" id="always-remembered-files">
			<div className="text-sm font-medium text-foreground">Always Remembered Files</div>
			<p className="text-xs text-muted-foreground">
				These files stay in the system prompt for every message on this machine, so compaction can never remove them.
				Changes apply from your next message.
			</p>

			{state && (
				<div className="rounded-xs border border-editor-widget-border/50 px-2 py-2 space-y-2 text-xs text-muted-foreground">
					<div className="font-medium text-foreground">Already remembered automatically. No need to add these:</div>
					{[
						{ title: "This workspace", locations: state.automaticWorkspaceLocations },
						{ title: "All workspaces", locations: state.automaticGlobalLocations },
					].map(
						({ title, locations }) =>
							locations.length > 0 && (
								<div key={title}>
									<div>{title}</div>
									<ul className="m-0 pl-4">
										{locations.map((location) => (
											<li key={location}>
												<code>{location}</code>
											</li>
										))}
									</ul>
								</div>
							),
					)}
					<p className="m-0">
						In these folders, only .md, .markdown, and .txt files directly inside the folder are loaded, not files in
						subfolders.
					</p>
					<p className="m-0">
						Add anything else below, such as a CLAUDE.md or a work contract kept elsewhere. Other tools' files are not
						loaded automatically.
					</p>
				</div>
			)}

			<div className="flex gap-2">
				<div className="relative min-w-0 flex-1">
					<Input
						aria-label="File path to always remember"
						className="pr-14"
						onChange={(event) => {
							setPathInput(event.target.value)
							setMessage(undefined)
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault()
								void addTypedPath()
							}
						}}
						placeholder="~/notes/work-contract.md"
						value={pathInput}
					/>
					{hasTypedPath && (
						<button
							aria-label="Add this path"
							className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer border-0 bg-transparent p-0 text-xs text-muted-foreground opacity-60 hover:opacity-100"
							onClick={() => void addTypedPath()}
							type="button">
							Enter
						</button>
					)}
				</div>
				<Button
					onClick={() =>
						void (hasTypedPath
							? addTypedPath()
							: apply(() => FileServiceClient.pickAlwaysRememberedFile(EmptyRequest.create({}))))
					}
					type="button"
					variant="secondary">
					<Plus />
					Add File
				</Button>
			</div>

			{message && (
				<div className="text-xs text-error" role="alert">
					{message}
				</div>
			)}

			{files.length > 0 && (
				<ul className="m-0 p-0 list-none space-y-1">
					{files.map((file, index) => (
						<li
							className="flex items-center gap-2 rounded-xs border border-editor-widget-border/50 px-2 py-1"
							key={file.path}>
							<div className="min-w-0 flex-1">
								<div className="truncate text-xs text-foreground" title={file.resolvedPath}>
									{file.path}
								</div>
								{file.status === "ok" ? (
									<div className="text-xs text-muted-foreground">
										{file.alreadyLoadedAsRule
											? "Already loaded as a rule"
											: `${formatCount(file.chars)} characters, about ${formatCount(file.estimatedTokens)} tokens`}
									</div>
								) : (
									<div className="text-xs text-error">Failed to load: {file.error}</div>
								)}
							</div>
							<Button
								aria-label={`Move ${file.path} up`}
								disabled={index === 0}
								onClick={() => void move(file.path, -1)}
								size="icon"
								type="button"
								variant="ghost">
								<ArrowUp />
							</Button>
							<Button
								aria-label={`Move ${file.path} down`}
								disabled={index === files.length - 1}
								onClick={() => void move(file.path, 1)}
								size="icon"
								type="button"
								variant="ghost">
								<ArrowDown />
							</Button>
							<Button
								aria-label={`Remove ${file.path}`}
								onClick={() =>
									void apply(() =>
										FileServiceClient.removeAlwaysRememberedFile(StringRequest.create({ value: file.path })),
									)
								}
								size="icon"
								type="button"
								variant="ghost">
								<X />
							</Button>
						</li>
					))}
				</ul>
			)}

			{files.length > 0 && (
				<p className="text-xs text-muted-foreground">
					Total: about {formatCount(totalTokens)} tokens
					{contextWindow
						? `, ${((totalTokens / contextWindow) * 100).toFixed(1)}% of the ${formatCount(contextWindow)}-token context window`
						: ""}
					, on every request.
				</p>
			)}

			{files.length > 0 && state?.reachesCompactionTrigger && (
				<p className="text-xs text-error">
					These files alone reach the compaction trigger, so no compaction can make a conversation fit. Remove or
					shorten a file.
				</p>
			)}

			{files.length > 0 && state && !state.endpointIsLocal && (
				<p className="text-xs text-warning">
					The active model is not local, so these files are being sent to a remote model endpoint on every request.
				</p>
			)}
		</div>
	)
}

export default memo(AlwaysRememberedFilesSection)
